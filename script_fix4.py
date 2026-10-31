import sys
import re

with open('js/alchemy_planner_calc.js', 'r', encoding='utf-8') as f:
    text = f.read()

pattern2 = r"function plannerGetPortalRates\(node\) \{[\s\S]*?const item = node\.portalItem;\s*if \(!item \|\| !DB\.items\[item\]\) return \{ \.\.\.result, errorCode: 'No Item Selected' \};\s*return \{ \.\.\.result, inputsPerMachine: \[\{ item, rate: 1 \}\], outputsPerMachine: \[\{ item, rate: 1 \}\] \};\s*\}"
new_func2 = '''function plannerGetPortalRates(node) {
    const result = { recipe: null, inputsPerMachine: [], outputsPerMachine: [], heatItemsPerMachine: 0, fertItemsPerMachine: 0, errorCode: '' };
    const item = node.portalItem;
    if (item === 'Any') return { ...result, inputsPerMachine: [{ item: 'Any', rate: 1 }], outputsPerMachine: [{ item: 'Any', rate: 1 }] };
    if (!item || !DB.items[item]) return { ...result, errorCode: 'No Item Selected' };
    return { ...result, inputsPerMachine: [{ item, rate: 1 }], outputsPerMachine: [{ item, rate: 1 }] };
}'''
if re.search(pattern2, text):
    text = re.sub(pattern2, new_func2, text)
    print("Replaced plannerGetPortalRates")
else:
    print("Could not find plannerGetPortalRates")

with open('js/alchemy_planner_calc.js', 'w', encoding='utf-8') as f:
    f.write(text)
