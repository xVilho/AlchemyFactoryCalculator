import sys

with open('style.css', 'r', encoding='utf-8') as f:
    lines = f.readlines()

with open('style.css', 'w', encoding='utf-8') as f:
    for line in lines:
        if '.planner-node.node-done' in line:
            pass
        else:
            f.write(line)

    # Use a more noticeable green background for the done state
    f.write('\n.planner-node.node-done { background: #2d5a2d; border-color: #4CAF50; opacity: 0.9; filter: none; }\n')
    f.write('.planner-node.node-done .planner-node-header { border-bottom: 2px solid #4CAF50; }\n')

print("Updated style.css")
