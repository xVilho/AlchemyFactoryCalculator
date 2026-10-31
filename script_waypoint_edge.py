import sys
import re

with open('js/alchemy_planner.js', 'r', encoding='utf-8') as f:
    text = f.read()

pattern = r"const targetDir = targetDotEl\.dataset\.dir;"
replacement = '''let targetDir = targetDotEl.dataset.dir;
    
    // If we dropped on a waypoint, dynamically choose the opposite port so it always connects!
    const targetNodeKind = targetNodeEl.dataset.kind || (plannerState.nodes[targetNodeId] ? plannerState.nodes[targetNodeId].kind : '');
    if (targetNodeKind === 'waypoint' && targetDir === sourceDir) {
        targetDir = sourceDir === 'out' ? 'in' : 'out';
        // We don't even need to change targetDotEl because the logic below only cares about targetDir and targetItem!
    }'''

text = re.sub(pattern, replacement, text)

with open('js/alchemy_planner.js', 'w', encoding='utf-8') as f:
    f.write(text)
print("Fixed waypoint bidirectional drop")
