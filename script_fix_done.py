import sys
import re

with open('js/alchemy_planner.js', 'r', encoding='utf-8') as f:
    text = f.read()

# Add node-done class
pattern = r"wrap\.style\.top = node\.y \+ 'px';"
replacement = r"wrap.style.top = node.y + 'px';\n    if (node.isDone) wrap.classList.add('node-done');"
text = re.sub(pattern, replacement, text)

with open('js/alchemy_planner.js', 'w', encoding='utf-8') as f:
    f.write(text)
print("Added node-done class")
