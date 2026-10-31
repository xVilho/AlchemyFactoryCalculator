import sys
import re

with open('js/alchemy_planner.js', 'r', encoding='utf-8') as f:
    text = f.read()

pattern = r"function renderPlannerWaypointNode\(wrap, node, flows\) \{[\s\S]*?return wrap;\s*\}"

new_func = '''function renderPlannerWaypointNode(wrap, node, flows) {
    // Clear default node styles
    wrap.style.backgroundColor = 'var(--bg-light)';
    wrap.style.borderColor = 'var(--accent)';
    wrap.style.width = '16px';
    wrap.style.height = '16px';
    wrap.style.borderRadius = '50%';
    wrap.style.border = '2px solid var(--border)';
    wrap.style.boxShadow = '0 0 6px rgba(0,0,0,0.5)';
    wrap.style.cursor = 'pointer';
    wrap.style.zIndex = '10';
    wrap.style.padding = '0';
    wrap.style.display = 'block';

    const item = node.portalItem || 'Any';
    const outKey = plannerPortKey(node.id, item, 'out');
    const inKey = plannerPortKey(node.id, item, 'in');
    
    // Check if it's fully connected (both in and out) to color it green
    const connectedIn = flows && flows.portConnections[inKey] && flows.portConnections[inKey].length > 0;
    const connectedOut = flows && flows.portConnections[outKey] && flows.portConnections[outKey].length > 0;
    if (connectedIn || connectedOut) {
        wrap.style.borderColor = '#4CAF50';
        wrap.style.backgroundColor = '#1b3320';
    }

    wrap.ondblclick = (e) => {
        e.stopPropagation();
        removePlannerNode(node.id);
    };

    // Invisible ports covering the entire dot so that connections snap to the center
    wrap.innerHTML = 
        <div class="planner-port planner-port-dot planner-port-in" data-node="" data-item="" data-dir="in" style="position:absolute; width:100%; height:100%; opacity:0;"></div>
        <div class="planner-port planner-port-dot planner-port-out" data-node="" data-item="" data-dir="out" style="position:absolute; width:100%; height:100%; opacity:0;"></div>
    ;

    // No drag attached -> immovable
    return wrap;
}'''

if re.search(pattern, text):
    text = re.sub(pattern, new_func, text)
    print("Replaced renderPlannerWaypointNode")
else:
    print("Not found renderPlannerWaypointNode")

with open('js/alchemy_planner.js', 'w', encoding='utf-8') as f:
    f.write(text)
