import sys
import re
with open('js/alchemy_planner_calc.js', 'r', encoding='utf-8') as f:
    text = f.read()

# Replace: if (node.kind === 'portal' || node.kind === 'waypoint') return plannerGetPortalRates(node);
# No, both portal and waypoint use plannerGetPortalRates, that's fine. 

# Replace the 99999999 supply/demand bypass:
# From:
# if (fromNode && (fromNode.kind === 'portal' || fromNode.kind === 'waypoint')) supply = 99999999;
# if (toNode && (toNode.kind === 'portal' || toNode.kind === 'waypoint')) demand = 99999999;
# To: Only waypoint!
text = text.replace(
    "if (fromNode && (fromNode.kind === 'portal' || fromNode.kind === 'waypoint')) supply = 99999999;",
    "if (fromNode && fromNode.kind === 'waypoint') supply = 99999999;"
)
text = text.replace(
    "if (toNode && (toNode.kind === 'portal' || toNode.kind === 'waypoint')) demand = 99999999;",
    "if (toNode && toNode.kind === 'waypoint') demand = 99999999;"
)

# Replace the remaining decrement bypass:
# From:
# if (!fromNode || (fromNode.kind !== 'portal' && fromNode.kind !== 'waypoint')) portRemaining[outKey] = (portRemaining[outKey] ?? 0) - flow;
# if (!toNode || (toNode.kind !== 'portal' && toNode.kind !== 'waypoint')) portRemaining[inKey] = (portRemaining[inKey] ?? 0) - flow;
# To: Only waypoint!
text = text.replace(
    "if (!fromNode || (fromNode.kind !== 'portal' && fromNode.kind !== 'waypoint')) portRemaining[outKey] = (portRemaining[outKey] ?? 0) - flow;",
    "if (!fromNode || fromNode.kind !== 'waypoint') portRemaining[outKey] = (portRemaining[outKey] ?? 0) - flow;"
)
text = text.replace(
    "if (!toNode || (toNode.kind !== 'portal' && toNode.kind !== 'waypoint')) portRemaining[inKey] = (portRemaining[inKey] ?? 0) - flow;",
    "if (!toNode || toNode.kind !== 'waypoint') portRemaining[inKey] = (portRemaining[inKey] ?? 0) - flow;"
)

# Replace the maxFlow machineCount overwrite:
# From:
# if (node.kind === 'portal' || node.kind === 'waypoint') {
# To:
# if (node.kind === 'waypoint') {
text = text.replace(
    "if (node.kind === 'portal' || node.kind === 'waypoint') {",
    "if (node.kind === 'waypoint') {"
)


with open('js/alchemy_planner_calc.js', 'w', encoding='utf-8') as f:
    f.write(text)
print('Done!')
