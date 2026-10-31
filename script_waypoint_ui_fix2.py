import sys

with open('js/alchemy_planner.js', 'r', encoding='utf-8') as f:
    text = f.read()

bad_in = '<div class="planner-port planner-port-dot planner-port-in" data-node="" data-item="" data-dir="in"'
good_in = '<div class="planner-port planner-port-dot planner-port-in" data-node="${node.id}" data-item="${item}" data-dir="in"'
text = text.replace(bad_in, good_in)

bad_out = '<div class="planner-port planner-port-dot planner-port-out" data-node="" data-item="" data-dir="out"'
good_out = '<div class="planner-port planner-port-dot planner-port-out" data-node="${node.id}" data-item="${item}" data-dir="out"'
text = text.replace(bad_out, good_out)

with open('js/alchemy_planner.js', 'w', encoding='utf-8') as f:
    f.write(text)
print("Replaced bad attributes")
