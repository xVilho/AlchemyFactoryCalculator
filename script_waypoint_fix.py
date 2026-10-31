import sys
with open('js/alchemy_planner.js', 'r', encoding='utf-8') as f:
    text = f.read()

# Add planner-port-dot to Waypoints so getPlannerPortGraphPos can find them
text = text.replace('class="planner-port planner-port-in"', 'class="planner-port planner-port-dot planner-port-in"')
text = text.replace('class="planner-port planner-port-out"', 'class="planner-port planner-port-dot planner-port-out"')

with open('js/alchemy_planner.js', 'w', encoding='utf-8') as f:
    f.write(text)
print("Fixed waypoint dots")
