// Overlays and Modals in Planner Tab
// Dependency: alchemy_planner.js, alchemy_planner_calc.js

/* ==========================================================================
   SECTION: PLAN LIBRARY UI - Toolbar Dropdown
   ========================================================================== */

/** Redraw the plan dropdown on the toolbar, with activePlanId selected */
function renderPlannerToolbarSelect() {
    const sel = document.getElementById('planner-plan-select');
    if (!sel) return;
    sel.innerHTML = plannerLibrary.planOrder
        .filter(id => plannerLibrary.plans[id])
        .map(id => {
            const plan = plannerLibrary.plans[id];
            const selected = id === plannerLibrary.activePlanId ? 'selected' : '';
            return `<option value="${id}" ${selected}>${_escapeHtml(plan.name)}</option>`;
        }).join('');
}

/** Switch the active plan: repoint plannerState and redraw the whole canvas */
function switchPlannerPlan(planId) {
    if (!plannerLibrary.plans[planId] || planId === plannerLibrary.activePlanId) return;
    // Remember the current plan's viewport for when we switch back
    _plannerViewportCache[plannerLibrary.activePlanId] = { ..._plannerSettings.viewport };
    plannerLibrary.activePlanId = planId;
    _activatePlanData(planId);

    renderPlanner();
    updatePlannerGridButton();
    updatePlannerGridBackground();

    const cachedViewport = _plannerViewportCache[planId];
    if (cachedViewport) {
        // This plan was already opened this session -> restore that view
        _plannerSettings.viewport = { ...cachedViewport };
    } else {
        // First time opening this plan this session -> fit to view (plannerFitToView calls savePlannerSettings itself)
        plannerFitToView();
        _plannerViewportCache[planId] = { ..._plannerSettings.viewport };
    }

    applyPlannerViewportTransform();
    renderPlannerToolbarSelect();
    updatePlannerUndoRedoButtons();
    savePlannerLibraryMeta(); // Only the selection changed, not a content edit
}

function _escapeHtml(str) {
    return (str || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function _formatPlannerTime(ts) {
    if (!ts) return '';
    const diff = Date.now() - ts;
    const min = 60000, hr = 3600000, day = 86400000;
    if (diff < min) return t('just now', 'ui');
    if (diff < hr) return Math.floor(diff / min) + ' ' + t('min ago', 'ui');
    if (diff < day) return Math.floor(diff / hr) + ' ' + t('hr ago', 'ui');
    if (diff < day * 7) return Math.floor(diff / day) + ' ' + t('days ago', 'ui');
    return new Date(ts).toLocaleDateString();
}

/* ==========================================================================
   SECTION: PLAN LIBRARY UI - Manage Plans Modal
   ========================================================================== */

let _plannerManageSelectedId = null; // Plan id currently selected (highlighted) in the Manage Plans modal

/** Open the Manage Plans modal with the active plan selected */
function openPlannerManageModal() {
    _plannerManageSelectedId = plannerLibrary.activePlanId;
    renderPlannerManageList();
    document.getElementById('planner-manage-modal').style.display = 'flex';
}

/** Redraw the plan list in the modal (with drag-to-reorder handles and module dependency highlighting) */
function renderPlannerManageList() {
    const container = document.getElementById('planner-plan-list');
    if (!container) return;

    // Precompute what the selected plan depends on / is used by, for highlighting other rows
    let selectedDeps = new Set();
    let selectedDependents = new Set();
    if (_plannerManageSelectedId && plannerLibrary.plans[_plannerManageSelectedId]) {
        const dep = getPlannerModulesUsedBy(_plannerManageSelectedId);
        selectedDeps = new Set(dep.modules.filter(id => id !== _plannerManageSelectedId));
        selectedDependents = new Set(getPlannerModulesUsingPlan(_plannerManageSelectedId).filter(id => id !== _plannerManageSelectedId));
    }

    container.innerHTML = plannerLibrary.planOrder
        .filter(id => plannerLibrary.plans[id])
        .map(id => {
            const plan = plannerLibrary.plans[id];
            const isSelected = id === _plannerManageSelectedId;
            const isActive = id === plannerLibrary.activePlanId;

            const depInfo = getPlannerModulesUsedBy(id);
            const depCount = depInfo.modules.length;
            const usedByCount = getPlannerModulesUsingPlan(id).length;

            const isDep = !isSelected && selectedDeps.has(id);
            const isDependent = !isSelected && selectedDependents.has(id);
            const isBoth = isDep && isDependent;

            const classes = ['planner-plan-row'];
            if (isSelected) classes.push('selected');
            if (depInfo.hasCycle) classes.push('has-cycle');
            else if (isBoth) classes.push('rel-both');
            else if (isDep) classes.push('rel-dep');
            else if (isDependent) classes.push('rel-dependent');

            const depTag = depCount > 0
                ? `<span class="planner-plan-tag-dep" title="${t('Uses N modules', 'ui')}">⇐${depCount}</span>` : '';
            const usedTag = usedByCount > 0
                ? `<span class="planner-plan-tag-used" title="${t('Used by N plans', 'ui')}">⇒${usedByCount}</span>` : '';
            const cycleTag = depInfo.hasCycle
                ? `<span class="planner-plan-tag-cycle" title="${t('Circular module reference', 'ui')}">⚠ ${t('Cycle', 'ui')}</span>` : '';

            return `
                <div class="${classes.join(' ')}" data-plan-id="${id}" onclick="selectPlannerManageRow('${id}')">
                    <span class="planner-plan-drag-handle" title="Drag to reorder">⠿</span>
                    <span class="planner-plan-name">${_escapeHtml(plan.name)}</span>
                    ${isActive ? `<span class="planner-plan-active-tag">${t('Active', 'ui')}</span>` : ''}
                    ${depTag}
                    ${usedTag}
                    ${cycleTag}
                    <span class="planner-plan-meta">${_formatPlannerTime(plan.updatedAt)}</span>
                </div>`;
        }).join('');

    container.querySelectorAll('.planner-plan-row').forEach(row => {
        _initPlannerPlanDragHandle(row.querySelector('.planner-plan-drag-handle'), row);
    });

    _updatePlannerManageActionsState();
}

/** Enable or disable the Load/Rename/Duplicate/Delete/Export buttons depending on whether a plan is selected */
function _updatePlannerManageActionsState() {
    const row = document.getElementById('planner-plan-actions-row');
    if (!row) return;
    const disabled = !_plannerManageSelectedId;
    row.querySelectorAll('button').forEach(btn => btn.disabled = disabled);
}

function selectPlannerManageRow(id) {
    _plannerManageSelectedId = id;
    renderPlannerManageList();
}

/** Drag-to-reorder for list rows: same pointer event pattern as multi-target-row */
function _initPlannerPlanDragHandle(handle, row) {
    if (!handle) return;
    handle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        handle.setPointerCapture(e.pointerId);

        const container = document.getElementById('planner-plan-list');
        row.classList.add('dragging');
        let targetRow = null;
        let insertBefore = true;

        const onMove = (ev) => {
            const siblings = [...container.querySelectorAll('.planner-plan-row:not(.dragging)')];
            siblings.forEach(r => r.classList.remove('drag-over-top', 'drag-over-bottom'));
            targetRow = null;

            for (const r of siblings) {
                const rect = r.getBoundingClientRect();
                if (ev.clientY >= rect.top && ev.clientY <= rect.bottom) {
                    insertBefore = ev.clientY < rect.top + rect.height / 2;
                    r.classList.add(insertBefore ? 'drag-over-top' : 'drag-over-bottom');
                    targetRow = r;
                    break;
                }
            }
        };

        const onUp = () => {
            handle.removeEventListener('pointermove', onMove);
            handle.removeEventListener('pointerup', onUp);
            row.classList.remove('dragging');
            container.querySelectorAll('.planner-plan-row')
                .forEach(r => r.classList.remove('drag-over-top', 'drag-over-bottom'));

            if (targetRow) {
                container.insertBefore(row, insertBefore ? targetRow : targetRow.nextSibling);
                plannerLibrary.planOrder = [...container.querySelectorAll('.planner-plan-row')].map(r => r.dataset.planId);
                savePlannerLibraryMeta();
                renderPlannerToolbarSelect();
            }
        };

        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onUp);
    });
}

/* ---- Modal buttons: Load / Rename / Duplicate / Delete / Export ---- */

/** Make the plan selected in the modal the active plan and close the modal */
function managePlannerLoadSelected() {
    if (!_plannerManageSelectedId) return;
    switchPlannerPlan(_plannerManageSelectedId);
    closeModal('planner-manage-modal');
}

/** Replace the selected row's name with an input box for renaming in place */
function managePlannerRenameSelected() {
    const id = _plannerManageSelectedId;
    if (!id) return;
    const nameEl = document.querySelector(`.planner-plan-row[data-plan-id="${id}"] .planner-plan-name`);
    if (!nameEl) return;
    const plan = plannerLibrary.plans[id];
    const oldName = plan.name;
    nameEl.innerHTML = `<input type="text" value="${_escapeHtml(oldName)}">`;
    const input = nameEl.querySelector('input');
    input.focus();
    input.select();
    input.addEventListener('click', (e) => e.stopPropagation());

    const commit = () => {
        const newName = input.value.trim();
        plan.name = newName || oldName;
        savePlannerLibraryMeta();
        renderPlannerToolbarSelect();
        renderPlannerManageList();
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.blur();
        if (e.key === 'Escape') { input.value = oldName; input.blur(); }
    });
}

/** Duplicate the selected plan (all nodes/edges) and insert it after the original */
function managePlannerDuplicateSelected() {
    const id = _plannerManageSelectedId;
    if (!id) return;
    const src = plannerLibrary.plans[id];
    const copy = _createPlan(src.name + ' ' + t('(Copy)', 'ui'));
    copy.data = JSON.parse(JSON.stringify(src.data));

    const idx = plannerLibrary.planOrder.indexOf(id);
    plannerLibrary.plans[copy.id] = copy;
    plannerLibrary.planOrder.splice(idx + 1, 0, copy.id);

    _plannerManageSelectedId = copy.id;
    savePlannerLibraryMeta();
    renderPlannerToolbarSelect();
    renderPlannerManageList();
}

