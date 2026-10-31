import sys
import re
with open('js/alchemy_planner.js', 'r', encoding='utf-8') as f:
    text = f.read()

old_logic = '''    // If one of them is 'Any' (Waypoint), update it to the real item
    if (targetItem === 'Any' || item === 'Any') {
        const realItem = targetItem === 'Any' ? item : targetItem;
        const anyNodeId = targetItem === 'Any' ? targetNodeId : sourceNodeId;
        const anyNode = plannerState.nodes[anyNodeId];
        if (anyNode && anyNode.kind === 'waypoint') {
            anyNode.portalItem = realItem;
            // Also need to re-render to update the ports
            setTimeout(() => renderPlanner(), 0);
        }
    }'''

new_logic = '''    // If one of them is 'Any' (Waypoint), update it to the real item
    let finalItem = item;
    if (targetItem === 'Any' || item === 'Any') {
        const realItem = targetItem === 'Any' ? item : targetItem;
        if (realItem !== 'Any') finalItem = realItem;
        const anyNodeId = targetItem === 'Any' ? targetNodeId : sourceNodeId;
        const anyNode = plannerState.nodes[anyNodeId];
        if (anyNode && anyNode.kind === 'waypoint') {
            anyNode.portalItem = realItem;
            // Also need to re-render to update the ports
            setTimeout(() => renderPlanner(), 0);
        }
    }'''

text = text.replace(old_logic, new_logic)

old_dup = '''    const dup = Object.values(plannerState.edges).some(e =>
        e.fromNode === fromNode && e.toNode === toNode && e.item === item);
    if (dup) { console.log(t('These two ports are already connected.', 'ui')); return; }

    plannerState._edgeSeq = (plannerState._edgeSeq || 0) + 1;
    const edgeId = 'pedge_' + plannerState._edgeSeq;
    plannerState.edges[edgeId] = { id: edgeId, item, fromNode, toNode, createdAt: plannerState._edgeSeq };'''

new_dup = '''    const dup = Object.values(plannerState.edges).some(e =>
        e.fromNode === fromNode && e.toNode === toNode && e.item === finalItem);
    if (dup) { console.log(t('These two ports are already connected.', 'ui')); return; }

    plannerState._edgeSeq = (plannerState._edgeSeq || 0) + 1;
    const edgeId = 'pedge_' + plannerState._edgeSeq;
    plannerState.edges[edgeId] = { id: edgeId, item: finalItem, fromNode, toNode, createdAt: plannerState._edgeSeq };'''

text = text.replace(old_dup, new_dup)

with open('js/alchemy_planner.js', 'w', encoding='utf-8') as f:
    f.write(text)
print("Updated tryCreatePlannerEdgeFromDots")
