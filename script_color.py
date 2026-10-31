import sys

with open('style.css', 'r', encoding='utf-8') as f:
    lines = f.readlines()

with open('style.css', 'w', encoding='utf-8') as f:
    for line in lines:
        if '.planner-node.node-done' in line:
            pass # skip old rules
        else:
            f.write(line)

    # Append new rules
    f.write('\n.planner-node.node-done { background: #233524; border-color: #4CAF50; opacity: 0.9; filter: none; }\n')
    f.write('.planner-node.node-done .planner-node-header { border-bottom: 1px solid #4CAF50; }\n')

print("Updated style.css")
