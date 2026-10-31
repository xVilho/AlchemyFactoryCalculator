import sys
import re

with open('js/alchemy_planner.js', 'r', encoding='utf-8') as f:
    text = f.read()

# Fix the broken buttons
text = text.replace(
    '<button class="planner-gear-btn " title="" style="" onclick="event.stopPropagation(); togglePlannerNodeDone(\'\')">✔</button>',
    '<button class="planner-gear-btn ${node.isDone ? \'done-active\' : \'\'}" title="${t(\'Toggle Done\', \'ui\')}" style="${node.isDone ? \'color:#4CAF50; font-weight:bold;\' : \'\'}" onclick="event.stopPropagation(); togglePlannerNodeDone(\'${node.id}\')">✔</button>'
)

# Fix onPlannerAddWaypointClick and plannerGetPortalRates
pattern1 = r"function onPlannerAddWaypointClick\(\) \{[\s\S]*?openPlannerItemPicker\(g\.x, g\.y, 'waypoint'\);\s*\}"
new_func1 = '''function onPlannerAddWaypointClick() {
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
text = re.sub(pattern1, new_func1, text)

pattern2 = r"function plannerGetPortalRates\(node\) \{[\s\S]*?const item = node\.portalItem;\s*if \(!item \|\| !DB\.items\[item\]\) return \{ \.\.\.result, errorCode: 'No Item Selected' \};\s*return \{ \.\.\.result, inputsPerMachine: \[\{ item, rate: 1 \}\], outputsPerMachine: \[\{ item, rate: 1 \}\] \};\s*\}"
new_func2 = '''function plannerGetPortalRates(node) {
    const result = { recipe: null, inputsPerMachine: [], outputsPerMachine: [], heatItemsPerMachine: 0, fertItemsPerMachine: 0, errorCode: '' };
    const item = node.portalItem;
    if (item === 'Any') return { ...result, inputsPerMachine: [{ item: 'Any', rate: 1 }], outputsPerMachine: [{ item: 'Any', rate: 1 }] };
    if (!item || !DB.items[item]) return { ...result, errorCode: 'No Item Selected' };
    return { ...result, inputsPerMachine: [{ item, rate: 1 }], outputsPerMachine: [{ item, rate: 1 }] };
}'''
text = re.sub(pattern2, new_func2, text)

# Add node-done class to wrap for recipe and module
text = re.sub(r"(if \(node\.kind === 'recipe' \|\| node\.kind === 'module'\) \{)", r"if (node.isDone) wrap.classList.add('node-done');\n    \1", text)


with open('js/alchemy_planner.js', 'w', encoding='utf-8') as f:
    f.write(text)
print("Regex replacements executed")
