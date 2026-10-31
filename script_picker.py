import sys
with open('js/alchemy_planner_overlays.js', 'r', encoding='utf-8') as f:
    text = f.read()

old_str = """    const headerText = `${t(consuming ? 'CONSUME' : 'PRODUCE', 'ui')} ${ctx.item}`;

    panel.innerHTML = `
        <div class="planner-picker-header">${headerText}</div>"""

new_str = """    const headerText = `${t(consuming ? 'CONSUME' : 'PRODUCE', 'ui')} <span style="color:var(--info); font-weight:bold;">${ctx.item}</span>`;

    panel.innerHTML = `
        <div class="planner-picker-header">${headerText}</div>
        <button class="split-btn" style="width:100%; margin-bottom:5px;" onclick="choosePlannerWaypointFromPicker()">+ 📍 Waypoint / Router</button>"""

if old_str in text:
    text = text.replace(old_str, new_str)
    print("Replaced")
else:
    print("Not found")

with open('js/alchemy_planner_overlays.js', 'w', encoding='utf-8') as f:
    f.write(text)
