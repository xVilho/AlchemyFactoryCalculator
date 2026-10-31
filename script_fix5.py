import sys
import re

with open('js/alchemy_planner.js', 'r', encoding='utf-8') as f:
    text = f.read()

# I added `requestPlannerRender()` in three places (togglePlannerNodeDone, onPlannerAddWaypointClick, tryCreatePlannerEdgeFromDots).
# But the function is actually `renderPlanner()`!
text = text.replace('requestPlannerRender()', 'renderPlanner()')

with open('js/alchemy_planner.js', 'w', encoding='utf-8') as f:
    f.write(text)
print("Replaced requestPlannerRender with renderPlanner")
