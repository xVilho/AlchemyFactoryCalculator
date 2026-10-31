import sys
with open('js/alchemy_planner.js', 'r', encoding='utf-8') as f:
    text = f.read()

idx = text.find('wrap.innerHTML = `\n        <div class="planner-port')
if idx != -1:
    print("Backtick found successfully!")
else:
    print("Backtick not found!")
