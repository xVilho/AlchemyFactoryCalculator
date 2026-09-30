import sys
import re

with open('js/alchemy_planner_overlays.js', 'r', encoding='utf-8') as f:
    text = f.read()

# We will replace the entire function _calculateNodeDemand
# The function ends before unction plannerAutoBalanceUpstream(nodeId)

new_func = '''function _calculateNodeDemand(targetId) {
    const upstreamIds = [...getPlannerUpstreamNodeIds(targetId)];
    const nodeDemand = {}; // nodeId -> item -> demand
    upstreamIds.forEach(id => nodeDemand[id] = {});

    // 1. ADD DEMAND FROM EXTERNAL CONSUMERS
    // If a node in upstreamIds supplies a node NOT in upstreamIds, we must include that external demand!
    Object.values(plannerState.edges).forEach(e => {
        if (upstreamIds.includes(e.fromNode) && !upstreamIds.includes(e.toNode)) {
            const externalNode = plannerState.nodes[e.toNode];
            const rates = plannerGetNodeRates(externalNode);
            if (rates) {
                const p = rates.inputsPerMachine.find(p => p.item === e.item);
                if (p) {
                    const numSuppliers = Object.values(plannerState.edges).filter(edge => edge.toNode === e.toNode && edge.item === e.item).length;
                    const demand = (p.rate * externalNode.machineCount) / (numSuppliers || 1);
                    nodeDemand[e.fromNode][e.item] = (nodeDemand[e.fromNode][e.item] || 0) + demand;
                }
            }
        }
    });

    // 2. Compute reverse graph edges for topological sort
    const consumersOf = {};
    upstreamIds.forEach(id => consumersOf[id] = []);
    Object.values(plannerState.edges).forEach(e => {
        if (upstreamIds.includes(e.fromNode) && upstreamIds.includes(e.toNode)) {
            consumersOf[e.fromNode].push({ toNode: e.toNode, item: e.item });
        }
    });

    // Kahn's algorithm for topological sort (reverse)
    const inDegree = {};
    upstreamIds.forEach(id => inDegree[id] = 0);
    upstreamIds.forEach(id => {
        consumersOf[id].forEach(c => inDegree[id]++);
    });

    const queue = [];
    upstreamIds.forEach(id => { if (inDegree[id] === 0) queue.push(id); });

    // Ensure targetId is the root consumer
    const targetNode = plannerState.nodes[targetId];
    if (targetNode) {
        const rates = plannerGetNodeRates(targetNode);
        if (rates) {
            rates.inputsPerMachine.forEach(p => {
                nodeDemand[targetId][p.item] = (nodeDemand[targetId][p.item] || 0) + (p.rate * targetNode.machineCount);
            });
        }
    }

    const processed = new Set();
    while (queue.length > 0) {
        const curr = queue.shift();
        processed.add(curr);

        if (curr !== targetId) {
            // Satisfy demand
            const currNode = plannerState.nodes[curr];
            const rates = plannerGetNodeRates(currNode);
            if (rates) {
                let requiredCount = 0;
                rates.outputsPerMachine.forEach(p => {
                    const demand = nodeDemand[curr][p.item] || 0;
                    if (p.rate > 0) requiredCount = Math.max(requiredCount, demand / p.rate);
                });
                
                currNode.machineCount = requiredCount;

                // Propagate upstream
                rates.inputsPerMachine.forEach(p => {
                    nodeDemand[curr][p.item] = (nodeDemand[curr][p.item] || 0) + (p.rate * requiredCount);
                });
            }
        }

        // Pass demand upstream
        Object.values(plannerState.edges).forEach(e => {
            if (e.toNode === curr && upstreamIds.includes(e.fromNode)) {
                // Divide demand among all internal suppliers
                const numSuppliers = Object.values(plannerState.edges).filter(edge => edge.toNode === curr && edge.item === e.item && upstreamIds.includes(edge.fromNode)).length;
                const demandToPass = (nodeDemand[curr][e.item] || 0) / (numSuppliers || 1);
                
                nodeDemand[e.fromNode][e.item] = (nodeDemand[e.fromNode][e.item] || 0) + demandToPass;
                
                inDegree[e.fromNode]--;
                if (inDegree[e.fromNode] === 0) queue.push(e.fromNode);
            }
        });
    }
}
'''

# Use regex to replace the old function block
# We find function _calculateNodeDemand(targetId) { ... } up to function plannerAutoBalanceUpstream
pattern = r'function _calculateNodeDemand\(targetId\) \{[\s\S]*?(?=function plannerAutoBalanceUpstream)'

if re.search(pattern, text):
    text = re.sub(pattern, new_func, text)
    with open('js/alchemy_planner_overlays.js', 'w', encoding='utf-8') as f:
        f.write(text)
    print("Replaced!")
else:
    print("Not found!")