/** Delete the selected plan; if it's the active one, switch to the first in the list; can't delete the last plan */
function managePlannerDeleteSelected() {
    const id = _plannerManageSelectedId;
    if (!id) return;
    if (!confirm(t('Delete this plan?', 'ui'))) return;

    delete plannerLibrary.plans[id];
    plannerLibrary.planOrder = plannerLibrary.planOrder.filter(pid => pid !== id);
    delete plannerHistory[id]; // Also clear that plan's undo/redo history

    if (plannerLibrary.planOrder.length === 0) {
        const plan = _createPlan(t('Default Plan', 'ui'));
        plannerLibrary.plans[plan.id] = plan;
        plannerLibrary.planOrder = [plan.id];
    }

    if (plannerLibrary.activePlanId === id) {
        plannerLibrary.activePlanId = plannerLibrary.planOrder[0];
        _activatePlanData(plannerLibrary.activePlanId);
        renderPlanner();
        updatePlannerGridButton();
        updatePlannerGridBackground();
        applyPlannerViewportTransform();
        updatePlannerUndoRedoButtons();
    }

    _plannerManageSelectedId = plannerLibrary.activePlanId;
    savePlannerLibraryMeta();
    renderPlannerToolbarSelect();
    renderPlannerManageList();
}

/** Export the selected plan as a single .json file (name + data, so importing restores the name) */
function managePlannerExportSelected() {
    const id = _plannerManageSelectedId;
    if (!id) return;
    const plan = plannerLibrary.plans[id];
    const exportObj = { name: plan.name, data: plan.data };
    const blob = new Blob([JSON.stringify(exportObj, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `planner_${plan.name.replace(/[^\w\-]+/g, '_')}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function managePlannerImportAsModule() {
    const moduleId = _plannerManageSelectedId;
    if (!moduleId) return;

    const canvas = document.getElementById('planner-canvas');
    const rect = canvas.getBoundingClientRect();
    const zoom = _plannerSettings.viewport.zoom || 1;
    const graphX = plannerSnapVal((rect.width / 2 - _plannerSettings.viewport.x) / zoom - 110);
    const graphY = plannerSnapVal((rect.height / 2 - _plannerSettings.viewport.y) / zoom - 60);

    const plan = plannerLibrary.plans[moduleId];
    if (!plan) return;
    plannerState._nodeSeq = (plannerState._nodeSeq || 0) + 1;
    const id = 'pnode_' + plannerState._nodeSeq;
    plannerState.nodes[id] = {
        id,
        recipeId: null,
        moduleId,
        machineCount: 1,
        x: Math.round(graphX),
        y: Math.round(graphY)
    };
    renderPlanner();
    savePlannerState();
    closeModal('planner-manage-modal');
}

/* ---- Modal footer: New plan / Import (global actions, not tied to the selected row) ---- */

/** Create a new empty plan and go straight into renaming it */
function managePlannerCreateNew() {
    const plan = _createPlan(t('New Plan', 'ui'));
    plannerLibrary.plans[plan.id] = plan;
    plannerLibrary.planOrder.push(plan.id);
    _plannerManageSelectedId = plan.id;
    savePlannerLibraryMeta();
    renderPlannerToolbarSelect();
    renderPlannerManageList();
    managePlannerRenameSelected();
}

/** Import a plan from a file (added to the list, never overwrites an existing plan) */
function managePlannerImport() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (readerEvent) => {
            try {
                const parsed = JSON.parse(readerEvent.target.result);
                if (!parsed || typeof parsed !== 'object' || !parsed.data || !parsed.data.nodes) {
                    throw new Error("Invalid plan file format.");
                }
                const plan = _createPlan(parsed.name || t('Imported Plan', 'ui'));
                plan.data = Object.assign(_createEmptyPlanData(), parsed.data);

                plannerLibrary.plans[plan.id] = plan;
                plannerLibrary.planOrder.push(plan.id);
                _plannerManageSelectedId = plan.id;

                savePlannerLibraryMeta();
                renderPlannerToolbarSelect();
                renderPlannerManageList();
            } catch (err) {
                alert(t('Failed to import plan: ', 'ui') + err.message);
            }
        };
        reader.readAsText(file);
    };
    input.click();
}


/* ==========================================================================
   SECTION: NODE SETTINGS MODAL - recipe modifiers (catalysts / custom input)
   + recipe switching (grouped by the node's main output item)
   ========================================================================== */

function openPlannerNodeModal(nodeId) {
    if (!plannerState.nodes[nodeId]) return;
    renderPlannerNodeModalBody(nodeId);
    document.getElementById('planner-node-modal').style.display = 'flex';
}

function renderPlannerNodeModalBody(nodeId) {
    const node = plannerState.nodes[nodeId];
    const body = document.getElementById('planner-node-modal-body');
    if (!node || !body) return;
    body.dataset.nodeId = nodeId;

    const rawRecipe = plannerGetRawRecipe(node.recipeId);
    const mainOut = rawRecipe ? Object.keys(rawRecipe.outputs)[0] : null;
    const flows = _plannerLastFlows || plannerResolveFlows();

    const titleEl = document.getElementById('planner-node-modal-title');
    if (titleEl) {
        const label = mainOut || ((node.kind === 'portal' && node.portalItem) ? '🌀 ' + node.portalItem : '');
        titleEl.innerText = t('Node Settings', 'ui') + (label ? ' — ' + label : '');
    }
    
    const recipeSectionHtml = rawRecipe ?
    `
        <div class="planner-modifier-section">
            ${_buildPlannerNodeModifierHtml(node, rawRecipe)}
        </div>
        <div style="height:1px; background:var(--border); margin:12px 0;"></div>
                <div class="planner-recipe-switch-section">
            <div style="font-size:0.78em; color:#888; text-transform:uppercase; letter-spacing:0.05em; margin-bottom:6px;">
                ${t('Select Recipe', 'ui')}
            </div>
            <div class="planner-picker-list" style="max-height:240px; overflow-y:auto; padding:0;">
                ${mainOut ? _buildPlannerNodeRecipeSwitchHtml(node, mainOut) : `<div class="planner-picker-empty">${t('No recipe selected', 'ui')}</div>`}
            </div>
        </div>
    ` : ``;

    const moduleSectionHtml = node.moduleId ?
    `
        <div class="planner-module-section">
            <button class="split-btn" style="width:100%;" onclick="switchPlannerPlan('${node.moduleId}')">
                📦 ${t('Load Module', 'ui')}
            </button>
        </div>
    ` : ``;


    body.innerHTML = `        
        ${recipeSectionHtml}
        ${moduleSectionHtml}
        ${_buildPlannerNodeMismatchSectionHtml(node, flows)}
        <div style="height:1px; background:var(--border); margin:12px 0;"></div>
        <div class="planner-node-actions-section" style="display:flex; flex-direction:column; gap:6px;">
            <div style="font-size:0.78em; color:#888; text-transform:uppercase; letter-spacing:0.05em; margin-bottom:2px;">
                ${t('Graph Tools', 'ui')}
            </div>
            <button class="split-btn" style="width:100%;" onclick="plannerAutoBalanceUpstream('${node.id}')">⚖️ Auto-Balance Upstream</button>
            <button class="split-btn" style="width:100%;" onclick="plannerSelectAllUpstreamNodes('${node.id}')">
                ▭ ${t('Select All Upstream', 'ui')}
            </button>
            <button class="split-btn" style="width:100%;" onclick="plannerAutoLayoutUpstream('${node.id}')">
                ⇶ ${t('Auto-Layout Upstream', 'ui')}
            </button>
            <button class="split-btn" style="width:100%;" onclick="autoGenerateAllUpstreamNodes('${node.id}')">
                ⚡ ${t('Populate All Upstream', 'ui')}
            </button>
            <button class="split-btn" style="width:100%;" onclick="removeAllUpsteamNodes('${node.id}')">
                × ${t('Clear All Upstream', 'ui')}
            </button>
        </div>
    `;
}

/** Show the current recipe (with the node's own recipeModifiers applied) in a fixed area,
 *  plus modifier controls for the machine type (advanced machine catalysts / Paradox Crucible custom input) */
function _buildPlannerNodeModifierHtml(node, rawRecipe) {
    if (!rawRecipe) {
        return `<div class="planner-picker-empty">${t('No recipe selected', 'ui')}</div>`;
    }

    let effRecipe = rawRecipe;
    if (typeof getRecipeById === 'function') {
        effRecipe = getRecipeById(node.recipeId, node.recipeModifiers) || rawRecipe;
    }

    const inputsHtml = _plannerFormatIOList(effRecipe.inputs);
    const outputsHtml = _plannerFormatIOList(effRecipe.outputs);

    let controlsHtml = '';
    if (rawRecipe.machine === 'Advanced Athanor') {
        const activeCats = node.recipeModifiers?.catalysts || [];
        const btns = ATHANOR_CATALYSTS.map(c => {
            const isActive = activeCats.includes(c.id);
            return `<button class="catalyst-btn${isActive ? ' active' : ''}" onclick="plannerToggleCatalyst('${node.id}','${c.id}')">${t(c.label)}</button>`;
        }).join('');
        controlsHtml = `<div class="catalyst-row" style="margin-top:10px; padding-top:8px; border-top:1px dashed var(--border);">${t('Catalysts')} ${btns}</div>`;
    } else if (rawRecipe.machine === 'Paradox Crucible' && rawRecipe.customInputSlot) {
        const selectedItem = node.recipeModifiers?.customInput;
        const inputDef = selectedItem ? DB.items[selectedItem] : null;
        const previewTime = selectedItem ? AlchemyCalcEngine.computeParadoxTime(DB, selectedItem) : null;
        let warnHtml = '';
        if (!selectedItem) {
            warnHtml = `<div class="loop-warning">${t('Please select an input item first.')}</div>`;
        } else if (previewTime === null) {
            warnHtml = `<div class="loop-warning">${t('Selected item is missing paradoxTime data.')}</div>`;
        }
        controlsHtml = `
            <div style="margin-top:10px; padding-top:8px; border-top:1px dashed var(--border); display:flex; align-items:center; gap:8px;">
                <span style="font-size:0.82em; color:#aaa;">${t('Input')}:</span>
                <span class="mini-picker" style="display:inline-flex; align-items:center; gap:4px;" onclick="plannerPickCustomInput('${node.id}')">
                    ${inputDef ? `<img src="img/item${inputDef.id ?? 0}.png" width="18" height="18">` : ''}
                    <span>${selectedItem ? selectedItem : t('Select Input Item')}</span>
                </span>
            </div>${warnHtml}`;
    } else if (rawRecipe.machine === 'Thermal Extractor') {
        const height = DB.settings.thermalExtractorHeight ?? 255;
        const ratio = AlchemyCalcEngine.getThermalExtractorRatio(height);
        controlsHtml = `
            <div class="thermal-height-row">
                <label>${t('Thermal Extractor Height')}</label>
                <div class="thermal-height-input-row">
                    <input type="range" min="0" max="255" step="1" value="${height}"
                        oninput="onPlannerThermalHeightInput(this.value, true)"
                        onchange="onPlannerThermalHeightChange(this.value)">
                    <input type="number" min="0" max="255" step="1" value="${height}" id="planner-thermal-height-numinput"
                        class="thermal-height-numbox"
                        oninput="onPlannerThermalHeightInput(this.value, false)"
                        onchange="onPlannerThermalHeightChange(this.value)">
                </div>
                <div class="thermal-height-info">
                    <span>${t('Height')}: <span id="planner-thermal-height-val">${height}</span></span>
                    <span>${t('Bonus')}: <span id="planner-thermal-height-bonus">${((ratio-1)*100).toFixed(1)}</span>% (<span id="planner-thermal-height-mult">${ratio.toFixed(2)}</span>x ${t('output')})</span>
                </div>
            </div>`;
    }

    return `
        <div>
            <div style="font-weight:bold; color:#eee; margin-bottom:8px;">${t(rawRecipe.machine, 'machines')} ( ${rawRecipe.baseTime} sec )</div>
            <div style="display:flex; align-items:center; flex-wrap:wrap; gap:4px;">
                <span style="display:flex; flex-wrap:wrap; gap:4px;">${inputsHtml || `<em style="font-size:0.8em;color:#666;">—</em>`}</span>
                <span style="color:#666; margin:0 4px;">→</span>
                <span style="display:flex; flex-wrap:wrap; gap:4px;">${outputsHtml}</span>
            </div>
            ${controlsHtml}
        </div>`;
}

function _plannerFormatIOList(ioObj) {
    const entries = Object.entries(ioObj || {});
    if (entries.length === 0) return '';
    return entries.map(([name, qty]) => {
        const d = DB.items[name] || {};
        const qtyNum = typeof qty === 'number' ? qty : (parseFloat(qty) || 0);
        const qtyStr = Number.isInteger(qtyNum) ? qtyNum : Number(qtyNum.toFixed(3));
        return `<span style="display:inline-flex; align-items:center; gap:2px;" title="${name} ×${qtyStr}">
            <img src="img/item${d.id ?? 0}.png" width="20" height="20">
            <span style="font-size:0.75em; color:var(--accent); font-weight:bold;">×${qtyStr}</span>
        </span>`;
    }).join('');
}

/** List every recipe that outputs mainOut (same group as the node's recipe); clicking one switches the node's recipeId */
function _buildPlannerNodeRecipeSwitchHtml(node, mainOut) {
    const candidates = getRecipesFor(mainOut);
    if (!candidates || candidates.length === 0) {
        return `<div class="planner-picker-empty">${t('No recipes found', 'ui')}</div>`;
    }
    return candidates.map(r => {
        const isActive = r.id === node.recipeId;
        const inputIcons = Object.keys(r.inputs || {}).map(name => {
            const d = DB.items[name] || {};
            return `<img src="img/item${d.id ?? 0}.png" width="18" height="18" title="${name}">`;
        }).join('');
        const inputs = r.customInputSlot ? '<span style="width:18px; height:18px; text-align: center;">?</span>' : inputIcons;
        const outDef = DB.items[mainOut] || {};
        const machineIconSrc = `img/machines/${r.machine.toLowerCase().replaceAll(' ', '-')}.png`;
        const activeStyle = isActive
            ? 'background:rgba(76,175,80,0.12); border:1px solid var(--accent);'
            : 'border:1px solid transparent;';
        return `
            <div class="planner-picker-row" style="${activeStyle}" onclick="plannerSwitchNodeRecipe('${node.id}','${r.id}')">
                <div class="planner-picker-flow">
                    ${inputs}<span class="planner-picker-arrow">→</span><img src="img/item${outDef.id ?? 0}.png" width="20" height="20">
                </div>
                <span class="planner-picker-machine">
                    <img src="${machineIconSrc}" width="18" height="18" onerror="this.style.opacity='0'">${t(r.machine, 'machines')}
                </span>
                ${isActive ? '<span style="color:var(--accent); font-weight:bold; margin-left:4px;">✓</span>' : ''}
            </div>`;
    }).join('');
}

/** Refresh the modal content + node cards/edges/summary panel, and save */
function _plannerNodeModalRefresh(nodeId) {    
    recomputeAndRefreshPlanner();
    renderPlannerNodeModalBody(nodeId);
    savePlannerState();
}

function plannerToggleCatalyst(nodeId, catalystId) {
    const node = plannerState.nodes[nodeId];
    if (!node) return;
    if (!node.recipeModifiers) node.recipeModifiers = {};
    if (!node.recipeModifiers.catalysts) node.recipeModifiers.catalysts = [];
    const cats = node.recipeModifiers.catalysts;
    const idx = cats.indexOf(catalystId);
    if (idx >= 0) cats.splice(idx, 1); else cats.push(catalystId);
    if (cats.length === 0) delete node.recipeModifiers.catalysts;
    if (node.recipeModifiers && Object.keys(node.recipeModifiers).length === 0) delete node.recipeModifiers;
    _plannerNodeModalRefresh(nodeId);
}

function plannerPickCustomInput(nodeId) {
    const node = plannerState.nodes[nodeId];
    if (!node) return;
    const originalSelectItem = window.selectItem;
    window.selectItem = (name) => {
        if (!node.recipeModifiers) node.recipeModifiers = {};
        node.recipeModifiers.customInput = name;
        window.selectItem = originalSelectItem;
        closeModal('picker-modal');
        _plannerNodeModalRefresh(nodeId);
    };
    openItemPicker();
}

function onPlannerThermalHeightInput(val, fromSlider) {
    let height = parseInt(val);
    if (isNaN(height)) height = 0;
    height = Math.max(0, Math.min(255, height));

    const slider = document.querySelector('.thermal-height-row input[type=range]');
    const numbox = document.getElementById('planner-thermal-height-numinput');
    if (fromSlider) { if (numbox) numbox.value = height; }
    else { if (slider) slider.value = height; }

    const ratio = AlchemyCalcEngine.getThermalExtractorRatio(height);
    document.getElementById('planner-thermal-height-val').innerText = height;
    document.getElementById('planner-thermal-height-bonus').innerText = ((ratio - 1) * 100).toFixed(1);
    document.getElementById('planner-thermal-height-mult').innerText = ratio.toFixed(2);
}

function onPlannerThermalHeightChange(val) {
    let height = parseInt(val);
    if (isNaN(height)) height = 0;
    height = Math.max(0, Math.min(255, height));
    DB.settings.thermalExtractorHeight = height;
    persist();
    recomputeAndRefreshPlanner();
    savePlannerState();
    calculate();
}

/** Switch the node's recipe (picked from the old recipe's mainOut group). Catalysts/custom inputs are tied to a recipe id,
 *  so the node's recipeModifiers are reset. plannerResolveFlows() removes edges that become invalid. */
function plannerSwitchNodeRecipe(nodeId, recipeId) {
    const node = plannerState.nodes[nodeId];
    if (!node || node.recipeId === recipeId) return;
    node.recipeId = recipeId;
    delete node.recipeModifiers;
    renderPlannerNodeModalBody(nodeId);
    renderPlanner();
    savePlannerState();
}

/**
 * For each connected port of the node, compute the target rate it should meet:
 * for every edge on the port, sum (the edge's current flow + the remaining amount at the other end's port).
 * Skips ports where |target - port.rate| is tiny (already satisfied).
 * Returns { item, target, current, delta, newMachineCount } entries the buttons can apply, split into inputs/outputs.
 */
function _plannerGetNodeMismatchButtons(node, flows) {
    const ports = flows.nodePortsCache[node.id];
    if (!ports) return { inputs: [], outputs: [] };

    const rates = plannerGetNodeRates(node);
    const perMachineRateOf = { in: {}, out: {} };
    if (rates) {
        rates.inputsPerMachine.forEach(p => { perMachineRateOf.in[p.item] = p.rate; });
        rates.outputsPerMachine.forEach(p => { perMachineRateOf.out[p.item] = p.rate; });
    }

    function buildList(portList, dir) {
        const list = [];
        portList.forEach(port => {
            const key = plannerPortKey(node.id, port.item, dir);
            const edgeIds = flows.portConnections[key] || [];
            if (edgeIds.length === 0) return; // Not connected, skip

            let target = 0;
            edgeIds.forEach(eid => {
                const edge = plannerState.edges[eid];
                if (!edge) return;
                const flow = flows.edgeFlow[eid] || 0;
                const otherKey = dir === 'out'
                    ? plannerPortKey(edge.toNode, port.item, 'in')
                    : plannerPortKey(edge.fromNode, port.item, 'out');
                const otherRemaining = flows.portRemaining[otherKey] || 0;
                target += flow + otherRemaining;
            });

            const delta = target - port.rate;
            if (Math.abs(delta) < 0.001) return;

            const perMachineRate = perMachineRateOf[dir][port.item] || 0;
            if (perMachineRate <= 0) return; // Without a per-machine rate the machine count change can't be derived

            let newMachineCount = node.machineCount + delta / perMachineRate;
            newMachineCount = Math.max(0, newMachineCount);
            if (Math.abs(newMachineCount - node.machineCount) < 0.0001) return;

            list.push({ item: port.item, target, current: port.rate, delta, newMachineCount });
        });
        return list;
    }

    return { inputs: buildList(ports.inputs, 'in'), outputs: buildList(ports.outputs, 'out') };
}

/** HTML for the "Satisfy connections" section; empty string (section hidden) if no port on either side needs adjusting */
function _buildPlannerNodeMismatchSectionHtml(node, flows) {
    const { inputs, outputs } = _plannerGetNodeMismatchButtons(node, flows);
    if (inputs.length === 0 && outputs.length === 0) return '';

    const buildBtn = (entry) => {
        const def = DB.items[entry.item] || {};
        const deltaColor = entry.delta >= 0 ? 'var(--profit)' : 'var(--danger)';
        const sign = entry.delta >= 0 ? '+' : '';
        return `<button class="planner-mismatch-btn" data-node="${node.id}" data-new-mc="${entry.newMachineCount}"
                    onmouseenter="onPlannerMismatchHover(this,true)" onmouseleave="onPlannerMismatchHover(this,false)"
                    onclick="plannerApplyPortMismatch(this)">
                <img src="img/item${def.id ?? 0}.png" width="16" height="16">
                <span>${entry.item}</span>
                <span style="color:${deltaColor}; font-weight:bold; flex-shrink:0;">${formatVal(entry.target)}/m (${sign}${formatVal(entry.delta)})</span>
            </button>`;
    };

    const inputsHtml = inputs.length ? inputs.map(buildBtn).join('') : `<div class="planner-picker-empty" style="padding:6px 0;">${t('None', 'ui')}</div>`;
    const outputsHtml = outputs.length ? outputs.map(buildBtn).join('') : `<div class="planner-picker-empty" style="padding:6px 0;">${t('None', 'ui')}</div>`;

    return `
        <div style="height:1px; background:var(--border); margin:12px 0;"></div>
        <div class="planner-mismatch-section">
            <div style="font-size:0.78em; color:#888; text-transform:uppercase; letter-spacing:0.05em; margin-bottom:6px;">
                ${t('Port Balance', 'ui')}
            </div>
            <div style="display:flex; gap:10px;">
                <div style="flex:1; display:flex; flex-direction:column; gap:4px; min-width:0;">${inputsHtml}</div>
                <div style="flex:1; display:flex; flex-direction:column; gap:4px; min-width:0;">${outputsHtml}</div>
            </div>
            <div style="display:flex; justify-content:space-between; align-items:center; margin-top:8px; padding-top:6px; border-top:1px dashed var(--border); font-size:0.82em; color:#aaa;">
                <span>${t('Machine Count', 'ui')}: <strong style="color:#eee;">${Number(node.machineCount.toFixed(4))}</strong></span>
                <span id="planner-mismatch-mc-preview-${node.id}" style="font-weight:bold;"></span>
            </div>
        </div>`;
}

/** On button hover, show in the brackets at the bottom how much the machine count would change */
function onPlannerMismatchHover(btn, show) {
    const nodeId = btn.dataset.node;
    const el = document.getElementById('planner-mismatch-mc-preview-' + nodeId);
    if (!el) return;
    if (!show) { el.innerText = ''; return; }

    const node = plannerState.nodes[nodeId];
    const newMc = parseFloat(btn.dataset.newMc);
    if (!node || isNaN(newMc)) return;

    const delta = newMc - node.machineCount;
    const sign = delta >= 0 ? '+' : '';
    el.innerText = `(${sign}${Number(delta.toFixed(4))})`;
    el.style.color = delta >= 0 ? 'var(--profit)' : 'var(--danger)';
}

/** On click: set machineCount to the precomputed target (may go up or down) */
function plannerApplyPortMismatch(btn) {
    const nodeId = btn.dataset.node;
    const node = plannerState.nodes[nodeId];
    if (!node) return;
    const newMc = parseFloat(btn.dataset.newMc);
    if (isNaN(newMc)) return;
    node.machineCount = Math.max(0, newMc);
    _plannerNodeModalRefresh(nodeId);
}


/* ==========================================================================
   SECTION: Edge Modal (click the label / the edge itself)
   ========================================================================== */

function openPlannerEdgeModal(edgeId) {
    const edge = plannerState.edges[edgeId];
    if (!edge) return;
    const flows = plannerResolveFlows();
    const flow = flows.edgeFlow[edgeId] || 0;
    const itemDef = DB.items[edge.item] || {};
    const fromNode = plannerState.nodes[edge.fromNode];
    const toNode = plannerState.nodes[edge.toNode];

    function _getNodeTitle(node) {
        if (!node) return ``;
        if (node.recipeId) {
            const recipe = getRecipeById(node.recipeId);
            const main = plannerMainOutput(node.recipeId);
            return recipe && recipe.machine ? `<img src='img/machines/${recipe.machine.toLowerCase().replaceAll(' ', '-')}.png' width="18" height="18"> ${t(recipe.machine, 'machines')} (${main ?? '?'})` : `?`;
        }
        if (node.moduleId) {
            const plan = plannerLibrary.plans[node.moduleId];
            return plan ? plan.name : t('Missing Reference', 'ui');
        }
        return '?';
    }

    /** Render the priority rows for one direction (out = supplier priority / in = consumer priority); empty string when there are no sibling edges (siblings <= 1) */
    function _buildPlannerEdgePriorityRowHtml(edgeId, nodeId, item, dir, label) {
        const siblings = plannerGetSiblingEdges(nodeId, item, dir);
        if (siblings.length <= 1) return '';
        const idx = siblings.findIndex(e => e.id === edgeId);
        const rank = idx + 1;
        const total = siblings.length;
        return `
            <span style="margin-left:auto"></span>
            <span style="align-items:center; gap:8px; margin-left:auto">
                <span>${label}: ${rank} / ${total}</span>
                <button class="swap-btn" ${idx === 0 ? 'disabled' : ''}
                    onclick="plannerMoveEdgePriority('${edgeId}','${dir}',-1)">▲</button>
                <button class="swap-btn" ${idx === total - 1 ? 'disabled' : ''}
                    onclick="plannerMoveEdgePriority('${edgeId}','${dir}',1)">▼</button>
            </span>`;
    }

    document.getElementById('planner-edge-modal-title').innerHTML =
        `<img src="img/item${itemDef.id ?? 0}.png" width="18" height="18" style="vertical-align:middle;"> ${edge.item}`;

    const plannerEdgeLinkModeNoteText = _plannerLinkMode ?
        t('Link mode ON: also scales upstream/downstream nodes', 'ui') :
        t('Link mode OFF: only affects source and target nodes', 'ui');

    const priorityRowsHtml = [
        _buildPlannerEdgePriorityRowHtml(edgeId, edge.fromNode, edge.item, 'out', t('Source Priority', 'ui')),
        _buildPlannerEdgePriorityRowHtml(edgeId, edge.toNode, edge.item, 'in', t('Target Priority', 'ui'))
    ].filter(Boolean).join('');

    document.getElementById('planner-edge-modal-body').innerHTML = `
        <div style="padding:12px; display:flex; flex-direction:column; gap:8px; font-size:0.9em;">
            <div style="display:flex; gap:4px;"><strong>${t('Source', 'ui')}: </strong> ${_getNodeTitle(fromNode)} ${_buildPlannerEdgePriorityRowHtml(edgeId, edge.fromNode, edge.item, 'out', t('Priority', 'ui'))}</div>
            <div style="display:flex; gap:4px;"><strong>${t('Target', 'ui')}: </strong> ${_getNodeTitle(toNode)} ${_buildPlannerEdgePriorityRowHtml(edgeId, edge.toNode, edge.item, 'in', t('Priority', 'ui'))}</div>
            <div style="margin-top:8px;"><strong>${t('Current Flow', 'ui')}:</strong> <span id="planner-edge-modal-current-flow">${formatVal(flow)}</span>/min</div>
            <div style="display:flex; align-items:center; gap:8px;">
                <span>${t('Set Flow', 'ui')}:</span>
                <input type="number" min="0" step="any" id="planner-edge-flow-input"
                       value="${Number(flow.toFixed(4))}"
                       style="flex:1; padding:5px 8px; background:#2a2a2a; border:1px solid #555; border-radius:4px; color:#fff;"
                       onchange="plannerApplyEdgeFlowInput('${edgeId}', this)">
                <span>/min</span>
            </div>
            <div style="display:flex; align-items:center; gap:6px; font-size:1em; color:#999; font-style:italic;">
                <button class="planner-link-btn ${_plannerLinkMode ? 'active' : ''}"
                        onclick="togglePlannerLinkMode(); openPlannerEdgeModal('${edgeId}');"
                        title="${t('Link machine count changes', 'ui')}">
                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M9 17H7A5 5 0 0 1 7 7h2"/>
                    <path d="M15 7h2a5 5 0 1 1 0 10h-2"/>
                    <line x1="8" y1="12" x2="16" y2="12"/>
                    </svg>
                </button>
                <span class="planner-edge-linkmode-note">${plannerEdgeLinkModeNoteText}</span>
            </div>
            <div style="height:1px; background:var(--border); margin:12px 0;"></div>
            <div style="display:flex; align-items:center; gap:8px;">
                <span>${t('Color', 'ui')}:</span>
                <input type="color" value="${edge.color || '#4caf50'}" style="boarder:0px;"
                       onchange="plannerSetEdgeColor('${edgeId}', this.value)">
                <button class="split-btn" style="margin-top:0px; font-size:0.9em; width: auto"
                        onclick="plannerClearEdgeColor('${edgeId}')">${t('Reset', 'ui')}</button>
                <div class="push-right"></div>
                <button class="split-btn" style="margin-top:0px; font-size:0.9em; width:auto;" title="${t('Tip: Alt+click a line to place the dot exactly where you click', 'ui')}"
                        onclick="closeModal('planner-edge-modal'); plannerInsertWaypointOnEdge('${edgeId}')">📍 ${t('Add Reroute Dot', 'ui')}</button>
                <button class="reset-btn" style="margin-top:0px; font-size:1em; width: 30%" onclick="deletePlannerEdge('${edgeId}')">${t('Delete Connection', 'ui')}</button>
            </div>            
        </div>
    `;
    document.getElementById('planner-edge-modal').style.display = 'flex';
}

function plannerSetEdgeColor(edgeId, color) {
    const edge = plannerState.edges[edgeId];
    if (!edge) return;
    edge.color = color;
    recomputeAndRefreshPlanner();
    savePlannerState();
}

function plannerClearEdgeColor(edgeId) {
    const edge = plannerState.edges[edgeId];
    if (!edge) return;
    delete edge.color;
    recomputeAndRefreshPlanner();
    savePlannerState();
}

function deletePlannerEdge(edgeId) {
    delete plannerState.edges[edgeId];
    closeModal('planner-edge-modal');
    recomputeAndRefreshPlanner();
    savePlannerState();
}

/**
 * Given the flow F the user wants on this edge, adjust the fromNode/toNode machineCount
 * to supply/consume exactly F (plus the current flow of the other edges on that port).
 * Allocation priority still follows createdAt, so if the port has older edges,
 * the recalculated flow may differ a little from F (an acceptable approximation).
 */
function plannerApplyEdgeFlowInput(edgeId, inputEl) {
    const edge = plannerState.edges[edgeId];
    if (!edge) return;
    const targetFlow = Math.max(0, parseFloat(inputEl.value) || 0);

    const flows = _plannerLastFlows || plannerResolveFlows();
    const fromNode = plannerState.nodes[edge.fromNode];
    const toNode = plannerState.nodes[edge.toNode];
    const oldFromCount = fromNode ? fromNode.machineCount : null;
    const oldToCount = toNode ? toNode.machineCount : null;

    function otherEdgesFlowSum(nodeId, dir) {
        const key = plannerPortKey(nodeId, edge.item, dir);
        const edgeIds = flows.portConnections[key] || [];
        let sum = 0;
        edgeIds.forEach(eid => {
            if (eid === edgeId) return;
            sum += flows.edgeFlow[eid] || 0;
        });
        return sum;
    }

    if (fromNode) {
        const rates = plannerGetNodeRates(fromNode);
        const perMachineRate = rates ? (rates.outputsPerMachine.find(p => p.item === edge.item) || {}).rate || 0 : 0;
        if (perMachineRate > 0) {
            const newRate = otherEdgesFlowSum(edge.fromNode, 'out') + targetFlow;
            fromNode.machineCount = Math.max(0, newRate / perMachineRate);
        }
    }

    if (toNode) {
        const rates = plannerGetNodeRates(toNode);
        const perMachineRate = rates ? (rates.inputsPerMachine.find(p => p.item === edge.item) || {}).rate || 0 : 0;
        if (perMachineRate > 0) {
            const newRate = otherEdgesFlowSum(edge.toNode, 'in') + targetFlow;
            toNode.machineCount = Math.max(0, newRate / perMachineRate);
        }
    }

    // Link mode: apply fromNode's change ratio to its upstream and toNode's ratio to its downstream.
    // Nodes in both sets (e.g. loops) are excluded so the ratio isn't applied twice.
    if (_plannerLinkMode) {
        const upstreamIds = fromNode ? getPlannerUpstreamNodeIds(edge.fromNode) : new Set();
        const downstreamIds = toNode ? getPlannerDownstreamNodeIds(edge.toNode) : new Set();
        upstreamIds.delete(edge.fromNode);
        downstreamIds.delete(edge.toNode);
        const intersection = new Set([...upstreamIds].filter(id => downstreamIds.has(id)));
        intersection.forEach(id => { upstreamIds.delete(id); downstreamIds.delete(id); });

        if (fromNode && oldFromCount > 0 && fromNode.machineCount !== oldFromCount && upstreamIds.size > 0) {
            const ratio = fromNode.machineCount / oldFromCount;
            upstreamIds.forEach(id => {
                const n = plannerState.nodes[id];
                if (n) n.machineCount = Math.max(0, n.machineCount * ratio);
            });
        }
        if (toNode && oldToCount > 0 && toNode.machineCount !== oldToCount && downstreamIds.size > 0) {
            const ratio = toNode.machineCount / oldToCount;
            downstreamIds.forEach(id => {
                const n = plannerState.nodes[id];
                if (n) n.machineCount = Math.max(0, n.machineCount * ratio);
            });
        }
    }

    const newFlows = recomputeAndRefreshPlanner();
    savePlannerState();

    // Refresh the modal with the actual recalculated flow (may differ slightly from the input)
    const actualFlow = newFlows.edgeFlow[edgeId] || 0;
    const flowLabel = document.getElementById('planner-edge-modal-current-flow');
    if (flowLabel) flowLabel.innerText = formatVal(actualFlow);
    inputEl.value = Number(actualFlow.toFixed(4));
}

/* ==========================================================================
   SECTION: Recipe menu for adding a node by dragging to empty canvas
   ========================================================================== */

let _plannerPickerContext = null;
let _plannerPickerCandidates = [];
let _plannerPickerFiltered = [];

function getRecipesConsuming(item) {
    return (DB.recipes || []).filter(r => r.inputs && r.inputs[item] !== undefined);
}

function openPlannerRecipePickerMenu(ctx) {
    _plannerPickerContext = ctx;
    const consuming = ctx.originDir === 'out'; // Dragged from an output -> recipes that consume the item; from an input -> recipes that produce it
    const candidates = consuming ? getRecipesConsuming(ctx.item) : getRecipesFor(ctx.item);

    _plannerPickerCandidates = candidates.map(r => {
        const mainOut = Object.keys(r.outputs)[0];
        const mainOutName = mainOut;
        const machineName = t(r.machine, 'machines');
        return {
            recipe: getRecipeById(r.id, DB.settings.recipeModifiers[r?.id]) || r,
            mainOut,
            mainOutName,
            machineName,
            machineKey: r.machine,
            searchBlob: (mainOut + ' ' + r.machine + ' ' + mainOutName + ' ' + machineName).toLowerCase()
        };
    });

    closePlannerRecipePickerMenu();
    const panel = document.createElement('div');
    panel.id = 'planner-recipe-picker';
    panel.className = 'planner-recipe-picker';
    document.body.appendChild(panel);

    const headerText = `${t(consuming ? 'CONSUME' : 'PRODUCE', 'ui')} <span style="color:var(--info); font-weight:bold;">${ctx.item}</span>`;

    panel.innerHTML = `
        <div class="planner-picker-header">${headerText}</div>
        <div style="display:flex; gap:5px; margin-bottom:5px;">
            <button class="split-btn" style="flex:1;" onclick="choosePlannerWaypointFromPicker()">+ 📍 Waypoint</button>
            <button class="split-btn" style="flex:1;" onclick="choosePlannerPortalFromPicker()" title="${t(consuming ? 'Send this output to an external portal (sink)' : 'Supply this input from an external portal (source)', 'ui')}">+ 🌀 Portal</button>
        </div>
        <input type="text" class="planner-picker-search" placeholder="${t('Search...', 'ui')}"
               oninput="filterPlannerRecipePicker(this.value)">
        <div class="planner-picker-list" id="planner-picker-list"></div>
    `;

    positionPlannerFloatingPanel(panel, ctx.clientX, ctx.clientY);
    renderPlannerRecipePickerList('');
    panel.querySelector('.planner-picker-search').focus();

    setTimeout(() => document.addEventListener('mousedown', _onPlannerPickerOutsideClick), 0);
}

function positionPlannerFloatingPanel(panel, clientX, clientY) {
    const w = 320, h = 420;
    let left = clientX, top = clientY;
    if (left + w > window.innerWidth) left = window.innerWidth - w - 10;
    if (top + h > window.innerHeight) top = window.innerHeight - h - 10;
    panel.style.left = Math.max(10, left) + 'px';
    panel.style.top = Math.max(10, top) + 'px';
}

function _onPlannerPickerOutsideClick(e) {
    const panel = document.getElementById('planner-recipe-picker');
    if (panel && !panel.contains(e.target)) closePlannerRecipePickerMenu();
}

function closePlannerRecipePickerMenu() {
    const panel = document.getElementById('planner-recipe-picker');
    if (panel) panel.remove();
    document.removeEventListener('mousedown', _onPlannerPickerOutsideClick);
}

function filterPlannerRecipePicker(text) {
    renderPlannerRecipePickerList((text || '').toLowerCase());
}

function renderPlannerRecipePickerList(filterText) {
    const list = document.getElementById('planner-picker-list');
    if (!list) return;
    _plannerPickerFiltered = _plannerPickerCandidates.filter(c => !filterText || c.searchBlob.includes(filterText));

    if (_plannerPickerFiltered.length === 0) {
        list.innerHTML = `<div class="planner-picker-empty">${t('No matching recipes', 'ui')}</div>`;
        return;
    }

    list.innerHTML = _plannerPickerFiltered.map((c, idx) => {
        if (!c.recipe) return;
        const inputIcons = Object.keys(c.recipe.inputs || {}).map(name => {
            const d = DB.items[name] || {};
            return `<img src="img/item${d.id ?? 0}.png" width="18" height="18" title="${name}">`;
        }).join('');
        const inputs = c.recipe.customInputSlot ? '<span style="width:18px; height:18px; text-align: center;">?</span>' : inputIcons;
        const outDef = DB.items[c.mainOut] || {};
        const machineIconSrc = `img/machines/${c.machineKey.toLowerCase().replaceAll(' ', '-')}.png`;
        return `
            <div class="planner-picker-row" onclick="choosePlannerRecipeFromPicker(${idx})">
                <div class="planner-picker-flow">
                    ${inputs}<span class="planner-picker-arrow">→</span><img src="img/item${outDef.id ?? 0}.png" width="20" height="20">
                </div>
                <span class="planner-picker-name">${c.mainOutName}</span>
                <span class="planner-picker-machine">
                    <img src="${machineIconSrc}" width="18" height="18" onerror="this.style.opacity='0'">${c.machineName}
                </span>
            </div>`;
    }).join('');
}

function choosePlannerRecipeFromPicker(idx) {
    const candidate = _plannerPickerFiltered[idx];
    if (!candidate || !_plannerPickerContext) return;
    createPlannerNodeFromPicker(candidate, _plannerPickerContext);
    closePlannerRecipePickerMenu();
}

/**
 * After a recipe is picked from the menu, create a new node and connect it to the dragged line.
 * The machine count is derived so the new node's input/output for this item equals the available flow.
 */
function createPlannerNodeFromPicker(candidate, ctx) {
    const recipe = candidate.recipe;
    const consuming = ctx.originDir === 'out';
    const targetRate = plannerGetAvailableRateAtPort(ctx.sourceNodeId, ctx.item, ctx.originDir);

    const recipeModifiers = DB.settings.recipeModifiers[recipe.id];
    const rates = plannerGetRecipeRates(recipe.id, recipeModifiers);
    const portList = consuming ? rates.inputsPerMachine : rates.outputsPerMachine;
    const perMachineRate = (portList.find(p => p.item === ctx.item) || {}).rate || 0;

    let machineCount = (perMachineRate > 0 && targetRate > 0) ? targetRate / perMachineRate : 1;
    machineCount = Math.max(0.000001, machineCount);

    plannerState._nodeSeq = (plannerState._nodeSeq || 0) + 1;
    const nodeId = 'pnode_' + plannerState._nodeSeq;
    plannerState.nodes[nodeId] = {
        id: nodeId, recipeId: recipe.id, recipeModifiers: recipeModifiers, machineCount,
        x: plannerSnapVal(Math.round(ctx.graphX - 115)), y: plannerSnapVal(Math.round(ctx.graphY - 40))
    };

    plannerState._edgeSeq = (plannerState._edgeSeq || 0) + 1;
    const edgeId = 'pedge_' + plannerState._edgeSeq;
    const fromNode = consuming ? ctx.sourceNodeId : nodeId;
    const toNode = consuming ? nodeId : ctx.sourceNodeId;
    plannerState.edges[edgeId] = { id: edgeId, item: ctx.item, fromNode, toNode, createdAt: plannerState._edgeSeq };

    renderPlanner();
    savePlannerState();
}

/* ==========================================================================
   SECTION: Rate Per Machine Tooltip 
   ========================================================================== */

/** Build the hover tooltip HTML from plannerGetNodeRates() */
function buildPlannerRateTooltipHtml(rates) {
    if (!rates) return '';

    const rowHtml = (item, qty, color) => {
        const def = DB.items[item] || {};
        const plusSign = qty > 0 ? '+' : '';
        return `<div class="planner-rate-tooltip-row">
            <span class="planner-rate-tooltip-qty" style="color:${color}">${plusSign}${formatVal(qty)}</span>
            <img src="img/item${def.id ?? 0}.png">
            <span class="planner-rate-tooltip-name">${item}</span>
        </div>`;
    };

    let html = '';
    if (rates.inputsPerMachine.length > 0) {
        html += rates.inputsPerMachine.map(p => rowHtml(p.item, -p.rate, '#e0e0e0')).join('');
    }
    if (rates.outputsPerMachine.length > 0) {
        if (html) html += `<div class="planner-rate-tooltip-divider"></div>`;
        html += rates.outputsPerMachine.map(p => rowHtml(p.item, p.rate, '#00e676')).join('');
    }
    if (html) html += `<div class="planner-rate-tooltip-divider"></div>`;
    Object.entries(rates.heatByItem || {}).forEach(([fuelName, r]) => {
        if (r > 0.0001) html += rowHtml('🔥 ' + fuelName, -r, '#ff5722');
    });
    if (rates.fertItemsPerMachine > 0.0001) {
        html += rowHtml(plannerEnergy().fert, -rates.fertItemsPerMachine, '#76ff03');
    }
    if (rates.goldCostPerMachine > 0.0001) {
        html += `<div class="planner-rate-tooltip-row">
            <span class="planner-rate-tooltip-qty" style="color:var(--gold)">-${formatVal(rates.goldCostPerMachine)}</span>
            <img src="img/copper.png">
            <span class="planner-rate-tooltip-name">${t('Coin', 'ui')}</span>
        </div>`;
        html += `<div class="planner-rate-tooltip-divider"></div>`;
    }

    html += `<div class="planner-rate-tooltip-footer">${t('per machine (/min)', 'ui')}</div>`;
    return html;
}

function showPlannerRateTooltip(anchorEl, rates) {
    hidePlannerRateTooltip();
    if (!rates) return;

    const tip = document.createElement('div');
    tip.id = 'planner-rate-tooltip';
    tip.className = 'planner-rate-tooltip';
    tip.innerHTML = buildPlannerRateTooltipHtml(rates);
    document.body.appendChild(tip);

    const rect = anchorEl.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();
    let left = rect.left;
    let top = rect.top - tipRect.height - 6;
    if (left + tipRect.width > window.innerWidth) left = window.innerWidth - tipRect.width - 8;
    if (top < 4) top = rect.bottom + 6; // Not enough room above, show it below
    tip.style.left = Math.max(4, left) + 'px';
    tip.style.top = top + 'px';
}

function hidePlannerRateTooltip() {
    const tip = document.getElementById('planner-rate-tooltip');
    if (tip) tip.remove();
}

/* ==========================================================================
   SECTION: Edge Hover Tooltip (Item / Rate / Belt)
   ========================================================================== */

let _plannerEdgeTooltipSize = null; // Cached {width, height} to avoid a reflow on every mousemove

/** Edge hover tooltip HTML: item name, current flow, belts needed (optional) */
function buildPlannerEdgeTooltipHtml(itemName, flow, beltCount) {
    const def = DB.items[itemName] || {};
    let html = `<div class="planner-rate-tooltip-row">
        <img src="img/item${def.id ?? 0}.png">
        <span class="planner-rate-tooltip-name">${itemName}</span>
    </div>`;
    html += `<div class="planner-rate-tooltip-row">
        <span class="planner-rate-tooltip-qty" style="color:var(--profit)">${formatVal(flow)}</span>
        <span class="planner-rate-tooltip-name">/min</span>
    </div>`;
    if (beltCount !== null && beltCount !== undefined) {
        html += `<div class="planner-rate-tooltip-row">
            <span class="planner-rate-tooltip-qty" style="color:var(--belt-count)">${beltCount.toFixed(2)}</span>
            <span class="planner-rate-tooltip-name">${t('Belt', 'ui')}</span>
        </div>`;
    }
    return html;
}

/** Show the edge hover tooltip following the cursor (same CSS class as showPlannerRateTooltip, positioned by mouse) */
function showPlannerEdgeTooltip(evt, itemName, flow, beltCount) {
    hidePlannerRateTooltip();
    const tip = document.createElement('div');
    tip.id = 'planner-rate-tooltip';
    tip.className = 'planner-rate-tooltip';
    tip.innerHTML = buildPlannerEdgeTooltipHtml(itemName, flow, beltCount);
    document.body.appendChild(tip);
    _plannerEdgeTooltipSize = { width: tip.offsetWidth, height: tip.offsetHeight }; // Measured only once
    _positionPlannerEdgeTooltip(evt);
}

/** Make the tooltip follow the cursor while moving over an edge */
function movePlannerEdgeTooltip(evt) {
    if (!document.getElementById('planner-rate-tooltip')) return;
    _positionPlannerEdgeTooltip(evt);
}

function _positionPlannerEdgeTooltip(evt) {
    const tip = document.getElementById('planner-rate-tooltip');
    if (!tip || !_plannerEdgeTooltipSize) return;
    const offset = 14;
    const { width, height } = _plannerEdgeTooltipSize;
    let left = evt.clientX + offset;
    let top = evt.clientY + offset;
    if (left + width > window.innerWidth) left = evt.clientX - width - offset;
    if (top + height > window.innerHeight) top = evt.clientY - height - offset;
    tip.style.left = Math.max(4, left) + 'px';
    tip.style.top = Math.max(4, top) + 'px';
}

/** On edge hover end, reuse hidePlannerRateTooltip() to remove the container */
function hidePlannerEdgeTooltip() {
    hidePlannerRateTooltip();
}

/* ==========================================================================
   SECTION: SUMMARY PANEL (top-left overlay)
   ========================================================================== */

function _injectPlannerSummaryStyles() {
    if (document.getElementById('planner-summary-styles')) return;
    const s = document.createElement('style');
    s.id = 'planner-summary-styles';
    s.textContent = `
        .planner-summary-panel {
            position: absolute; top: 14px; left: 14px; z-index: 50;
            width: 240px; max-height: calc(100% - 28px);
            background: rgba(26,26,26,0.95); border: 1px solid var(--border,#444);
            border-radius: 6px; box-shadow: 0 4px 14px rgba(0,0,0,0.45);
            display: flex; flex-direction: column; overflow: hidden;
            font-size: 0.85em;
        }
        .planner-summary-panel.collapsed { width: auto; background: transparent; border: none; box-shadow: none; }
        .planner-summary-min-btn {
            background: rgba(26,26,26,0.95); border: 1px solid var(--border,#444); color: #ddd;
            border-radius: 6px; padding: 7px 12px; cursor: pointer; font-size: 0.95em;
            box-shadow: 0 4px 14px rgba(0,0,0,0.45);
        }
        .planner-summary-min-btn:hover { border-color: var(--accent); color: #fff; }
        .planner-summary-header {
            display: flex; align-items: center; justify-content: space-between;
            padding: 8px 10px; border-bottom: 1px solid var(--border,#444);
            flex-shrink: 0; background: #202020; cursor: pointer;
        }
        .planner-summary-title { font-weight: bold; color: #eee; letter-spacing: 0.03em; text-transform: uppercase; font-size: 0.85em; }
        .planner-summary-close-btn:hover { color: #fff; }
        .planner-summary-body { overflow-y: auto; padding: 4px 0; }
        .planner-summary-section { border-bottom: 1px solid #2e2e2e; }
        .planner-summary-section:last-child { border-bottom: none; }
        .planner-summary-section-header {
            display: flex; align-items: center; gap: 6px;
            padding: 7px 10px; cursor: pointer; user-select: none;
            color: #ccc; font-weight: bold;
        }
        .planner-summary-section-header:hover { background: #262626; }
        .planner-summary-arrow { font-size: 0.75em; color: #888; width: 10px; flex-shrink: 0; }
        .planner-summary-count {
            margin-left: auto; background: #333; color: #aaa; border-radius: 8px;
            padding: 0 7px; font-size: 0.8em; font-weight: normal;
        }
        .planner-summary-section-body { padding: 2px 10px 8px 10px; }
        .planner-summary-row {
            display: flex; align-items: center; gap: 6px;
            padding: 3px 0; font-size: 0.95em; color: #ddd;
        }
        .planner-summary-row span:nth-child(2) { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .planner-summary-val { font-weight: bold; flex-shrink: 0; }
        .planner-summary-empty { color: #666; font-style: italic; font-size: 0.9em; padding: 2px 0; }
    `;
    document.head.appendChild(s);
}

function ensurePlannerSummaryPanel() {
    let panel = document.getElementById('planner-summary-panel');
    if (panel) return panel;
    const canvas = document.getElementById('planner-canvas');
    if (!canvas) return null;
    panel = document.createElement('div');
    panel.id = 'planner-summary-panel';
    panel.className = 'planner-summary-panel';
    canvas.appendChild(panel);
    return panel;
}

function togglePlannerSummaryPanel() {
    _plannerSettings.summaryCollapsed = !_plannerSettings.summaryCollapsed;    
    renderPlannerSummary(_plannerLastFlows);
    savePlannerSettings();
}

function togglePlannerSummarySection(key) {
    _plannerSettings.summarySectionCollapsed[key] = !_plannerSettings.summarySectionCollapsed[key];    
    renderPlannerSummary(_plannerLastFlows);
    savePlannerSettings();
}

/** Coin value of one item, same rule as the Calculator's heating cost: custom cost, else buy price, else base cost */
function plannerItemUnitPrice(item) {
    const custom = DB.settings.customCosts?.[item];
    if (typeof custom === 'number' && custom > 0) return custom;
    const def = DB.items[item] || {};
    return def.buyPrice || def.baseCost || 0;
}

/** Summary from flows: money/fuel/fertilizer use, machine counts, output surplus, input shortfall */
function computePlannerSummaryStats(flows) {
    const machineCounts = {};
    let heatTotal = 0, fertTotal = 0, goldTotal = 0, steamTotal = 0;
    const heatByItem = {};

    Object.values(plannerState.nodes).forEach(node => {
        const ports = flows.nodePortsCache[node.id];
        if (!ports) return;
        if (ports.recipe && node.machineCount > 0) {
            const count = Math.ceil(node.machineCount - 0.000001);
            machineCounts[ports.recipe.machine] = (machineCounts[ports.recipe.machine] || 0) + count;
        }
        heatTotal += ports.heatItemsPerMin || 0;
        Object.entries(ports.heatByItem || {}).forEach(([item, r]) => { heatByItem[item] = (heatByItem[item] || 0) + r; });
        fertTotal += ports.fertItemsPerMin || 0;
        goldTotal += ports.goldCostPerMin || 0;
        if (node.kind !== 'waypoint' && node.kind !== 'portal') {
            steamTotal += (ports.inputs.find(p => p.item === 'Steam') || {}).rate || 0;
        }
    });

    const outputSurplus = {};
    const inputShortage = {};
    Object.keys(flows.portRemaining).forEach(key => {
        const val = flows.portRemaining[key];
        if (!(val > 0.001)) return;
        const parts = key.split('::'); // nodeId::item::dir
        const item = parts[1];
        const dir = parts[2];
        if (dir === 'out') outputSurplus[item] = (outputSurplus[item] || 0) + val;
        else if (dir === 'in') inputShortage[item] = (inputShortage[item] || 0) + val;
    });

    Object.entries(inputShortage).forEach(([item, qty]) => {
        const def = DB.items[item];
        if (def && def.buyPrice) goldTotal += def.buyPrice * qty;
    });

    return { machineCounts, heatTotal, heatByItem, fertTotal, steamTotal, outputSurplus, inputShortage, goldTotal };
}

function renderPlannerSummary(flows) {
    const panel = ensurePlannerSummaryPanel();
    if (!panel) return;
    flows = flows || plannerResolveFlows();

    if (_plannerSettings.summaryCollapsed) {
        panel.classList.add('collapsed');
        panel.innerHTML = `<button class="planner-summary-min-btn" onclick="togglePlannerSummaryPanel()">☰ ${t('Summary', 'ui')}</button>`;
        return;
    }
    panel.classList.remove('collapsed');

    const stats = computePlannerSummaryStats(flows);

    const sectionHtml = (key, titleHtml, bodyHtml, count) => {
        const collapsed = _plannerSettings.summarySectionCollapsed[key];
        return `
            <div class="planner-summary-section">
                <div class="planner-summary-section-header" onclick="togglePlannerSummarySection('${key}')">
                    <span class="planner-summary-arrow">${collapsed ? '▶' : '▼'}</span>
                    <span>${titleHtml}</span>
                    ${count != null ? `<span class="planner-summary-count">${count}</span>` : ''}
                </div>
                ${collapsed ? '' : `<div class="planner-summary-section-body">${bodyHtml}</div>`}
            </div>`;
    };

    // --- Section 1: Cost & Resources ---
    let costRows = '';
    if (stats.goldTotal > 0.0001) {
        costRows += `<div class="planner-summary-row"><img src="img/copper.png" class="item-icon-small"><span>${t('Coin', 'ui')}</span><span class="planner-summary-val" style="color:var(--gold);">${Math.ceil(stats.goldTotal).toLocaleString()}/m</span></div>`;
    }
    if (stats.fertTotal > 0.0001) {
        const fertName = plannerEnergy().fert;
        const fertDef = DB.items[fertName] || {};
        costRows += `<div class="planner-summary-row"><img src="img/item${fertDef.id ?? 0}.png" class="item-icon-small"><span>${fertName}</span><span class="planner-summary-val" style="color:var(--bio);">${formatVal(stats.fertTotal)}/m</span></div>`;
    }
    if (!costRows) costRows = `<div class="planner-summary-empty">${t('None', 'ui')}</div>`;

    // --- Heating: fuel burned (materials) + its coin value ---
    const heatEntries = Object.entries(stats.heatByItem).filter(([, r]) => r > 0.0001).sort((a, b) => b[1] - a[1]);
    let heatRows = '', heatCoins = 0, heatCoinsKnown = true;
    heatEntries.forEach(([item, rate]) => {
        const def = DB.items[item] || {};
        const price = plannerItemUnitPrice(item);
        if (price > 0) heatCoins += rate * price; else heatCoinsKnown = false;
        heatRows += `<div class="planner-summary-row" title="${price > 0 ? `${formatVal(price)} coins each` : 'No coin value known'}"><img src="img/item${def.id ?? 0}.png" class="item-icon-small"><span>${item}</span><span class="planner-summary-val" style="color:var(--fuel);">${formatVal(rate)}/m</span></div>`;
    });
    if (stats.steamTotal > 0.0001) {
        // Steam Boiler (High): 300 Steam / 2s base -> 9000 Steam/min per boiler at speed x1
        const boilers = stats.steamTotal / (9000 * getSpeedMult(DB.settings.lvlSpeed || 0));
        heatRows += `<div class="planner-summary-row" title="${t('Total Steam consumed by heated machines', 'ui')}"><img src="img/item9002.png" class="item-icon-small"><span>${t('Steam')}</span><span class="planner-summary-val" style="color:var(--fuel);">${formatVal(stats.steamTotal)}/m <span style="color:var(--warn); font-weight:normal;">(≈${boilers.toFixed(2)} ${t('Steam Boiler', 'machines')})</span></span></div>`;
        // Steam not supplied inside this plan: value it as the plan's fuel burned in boilers
        const steamShort = stats.inputShortage['Steam'] || 0;
        if (steamShort > 0.0001) {
            const fuelName = plannerEnergy().fuel;
            const fuelHeat = (DB.items[fuelName]?.heat || 0) * (1 + (DB.settings.lvlFuel || 0) * 0.10);
            const price = plannerItemUnitPrice(fuelName);
            if (fuelHeat > 0 && price > 0) heatCoins += steamShort * PLANNER_STEAM_HEAT_VALUE / fuelHeat * price;
            else heatCoinsKnown = false;
        }
    }
    if (heatRows) {
        heatRows += `<div class="planner-summary-row" title="Coin value of the fuel burned for heating per minute (unsupplied Steam valued as ${plannerEnergy().fuel} burned in Steam Boilers)${heatCoinsKnown ? '' : '. Some fuel has no known coin value.'}"><img src="img/copper.png" class="item-icon-small"><span>${t('Coin', 'ui')}${heatCoinsKnown ? '' : ' (partial)'}</span><span class="planner-summary-val" style="color:var(--gold);">≈${Math.ceil(heatCoins).toLocaleString()}/m</span></div>`;
    } else {
        heatRows = `<div class="planner-summary-empty">${t('None', 'ui')}</div>`;
    }

    // --- Section 2: Machines ---
    const machineEntries = Object.entries(stats.machineCounts).sort((a, b) => b[1] - a[1]);
    let machineRows = machineEntries.map(([name, count]) => {
        const icon = `<img src="img/machines/${name.toLowerCase().replaceAll(' ', '-')}.png" class="item-icon-small" onerror="this.style.opacity='0'">`;
        return `<div class="planner-summary-row">${icon}<span>${t(name, 'machines')}</span><span class="planner-summary-val">${count}</span></div>`;
    }).join('');
    if (!machineRows) machineRows = `<div class="planner-summary-empty">${t('None', 'ui')}</div>`;

    // --- Section 3: Output surplus ---
    const outputEntries = Object.entries(stats.outputSurplus).sort((a, b) => b[1] - a[1]);
    let outputRows = outputEntries.map(([item, qty]) => {
        const def = DB.items[item] || {};
        return `<div class="planner-summary-row"><img src="img/item${def.id ?? 0}.png" class="item-icon-small"><span>${item}</span><span class="planner-summary-val" style="color:var(--profit);">${formatVal(qty)}/m</span></div>`;
    }).join('');
    if (!outputRows) outputRows = `<div class="planner-summary-empty">${t('None', 'ui')}</div>`;

    // --- Section 4: Input shortage ---
    const inputEntries = Object.entries(stats.inputShortage).sort((a, b) => b[1] - a[1]);
    let inputRows = inputEntries.map(([item, qty]) => {
        const def = DB.items[item] || {};
        return `<div class="planner-summary-row"><img src="img/item${def.id ?? 0}.png" class="item-icon-small"><span>${item}</span><span class="planner-summary-val" style="color:var(--danger);">${formatVal(qty)}/m</span></div>`;
    }).join('');
    if (!inputRows) inputRows = `<div class="planner-summary-empty">${t('None', 'ui')}</div>`;

    panel.innerHTML = `
        <div class="planner-summary-header" onclick="togglePlannerSummaryPanel()">
            <span>☰ ${t('Summary', 'ui')}</span>
        </div>
        <div class="planner-summary-body">
            ${sectionHtml('cost', t('Total Load', 'ui'), costRows)}
            ${sectionHtml('heating', '🔥 ' + t('Cost of Heating', 'ui'), heatRows)}
            ${sectionHtml('output', t('Output', 'ui'), outputRows, outputEntries.length)}
            ${sectionHtml('input', t('Input', 'ui'), inputRows, inputEntries.length)}            
            ${sectionHtml('machines', t('Machines', 'ui'), machineRows, machineEntries.reduce((s, [, c]) => s + c, 0))}
        </div>
    `;
}

function choosePlannerWaypointFromPicker() {
    if (!_plannerPickerContext) return;
    createPlannerWaypointFromPicker(_plannerPickerContext);
    closePlannerRecipePickerMenu();
}

function choosePlannerPortalFromPicker() {
    if (!_plannerPickerContext) return;
    const ctx = _plannerPickerContext;
    // Size the portal to exactly the flow available at the port we dragged from.
    const rate = plannerGetAvailableRateAtPort(ctx.sourceNodeId, ctx.item, ctx.originDir);
    createPlannerWaypointFromPicker(ctx, 'portal', rate > 0.001 ? rate : 1);
    closePlannerRecipePickerMenu();
}

function createPlannerWaypointFromPicker(ctx, kind = 'waypoint', machineCount = 1) {
    const itemName = ctx.item;
    plannerState._nodeSeq = (plannerState._nodeSeq || 0) + 1;
    const newNodeId = 'pnode_' + plannerState._nodeSeq;

    const isPortal = kind === 'portal';
    plannerState.nodes[newNodeId] = {
        id: newNodeId, kind, portalItem: itemName, machineCount,
        // portals are full-size cards: offset so the card (not its corner) lands at the cursor
        x: Math.round(isPortal ? (ctx.originDir === 'out' ? ctx.graphX : ctx.graphX - 200) : ctx.graphX),
        y: Math.round(isPortal ? ctx.graphY - 20 : ctx.graphY)
    };

    plannerState._edgeSeq = (plannerState._edgeSeq || 0) + 1;
    const newEdgeId = 'pedge_' + plannerState._edgeSeq;

    const edge = { id: newEdgeId, item: itemName, createdAt: plannerState._edgeSeq };
    if (ctx.originDir === 'out') {
        edge.fromNode = ctx.sourceNodeId;
        edge.toNode = newNodeId;
    } else {
        edge.fromNode = newNodeId;
        edge.toNode = ctx.sourceNodeId;
    }
    plannerState.edges[newEdgeId] = edge;

    renderPlanner(); // full render: recomputeAndRefreshPlanner() only patches existing node DOM, so the new node would not appear
    savePlannerState();
}

/**
 * Balance every recipe/module node upstream of targetId so it makes exactly what its consumers need.
 * targetId, portals and nodes outside the upstream set keep their machine count (they are the fixed demand/supply).
 *
 * Handles loops (a node feeding itself, e.g. Coke fuelling the crucible that makes it, or longer cycles):
 * fixed-point iteration  x_i = max over outputs p of (demand on p / output rate per machine),
 * with demand taken from the consumers' current counts. Starting from 0 it converges to the smallest
 * self-consistent solution; a loop that consumes more than it produces never settles and is reported.
 *
 * Several suppliers of one consumer port split its need evenly, after subtracting what fixed suppliers
 * (portals, the target) already deliver. Waypoint chains are followed through to the real nodes.
 * Returns { ok } and writes machineCount only when ok.
 */
function _calculateNodeDemand(targetId) {
    const nodes = plannerState.nodes;
    const edges = Object.values(plannerState.edges);
    const isWp = id => nodes[id]?.kind === 'waypoint';
    const upstream = getPlannerUpstreamNodeIds(targetId);
    const vars = [...upstream].filter(id => {
        const n = nodes[id];
        return id !== targetId && n && (n.kind === 'recipe' || n.kind === 'module' || !n.kind);
    });
    if (!vars.length) return { ok: true };
    const varSet = new Set(vars);

    const ratesCache = {};
    const rates = id => (id in ratesCache) ? ratesCache[id] : (ratesCache[id] = nodes[id] ? plannerGetNodeRates(nodes[id]) : null);
    const perMachine = (id, item, dir) => {
        const r = rates(id);
        if (!r || r.errorCode) return 0;
        return ((dir === 'in' ? r.inputsPerMachine : r.outputsPerMachine).find(p => p.item === item) || {}).rate || 0;
    };

    // Virtual edges between real nodes (waypoint chains collapsed), like plannerResolveFlows does
    const outEdgesOf = {};
    edges.forEach(e => { (outEdgesOf[e.fromNode] = outEdgesOf[e.fromNode] || []).push(e); });
    const vEdges = [];
    edges.forEach(e => {
        if (isWp(e.fromNode)) return;
        if (!isWp(e.toNode)) { vEdges.push({ from: e.fromNode, to: e.toNode, item: e.item }); return; }
        const sinks = new Set();
        const walk = (wpId, visited) => (outEdgesOf[wpId] || []).forEach(n => {
            if (n.item !== e.item || visited.has(n.toNode)) return;
            if (isWp(n.toNode)) walk(n.toNode, new Set([...visited, n.toNode]));
            else if (!sinks.has(n.toNode)) { sinks.add(n.toNode); vEdges.push({ from: e.fromNode, to: n.toNode, item: e.item }); }
        });
        walk(e.toNode, new Set([e.toNode]));
    });

    // Per consumer port: the variable suppliers, and what fixed suppliers already deliver
    const outDegree = {}; // "from::item" -> number of consumers it feeds
    vEdges.forEach(v => { const k = v.from + '::' + v.item; outDegree[k] = (outDegree[k] || 0) + 1; });
    const ports = {}; // "to::item" -> { to, item, varSuppliers, fixedSupply }
    vEdges.forEach(v => {
        const k = v.to + '::' + v.item;
        const port = ports[k] = ports[k] || { to: v.to, item: v.item, varSuppliers: [], fixedSupply: 0 };
        if (varSet.has(v.from)) port.varSuppliers.push(v.from);
        else port.fixedSupply += perMachine(v.from, v.item, 'out') * (nodes[v.from]?.machineCount || 0) / outDegree[v.from + '::' + v.item];
    });
    const portList = Object.values(ports).filter(p => p.varSuppliers.length);

    const x = {};
    vars.forEach(id => { x[id] = 0; });
    const count = id => varSet.has(id) ? x[id] : (nodes[id]?.machineCount || 0);

    let converged = false;
    for (let iter = 0; iter < 200000; iter++) {
        const demand = {}; // "var::item" -> items/min it must deliver
        portList.forEach(p => {
            const need = Math.max(0, perMachine(p.to, p.item, 'in') * count(p.to) - p.fixedSupply);
            const share = need / p.varSuppliers.length;
            p.varSuppliers.forEach(sup => { const k = sup + '::' + p.item; demand[k] = (demand[k] || 0) + share; });
        });
        let maxDiff = 0, maxX = 0;
        vars.forEach(id => {
            const r = rates(id);
            let req = 0;
            if (r && !r.errorCode) r.outputsPerMachine.forEach(o => {
                if (o.rate > 0) req = Math.max(req, (demand[id + '::' + o.item] || 0) / o.rate);
            });
            maxDiff = Math.max(maxDiff, Math.abs(req - x[id]) / Math.max(1, req));
            maxX = Math.max(maxX, req);
            x[id] = req;
        });
        if (maxDiff < 1e-13) { converged = true; break; }
        if (!isFinite(maxX) || maxX > 1e9) break;
    }
    if (!converged) return { ok: false };

    vars.forEach(id => { nodes[id].machineCount = x[id]; });
    return { ok: true };
}

function plannerAutoBalanceUpstream(nodeId) {
    if (!plannerState.nodes[nodeId]) return;
    const res = _calculateNodeDemand(nodeId);
    if (!res.ok) {
        alert('Could not balance: a loop upstream uses more of an item than it produces, so it can never feed itself.');
        return;
    }
    recomputeAndRefreshPlanner();
    savePlannerState();
    
    const upstreamIds = [...getPlannerUpstreamNodeIds(nodeId)].filter(id => id !== nodeId);
    flashPlannerLinkFeedback(nodeId, upstreamIds);
    closeModal('planner-node-modal');
}
