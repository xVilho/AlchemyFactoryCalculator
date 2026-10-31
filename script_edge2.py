import sys
import re

with open('js/alchemy_planner.js', 'r', encoding='utf-8') as f:
    text = f.read()

# Remove setTimeout(() => renderPlanner(), 0);
text = text.replace('setTimeout(() => renderPlanner(), 0);', '')

# Replace recomputeAndRefreshPlanner with renderPlanner
text = text.replace('let flows = recomputeAndRefreshPlanner();', 'let flows = plannerResolveFlows();\n    renderPlanner();')

with open('js/alchemy_planner.js', 'w', encoding='utf-8') as f:
    f.write(text)
print("Updated tryCreatePlannerEdgeFromDots")
