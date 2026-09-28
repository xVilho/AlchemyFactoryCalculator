import sys
with open('js/alchemy_planner.js', 'r', encoding='utf-8') as f:
    text = f.read()

old_html = '''function togglePlannerLinkMode() {
    _plannerLinkMode = !_plannerLinkMode;
    updateAllPlannerLinkButtons();
}

function updateAllPlannerLinkButtons() {
    document.querySelectorAll('.planner-link-btn').forEach(btn => {
        btn.classList.toggle('active', _plannerLinkMode);
    });
}'''

new_html = '''function togglePlannerLinkMode() {
    const modes = ['none', 'all', 'upstream', 'downstream'];
    let idx = modes.indexOf(_plannerLinkMode);
    if (idx === -1) idx = 0;
    _plannerLinkMode = modes[(idx + 1) % modes.length];
    updateAllPlannerLinkButtons();
}

function getPlannerLinkTitle() {
    if (_plannerLinkMode === 'all') return t('Link: All Connected', 'ui');
    if (_plannerLinkMode === 'upstream') return t('Link: Upstream Only', 'ui');
    if (_plannerLinkMode === 'downstream') return t('Link: Downstream Only', 'ui');
    return t('Link: None', 'ui');
}

function getPlannerLinkIcon() {
    if (_plannerLinkMode === 'all') return '🔗';
    if (_plannerLinkMode === 'upstream') return '◀';
    if (_plannerLinkMode === 'downstream') return '▶';
    return '🔗';
}

function updateAllPlannerLinkButtons() {
    document.querySelectorAll('.planner-link-btn').forEach(btn => {
        btn.classList.toggle('active', _plannerLinkMode !== 'none');
        btn.title = getPlannerLinkTitle();
        const iconSpan = btn.querySelector('.link-icon') || btn;
        if (btn.querySelector('.link-icon')) {
            btn.querySelector('.link-icon').textContent = getPlannerLinkIcon();
        } else {
            btn.textContent = getPlannerLinkIcon();
        }
    });
}'''

text = text.replace(old_html, new_html)

with open('js/alchemy_planner.js', 'w', encoding='utf-8') as f:
    f.write(text)
