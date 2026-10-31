import sys
import re

with open('js/alchemy_planner.js', 'r', encoding='utf-8') as f:
    text = f.read()

# Add to recipe header
old_recipe_header = '''                <button class="planner-gear-btn" title="" onclick="event.stopPropagation(); openPlannerNodeModal('')">⚙</button>
                <button class="planner-close-btn" title="" onclick="removePlannerNode('')">✖</button>'''
new_recipe_header = '''                <button class="planner-gear-btn " title="" style="" onclick="event.stopPropagation(); togglePlannerNodeDone('')">✔</button>
                <button class="planner-gear-btn" title="" onclick="event.stopPropagation(); openPlannerNodeModal('')">⚙</button>
                <button class="planner-close-btn" title="" onclick="removePlannerNode('')">✖</button>'''
if old_recipe_header in text: text = text.replace(old_recipe_header, new_recipe_header)

# Add to module header
old_module_header = '''            <button class="planner-gear-btn" title="" onclick="event.stopPropagation(); openPlannerNodeModal('')">⚙</button>
            <button class="planner-close-btn" title="" onclick="removePlannerNode('')">✖</button>'''
new_module_header = '''            <button class="planner-gear-btn " title="" style="" onclick="event.stopPropagation(); togglePlannerNodeDone('')">✔</button>
            <button class="planner-gear-btn" title="" onclick="event.stopPropagation(); openPlannerNodeModal('')">⚙</button>
            <button class="planner-close-btn" title="" onclick="removePlannerNode('')">✖</button>'''
if old_module_header in text: text = text.replace(old_module_header, new_module_header)

# Add to portal header
old_portal_header = '''            <button class="planner-gear-btn" title="switch direction" onclick="event.stopPropagation(); plannerToggleNodeDirection('')">
                🔁
            </button>
            <button class="planner-close-btn" onclick="removePlannerNode('')">
                ✖
            </button>'''
new_portal_header = '''            <button class="planner-gear-btn " title="" style="" onclick="event.stopPropagation(); togglePlannerNodeDone('')">✔</button>
            <button class="planner-gear-btn" title="switch direction" onclick="event.stopPropagation(); plannerToggleNodeDirection('')">
                🔁
            </button>
            <button class="planner-close-btn" onclick="removePlannerNode('')">
                ✖
            </button>'''
if old_portal_header in text: text = text.replace(old_portal_header, new_portal_header)

# Add class to wrap
old_wrap_add = '''    if (node.kind === 'recipe' || node.kind === 'module') {'''
new_wrap_add = '''    if (node.isDone) wrap.classList.add('node-done');
    if (node.kind === 'recipe' || node.kind === 'module') {'''
if old_wrap_add in text: text = text.replace(old_wrap_add, new_wrap_add)
old_wrap_add_portal = '''    if (isReversed) {
        wrap.classList.add('reversed');
    }'''
new_wrap_add_portal = '''    if (isReversed) {
        wrap.classList.add('reversed');
    }
    if (node.isDone) wrap.classList.add('node-done');'''
if old_wrap_add_portal in text: text = text.replace(old_wrap_add_portal, new_wrap_add_portal)


# Add function
func = '''
function togglePlannerNodeDone(nodeId) {
    const node = plannerState.nodes[nodeId];
    if (node) {
        node.isDone = !node.isDone;
        savePlannerState();
        requestPlannerRender();
    }
}
'''
text += func

with open('js/alchemy_planner.js', 'w', encoding='utf-8') as f:
    f.write(text)
print("Updated done toggle")
