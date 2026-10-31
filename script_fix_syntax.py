import sys

with open('js/alchemy_planner.js', 'r', encoding='utf-8') as f:
    text = f.read()

bad_html = """    wrap.innerHTML = 
        <div class="planner-port planner-port-dot planner-port-in" data-node="${node.id}" data-item="${item}" data-dir="in" style="position:absolute; width:100%; height:100%; opacity:0;"></div>
        <div class="planner-port planner-port-dot planner-port-out" data-node="${node.id}" data-item="${item}" data-dir="out" style="position:absolute; width:100%; height:100%; opacity:0;"></div>
    ;"""

good_html = """    wrap.innerHTML = `
        <div class="planner-port planner-port-dot planner-port-in" data-node="${node.id}" data-item="${item}" data-dir="in" style="position:absolute; width:100%; height:100%; opacity:0;"></div>
        <div class="planner-port planner-port-dot planner-port-out" data-node="${node.id}" data-item="${item}" data-dir="out" style="position:absolute; width:100%; height:100%; opacity:0;"></div>
    `;"""

text = text.replace(bad_html, good_html)

with open('js/alchemy_planner.js', 'w', encoding='utf-8') as f:
    f.write(text)
print("Fixed backticks!")
