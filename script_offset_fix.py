import sys
import re

with open('js/alchemy_planner.js', 'r', encoding='utf-8') as f:
    text = f.read()

# Add margin offset to renderPlannerWaypointNode to center it
pattern = r"wrap\.style\.display = 'block';"
replacement = r"wrap.style.display = 'block';\n    wrap.style.marginLeft = '-8px';\n    wrap.style.marginTop = '-8px';"
text = re.sub(pattern, replacement, text)

with open('js/alchemy_planner.js', 'w', encoding='utf-8') as f:
    f.write(text)
print("Centered waypoint offset")
