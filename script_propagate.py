import sys
with open('js/alchemy_planner.js', 'r', encoding='utf-8') as f:
    text = f.read()

old_code = '''    connected.forEach(id => {
        const n = plannerState.nodes[id];
        if (n) n.machineCount = Math.max(0, n.machineCount * ratio);
    });'''

new_code = '''    connected.forEach(id => {
        const n = plannerState.nodes[id];
        if (n && n.kind !== 'portal') n.machineCount = Math.max(0, n.machineCount * ratio);
    });'''

if old_code in text:
    text = text.replace(old_code, new_code)
    print("Replaced!")
else:
    print("Not found!")

with open('js/alchemy_planner.js', 'w', encoding='utf-8') as f:
    f.write(text)
