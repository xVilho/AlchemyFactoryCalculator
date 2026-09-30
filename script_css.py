import sys
with open('style.css', 'r', encoding='utf-8') as f:
    text = f.read()

# Replace cauldron-grid
old_grid = '.cauldron-grid { display: grid; grid-template-columns: 280px 1fr 350px; gap: 15px; height: 100%; }'
new_grid = '.cauldron-grid { display: grid; grid-template-columns: 280px 1fr 350px; gap: 15px; align-items: start; }'
text = text.replace(old_grid, new_grid)

# Replace scroll-panel
old_scroll = '.scroll-panel { display: flex; flex-direction: column; max-height: 100%; }'
new_scroll = '.scroll-panel { display: flex; flex-direction: column; position: sticky; top: 15px; max-height: calc(100vh - 30px); }'
text = text.replace(old_scroll, new_scroll)

# Replace cauldron-multistep-scroll
old_multi = '.cauldron-multistep-scroll { overflow: auto; max-height: calc(100vh - 220px); }'
new_multi = '.cauldron-multistep-scroll { overflow: visible; max-height: none; }'
text = text.replace(old_multi, new_multi)

with open('style.css', 'w', encoding='utf-8') as f:
    f.write(text)
print('Done!')
