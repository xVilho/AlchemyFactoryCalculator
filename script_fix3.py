import sys
import re

with open('js/alchemy_planner.js', 'r', encoding='utf-8') as f:
    text = f.read()

pattern1 = r"function onPlannerAddWaypointClick\(\) \{[\s\S]*?openPlannerItemPicker\([^)]+\);\s*\}"
new_func1 = '''function onPlannerAddWaypointClick() {
    const { graphX, graphY } = _plannerGetCenterGraphPos();
    plannerState._nodeSeq = (plannerState._nodeSeq || 0) + 1;
    const newNodeId = 'pnode_' + plannerState._nodeSeq;
    plannerState.nodes[newNodeId] = {
        id: newNodeId, kind: 'waypoint', portalItem: 'Any', machineCount: 1,
        x: Math.round(graphX), y: Math.round(graphY)
    };
    savePlannerState();
    requestPlannerRender();
}'''
if re.search(pattern1, text):
    text = re.sub(pattern1, new_func1, text)
    print("Replaced onPlannerAddWaypointClick")
else:
    print("Could not find onPlannerAddWaypointClick")

with open('js/alchemy_planner.js', 'w', encoding='utf-8') as f:
    f.write(text)
