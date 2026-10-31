import sys
import re

with open('js/alchemy_planner.js', 'r', encoding='utf-8') as f:
    text = f.read()

# 1. onPlannerAddWaypointClick: Create blank waypoint instead of opening item picker
old_waypoint_click = '''function onPlannerAddWaypointClick() {
    const center = _plannerSettings.viewport;
    const g = plannerScreenToGraph(window.innerWidth / 2, window.innerHeight / 2);
    openPlannerItemPicker(g.x, g.y, 'waypoint');
}'''
new_waypoint_click = '''function onPlannerAddWaypointClick() {
    const g = plannerScreenToGraph(window.innerWidth / 2, window.innerHeight / 2);
    plannerState._nodeSeq = (plannerState._nodeSeq || 0) + 1;
    const newNodeId = 'pnode_' + plannerState._nodeSeq;
    plannerState.nodes[newNodeId] = {
        id: newNodeId, kind: 'waypoint', portalItem: 'Any', machineCount: 1,
        x: Math.round(g.x), y: Math.round(g.y)
    };
    savePlannerState();
    requestPlannerRender();
}'''
if old_waypoint_click in text: text = text.replace(old_waypoint_click, new_waypoint_click)

# 2. plannerGetPortalRates: handle 'Any'
old_portal_rates = '''function plannerGetPortalRates(node) {
    const result = { recipe: null, inputsPerMachine: [], outputsPerMachine: [], heatItemsPerMachine: 0, fertItemsPerMachine: 0, errorCode: '' };
    const item = node.portalItem;
    if (!item || !DB.items[item]) return { ...result, errorCode: 'No Item Selected' };
    return { ...result, inputsPerMachine: [{ item, rate: 1 }], outputsPerMachine: [{ item, rate: 1 }] };
}'''
new_portal_rates = '''function plannerGetPortalRates(node) {
    const result = { recipe: null, inputsPerMachine: [], outputsPerMachine: [], heatItemsPerMachine: 0, fertItemsPerMachine: 0, errorCode: '' };
    const item = node.portalItem;
    if (item === 'Any') return { ...result, inputsPerMachine: [{ item: 'Any', rate: 1 }], outputsPerMachine: [{ item: 'Any', rate: 1 }] };
    if (!item || !DB.items[item]) return { ...result, errorCode: 'No Item Selected' };
    return { ...result, inputsPerMachine: [{ item, rate: 1 }], outputsPerMachine: [{ item, rate: 1 }] };
}'''
if old_portal_rates in text: text = text.replace(old_portal_rates, new_portal_rates)

# 3. tryCreatePlannerEdgeFromDots: allow connecting to 'Any' and adopt the item
old_edge = '''    if (targetItem !== item) { console.log(t('Ports must be the same item to connect.', 'ui')); return; }
    if (targetDir === sourceDir) { console.log(t('Cannot connect two ports of the same direction.', 'ui')); return; }'''
new_edge = '''    if (targetItem !== item && targetItem !== 'Any' && item !== 'Any') { console.log(t('Ports must be the same item to connect.', 'ui')); return; }
    if (targetDir === sourceDir) { console.log(t('Cannot connect two ports of the same direction.', 'ui')); return; }

    // If one of them is 'Any' (Waypoint), update it to the real item
    if (targetItem === 'Any' || item === 'Any') {
        const realItem = targetItem === 'Any' ? item : targetItem;
        const anyNodeId = targetItem === 'Any' ? targetNodeId : sourceNodeId;
        const anyNode = plannerState.nodes[anyNodeId];
        if (anyNode && anyNode.kind === 'waypoint') {
            anyNode.portalItem = realItem;
            // Also need to re-render to update the ports
            setTimeout(() => requestPlannerRender(), 0);
        }
    }'''
if old_edge in text: text = text.replace(old_edge, new_edge)

with open('js/alchemy_planner.js', 'w', encoding='utf-8') as f:
    f.write(text)
print("Updated js/alchemy_planner.js")
