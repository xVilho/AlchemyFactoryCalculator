import sys
with open('js/alchemy_planner_overlays.js', 'r', encoding='utf-8') as f:
    text = f.read()

old_html = 'onclick="plannerSelectAllUpstreamNodes(\'${node.id}\')">'
new_html = 'onclick="plannerAutoBalanceUpstream(\'${node.id}\')">⚖️ Auto-Balance Upstream</button>\n            <button class="split-btn" style="width:100%;" onclick="plannerSelectAllUpstreamNodes(\'${node.id}\')">'

text = text.replace(old_html, new_html)

with open('js/alchemy_planner_overlays.js', 'w', encoding='utf-8') as f:
    f.write(text)
