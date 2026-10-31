import sys
import re

with open('js/alchemy_planner.js', 'r', encoding='utf-8') as f:
    text = f.read()

pattern = r"// Invisible ports covering the entire dot so that connections snap to the center\s*wrap\.innerHTML = `[\s\S]*?`;"

new_code = '''// Invisible ports covering the entire dot so that connections snap to the center
    wrap.innerHTML = `
        <div class="planner-port planner-port-dot planner-port-in" data-node="${node.id}" data-item="${item}" data-dir="in" style="position:absolute; width:100%; height:100%; opacity:0;"></div>
        <div class="planner-port planner-port-dot planner-port-out" data-node="${node.id}" data-item="${item}" data-dir="out" style="position:absolute; width:100%; height:100%; opacity:0;"></div>
    `;'''

if re.search(pattern, text):
    text = re.sub(pattern, new_code, text)
    print("Fixed empty data attributes")
else:
    print("Could not find pattern")

with open('js/alchemy_planner.js', 'w', encoding='utf-8') as f:
    f.write(text)
