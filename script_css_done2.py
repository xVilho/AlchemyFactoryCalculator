import sys
with open('style.css', 'a', encoding='utf-8') as f:
    f.write('\n.planner-node.node-done { opacity: 0.5; filter: grayscale(50%); }\n')
    f.write('.planner-node.node-done .planner-node-header { border-bottom: 1px solid #4CAF50; }\n')
print("Updated css")
