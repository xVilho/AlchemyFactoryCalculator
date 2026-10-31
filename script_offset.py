import sys
import re
with open('js/alchemy_planner.js', 'r', encoding='utf-8') as f:
    text = f.read()

text = text.replace("x: Math.round(graphX), y: Math.round(graphY)", "x: Math.round(graphX + Math.random() * 20), y: Math.round(graphY + Math.random() * 20)")

with open('js/alchemy_planner.js', 'w', encoding='utf-8') as f:
    f.write(text)
print("Added random offset")
