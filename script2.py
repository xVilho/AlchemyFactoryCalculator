import sys
with open('js/alchemy_planner.js', 'r', encoding='utf-8') as f:
    text = f.read()

old_html = '''function propagatePlannerMachineRatio(sourceNodeId, ratio) {
    const connected = getPlannerConnectedNodeIds(sourceNodeId).filter(id => id !== sourceNodeId);
    if (connected.length === 0) return;

    connected.forEach(id => {
        const n = plannerState.nodes[id];
        if (n) n.machineCount = Math.max(0, n.machineCount * ratio);
    });

    recomputeAndRefreshPlanner();
    savePlannerState();
    flashPlannerLinkFeedback(sourceNodeId, connected);
}'''

new_html = '''function propagatePlannerMachineRatio(sourceNodeId, ratio) {
    let connected = [];
    if (_plannerLinkMode === 'all') {
        connected = [...getPlannerConnectedNodeIds(sourceNodeId)].filter(id => id !== sourceNodeId);
    } else if (_plannerLinkMode === 'upstream') {
        connected = [...getPlannerUpstreamNodeIds(sourceNodeId)].filter(id => id !== sourceNodeId);
    } else if (_plannerLinkMode === 'downstream') {
        connected = [...getPlannerDownstreamNodeIds(sourceNodeId)].filter(id => id !== sourceNodeId);
    }
    
    if (connected.length === 0) return;

    connected.forEach(id => {
        const n = plannerState.nodes[id];
        if (n) n.machineCount = Math.max(0, n.machineCount * ratio);
    });

    recomputeAndRefreshPlanner();
    savePlannerState();
    flashPlannerLinkFeedback(sourceNodeId, connected);
}'''

text = text.replace(old_html, new_html)

with open('js/alchemy_planner.js', 'w', encoding='utf-8') as f:
    f.write(text)
