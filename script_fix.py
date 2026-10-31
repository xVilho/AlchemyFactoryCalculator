import sys
import re

with open('js/alchemy_planner.js', 'r', encoding='utf-8') as f:
    text = f.read()

# 1. onPlannerAddWaypointClick
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

# 2. plannerGetPortalRates
pattern2 = r"function plannerGetPortalRates\(node\) \{[\s\S]*?const item = node\.portalItem;\s*if \(!item \|\| !DB\.items\[item\]\) return \{ \.\.\.result, errorCode: 'No Item Selected' \};\s*return \{ \.\.\.result, inputsPerMachine: \[\{ item, rate: 1 \}\], outputsPerMachine: \[\{ item, rate: 1 \}\] \};\s*\}"
new_func2 = '''function plannerGetPortalRates(node) {
    const result = { recipe: null, inputsPerMachine: [], outputsPerMachine: [], heatItemsPerMachine: 0, fertItemsPerMachine: 0, errorCode: '' };
    const item = node.portalItem;
    if (item === 'Any') return { ...result, inputsPerMachine: [{ item: 'Any', rate: 1 }], outputsPerMachine: [{ item: 'Any', rate: 1 }] };
    if (!item || !DB.items[item]) return { ...result, errorCode: 'No Item Selected' };
    return { ...result, inputsPerMachine: [{ item, rate: 1 }], outputsPerMachine: [{ item, rate: 1 }] };
}'''
text = re.sub(pattern2, new_func2, text)

# 3. Headers checkmark
# We can just look for <button class="planner-gear-btn" title=""
# And insert the checkmark button right before it.
check_btn = '''<button class="planner-gear-btn " title="" style="" onclick="event.stopPropagation(); togglePlannerNodeDone('')">✔</button>
                '''

text = re.sub(r'(<button class="planner-gear-btn" title="\$\{t\(\'Node Settings\', \'ui\'\)\}")', check_btn + r'\1', text)

# 4. Portal checkmark
# Portal has: <button class="planner-gear-btn" title="switch direction"
text = re.sub(r'(<button class="planner-gear-btn" title="switch direction")', check_btn + r'\1', text)

# 5. Add 'node-done' class to wrap for recipe and module
text = re.sub(r"(if \(node\.kind === 'recipe' \|\| node\.kind === 'module'\) \{)", r"if (node.isDone) wrap.classList.add('node-done');\n    \1", text)


with open('js/alchemy_planner.js', 'w', encoding='utf-8') as f:
    f.write(text)
print("Regex replacements executed")
