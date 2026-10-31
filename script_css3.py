import sys
with open('style.css', 'r', encoding='utf-8') as f:
    text = f.read()

text = text.replace('.planner-node.node-done { background: #2d5a2d; border-color: #4CAF50; opacity: 0.9; filter: none; }', '.planner-node.node-done { background: #2d5a2d !important; border-color: #4CAF50 !important; opacity: 0.9; filter: none; }')

with open('style.css', 'w', encoding='utf-8') as f:
    f.write(text)
print("Updated CSS with important")
