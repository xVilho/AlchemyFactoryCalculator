import sys
import re

with open('js/alchemy_planner.js', 'r', encoding='utf-8') as f:
    text = f.read()

# Replace if (node.isDone) wrap.classList.add('node-done');
# with if (node.isDone) { wrap.classList.add('node-done'); wrap.style.backgroundColor = '#2d5a2d'; wrap.style.borderColor = '#4CAF50'; }
pattern = r"if \(node\.isDone\) wrap\.classList\.add\('node-done'\);"
replacement = r"if (node.isDone) { wrap.classList.add('node-done'); wrap.style.backgroundColor = '#2d5a2d'; wrap.style.borderColor = '#4CAF50'; }"
text = re.sub(pattern, replacement, text)

with open('js/alchemy_planner.js', 'w', encoding='utf-8') as f:
    f.write(text)
print("Added inline styles")
