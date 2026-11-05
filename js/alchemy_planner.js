/* ==========================================================================
   SECTION: PLANNER TAB
   Model and Canvas
   ========================================================================== */

const PLANNER_LIBRARY_KEY = "alchemy_planner_library_v1";
const PLANNER_SETTINGS_KEY = "alchemy_planner_settings_v1";

/**
 * plannerLibrary: container for all plans; written to localStorage as a whole.
 * {
 *   activePlanId: string,
 *   planOrder: string[],           // plan id display order (the dropdown and manager list both use it)
 *   plans: { [planId]: { id, name, updatedAt, data } }
 * }
 * Each plan.data has the structure of what used to be the single plannerState:
 * { nodes, edges, viewport, _edgeSeq, _nodeSeq, gridSize }
 */
let plannerLibrary = {
    activePlanId: null,
    planOrder: [],
    plans: {}
};

// plannerState always references the data object of the active plan;
let plannerState = null;

/* ==========================================================================
   SECTION: DATA STRUCTURE REFERENCE
   ==========================================================================

   plannerState (== plannerLibrary.plans[activePlanId].data):
   {
       nodes: {
           [nodeId]: {
               id: string,              // "pnode_<seq>"
               kind: 'recipe' | 'module' | 'note' | 'portal', // Node type
               recipeId: string | null,      // Recipe node: matches DB.recipes[recipeId].id
               moduleId: string | null,      // Module node: points to plannerLibrary.plans[moduleId]
               recipeModifiers: object, // Optional, e.g. advanced machine catalyst settings (snapshot of DB.settings.recipeModifiers)
               machineCount: number,    // Number of machines in this node, may be fractional
               x: number,               // Top-left corner of the node in graph space
               y: number
           }
       },
       edges: {
           [edgeId]: {
               id: string,       // "pedge_<seq>"
               item: string,     // Item carried by this edge (English key)
               fromNode: string, // Source node id (the item leaves through its output port)
               toNode: string,   // Target node id (enters through its input port)
               createdAt: number // Value of plannerState._edgeSeq at creation; decides flow allocation priority
           }
       },
       _edgeSeq: number,  // Auto-increment counter for edgeIds and createdAt ordering
       _nodeSeq: number,  // Auto-increment counter for nodeIds
       
   }

   A node's ports (input/output connection points) aren't stored on the node object; they're computed
   on the fly by computeNodePorts(node) from node.recipeId + node.machineCount:
   { recipe, inputs: [{item, rate}], outputs: [{item, rate}], heatItemsPerMin, fertItemsPerMin }

   Note nodes also have text/color/w/h; portal nodes also have portalItem/machineCount.
   Nodes have no width/height fields; the card size comes from CSS (.planner-node is 200px wide, height depends on the number of ports, heat/fert rows etc.),
   so read offsetWidth/offsetHeight from document.getElementById('planner-node-' + id) when needed.
   
   ========================================================================== */


/*
    Planner Settings (runtime state)
    viewport: { x: number, y: number, zoom: number }, // Canvas pan/zoom state
    gridSize: number   // 0 = no snapping; otherwise the snap grid size in pixels (see PLANNER_GRID_STEPS)
*/

let _plannerSettings = {
    viewport: { x: 0, y: 0, zoom: 1 },
    gridSize: 40,
    edgeStyle: 0,   // 0 = animated dash (default), 1 = static chevron
    summaryCollapsed: false,
    summarySectionCollapsed: {
        cost: false,
        output: false,
        input: false,
        machines: true
    }
};
let _plannerLastFlows = null; // Cached result of the last resolveFlows() (for redrawing edges while dragging nodes)
let _plannerCanvasHovered = false;
let _plannerLinkMode = 'none';
let _plannerSelectMode = false;
let _plannerSelectedNodeIds = new Set();
const PLANNER_ZOOM_MIN = 0.2;
const PLANNER_ZOOM_MAX = 3;
const PLANNER_GRID_STEPS = [40, 20, 0];

/** Per-plan viewport cache (in memory for this session only, not written to localStorage).
 *  key: planId -> { x, y, zoom }. Remembers where you left each plan when switching between plans. */
let _plannerViewportCache = {};
const _noteSaveTimers = new Map();

/**
 * plannerHistory: separate undo/redo stacks per plan, in memory only (not written to localStorage).
 * { [planId]: { stack: [ deep-cloned plan.data, ... ], index: number } }
 * index points to the current snapshot in stack; stack[0] is always the plan's state when first loaded this session.
 */
let plannerHistory = {};
const PLANNER_HISTORY_LIMIT = 10;

/* ---------------- INIT / PERSISTENCE ---------------- */

function initPlannerPage() {
    _injectPlannerSummaryStyles();
    loadPlannerLibrary();
    loadPlannerSettings();
    renderPlannerToolbarSelect();
    renderPlannerHeatSelect();
    _plannerViewportCache[plannerLibrary.activePlanId] = { ..._plannerSettings.viewport };

    renderPlanner();
    attachPlannerCanvasPan();
    attachPlannerPortDragHandlers();
    attachPlannerBoxSelect();
    attachPlannerWheelZoom();
    attachPlannerPinchZoom();
    attachPlannerKeyboardShortcuts();
    updatePlannerGridButton();
    updatePlannerGridBackground();    
    updatePlannerEdgeStyleButton();
    updatePlannerUndoRedoButtons();
}

// Read the global UI settings
function loadPlannerSettings() {
    try {
        const saved = JSON.parse(localStorage.getItem(PLANNER_SETTINGS_KEY) || '{}');

        _plannerSettings.viewport = {
            x: saved.viewport?.x ?? 0,
            y: saved.viewport?.y ?? 0,
            zoom: saved.viewport?.zoom ?? 1
        };

        _plannerSettings.gridSize = saved.gridSize ?? 0;
        _plannerSettings.edgeStyle = saved.edgeStyle ?? 0;

        // Read the summary collapsed state
        _plannerSettings.summaryCollapsed = saved.summaryCollapsed ?? false;
        _plannerSettings.summarySectionCollapsed = {
            cost: saved.summarySectionCollapsed?.cost ?? false,
            output: saved.summarySectionCollapsed?.output ?? false,
            input: saved.summarySectionCollapsed?.input ?? false,
            machines: saved.summarySectionCollapsed?.machines ?? true
        };
    } catch {
        _plannerSettings = {
            viewport: { x: 0, y: 0, zoom: 1 },
            gridSize: 0,
            edgeStyle: 0,
            summaryCollapsed: false,
            summarySectionCollapsed: {
                cost: false,
                output: false,
                input: false,
                machines: true
            }
        };
    }    
}

// Write the global UI settings
function savePlannerSettings() {
    localStorage.setItem(
        PLANNER_SETTINGS_KEY,
        JSON.stringify(_plannerSettings)
    );
}

/** Create a brand-new, empty plan data object (the initial plannerState) */
function _createEmptyPlanData() {
    return { nodes: {}, edges: {}, viewport: { x: 0, y: 0, zoom: 1 }, _edgeSeq: 0, _nodeSeq: 0, gridSize: 0 };
}

/** Create a new plan entry (with meta: id/name/updatedAt) */
function _createPlan(name) {
    const id = 'plan_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
    return { id, name: name || t('New Plan', 'ui'), updatedAt: Date.now(), data: _createEmptyPlanData() };
}

/** Load the whole plan library; if missing or corrupt, create a default empty plan */
function loadPlannerLibrary() {
    const saved = localStorage.getItem(PLANNER_LIBRARY_KEY);
    if (saved) {
        try {
            plannerLibrary = JSON.parse(saved);
        } catch (e) {
            console.error("Planner library corrupt, resetting.", e);
            plannerLibrary = null;
        }
    }

    if (!plannerLibrary || !plannerLibrary.plans || Object.keys(plannerLibrary.plans).length === 0) {
        const plan = _createPlan(t('Default Plan', 'ui'));
        plannerLibrary = { activePlanId: plan.id, planOrder: [plan.id], plans: { [plan.id]: plan } };
    }
    if (!plannerLibrary.planOrder || plannerLibrary.planOrder.length === 0) {
        plannerLibrary.planOrder = Object.keys(plannerLibrary.plans);
    }
    if (!plannerLibrary.activePlanId || !plannerLibrary.plans[plannerLibrary.activePlanId]) {
        plannerLibrary.activePlanId = plannerLibrary.planOrder[0];
    }

    // Fill in node kinds missing from older saves
    Object.values(plannerLibrary.plans).forEach(plan => {
        Object.values(plan.data.nodes || {}).forEach(node => {
            if (!node.kind) node.kind = node.moduleId ? 'module' : 'recipe';
        });
    });

    _activatePlanData(plannerLibrary.activePlanId);
}

/** Point plannerState at the given plan's data and fill in missing fields */
function _activatePlanData(planId) {
    const plan = plannerLibrary.plans[planId];
    if (!plan) return;
    plannerState = plan.data;
    _plannerLastFlows = null;
    _plannerSelectedNodeIds.clear();
    _ensurePlannerHistory(planId);
}

/** Save only the library structure (plan list/order/selection); not counted as a content edit */
function savePlannerLibraryMeta() {
    localStorage.setItem(PLANNER_LIBRARY_KEY, JSON.stringify(plannerLibrary));
}

/** Save content changes of the active plan; also updates its updatedAt and pushes the undo history */
function savePlannerState() {
    const plan = plannerLibrary.plans[plannerLibrary.activePlanId];
    if (plan) plan.updatedAt = Date.now();
    _pushPlannerHistory(plannerLibrary.activePlanId);
    savePlannerLibraryMeta();
    updatePlannerUndoRedoButtons();
}

/* ==========================================================================
   SECTION: UNDO / REDO (per-plan, in-memory only)
   ========================================================================== */

/** If the plan has no history stack yet, create an initial snapshot (index 0) from its current state */
function _ensurePlannerHistory(planId) {
    if (plannerHistory[planId]) return;
    plannerHistory[planId] = {
        stack: [JSON.parse(JSON.stringify(plannerLibrary.plans[planId].data))],
        index: 0
    };
}

/** Push a deep copy of plannerState onto the history stack; after an undo, drop the redo branch first */
function _pushPlannerHistory(planId) {
    _ensurePlannerHistory(planId);
    const hist = plannerHistory[planId];
    hist.stack = hist.stack.slice(0, hist.index + 1);
    hist.stack.push(JSON.parse(JSON.stringify(plannerState)));
    if (hist.stack.length > PLANNER_HISTORY_LIMIT) {
        hist.stack.shift(); // Over the limit (10), drop the oldest
    }
    hist.index = hist.stack.length - 1;
}

/** Update the disabled state of the toolbar Undo/Redo buttons from the history position */
function updatePlannerUndoRedoButtons() {
    const hist = plannerHistory[plannerLibrary.activePlanId];
    const undoBtn = document.getElementById('planner-undo-btn');
    const redoBtn = document.getElementById('planner-redo-btn');
    if (undoBtn) undoBtn.disabled = !hist || hist.index <= 0;
    if (redoBtn) redoBtn.disabled = !hist || hist.index >= hist.stack.length - 1;
}

/** Restore the snapshot at the given history position as the plan data and redraw (doesn't push history) */
function _restorePlannerHistorySnapshot(planId, hist) {
    const snapshot = hist.stack[hist.index];
    const restored = JSON.parse(JSON.stringify(snapshot));
    plannerLibrary.plans[planId].data = restored;
    plannerLibrary.plans[planId].updatedAt = Date.now();
    plannerState = restored;
    _plannerLastFlows = null;

    // Selection is transient UI state and isn't part of history; just prune ids
    // that no longer exist in the restored snapshot so they don't linger forever.
    [..._plannerSelectedNodeIds].forEach(id => {
        if (!plannerState.nodes[id]) _plannerSelectedNodeIds.delete(id);
    });

    renderPlanner();
    updatePlannerGridButton();
    updatePlannerGridBackground();
    applyPlannerViewportTransform();
    updatePlannerUndoRedoButtons();
    savePlannerLibraryMeta(); // Restoring isn't a new edit, so don't push history
}

function plannerUndo() {
    const planId = plannerLibrary.activePlanId;
    const hist = plannerHistory[planId];
    if (!hist || hist.index <= 0) return;
    hist.index--;
    _restorePlannerHistorySnapshot(planId, hist);
    hidePlannerRateTooltip();
}

function plannerRedo() {
    const planId = plannerLibrary.activePlanId;
    const hist = plannerHistory[planId];
    if (!hist || hist.index >= hist.stack.length - 1) return;
    hist.index++;
    _restorePlannerHistorySnapshot(planId, hist);
    hidePlannerRateTooltip();
}

/* ---------------- COORDINATE HELPERS ---------------- */

function plannerScreenToGraph(clientX, clientY) {
    const canvas = document.getElementById('planner-canvas');
    const rect = canvas.getBoundingClientRect();
    const zoom = _plannerSettings.viewport.zoom || 1;
    return {
        x: (clientX - rect.left - _plannerSettings.viewport.x) / zoom,
        y: (clientY - rect.top - _plannerSettings.viewport.y) / zoom
    };
}

function applyPlannerViewportTransform() {
    const vp = document.getElementById('planner-viewport');
    const zoom = _plannerSettings.viewport.zoom || 1;
    if (vp) vp.style.transform = `translate(${_plannerSettings.viewport.x}px, ${_plannerSettings.viewport.y}px) scale(${zoom})`;
    updatePlannerGridBackground();
}

/* ==========================================================================
   SECTION: SELECT MODE
   ========================================================================== */

function togglePlannerSelectMode() {
    _plannerSelectMode = !_plannerSelectMode;
    updatePlannerSelectModeButton();
}

function updatePlannerSelectModeButton() {
    const btn = document.getElementById('planner-select-btn');
    if (btn) btn.classList.toggle('active', _plannerSelectMode);
    const canvas = document.getElementById('planner-canvas');
    if (canvas) canvas.classList.toggle('select-mode', _plannerSelectMode);
}

function clearPlannerSelection() {
    if (_plannerSelectedNodeIds.size === 0) return;
    _plannerSelectedNodeIds.clear();
    document.querySelectorAll('.planner-node.selected').forEach(el => el.classList.remove('selected'));
}

/** Shared implementation: drag out a selection rectangle starting at (startX, startY) client coords. */
function _plannerRunBoxSelectDrag(canvas, startX, startY, pointerId) {
    const rect = canvas.getBoundingClientRect();
    const box = document.createElement('div');
    box.className = 'planner-select-box';
    canvas.appendChild(box);

    const updateBox = (x2, y2) => {
        const left = Math.min(startX, x2), top = Math.min(startY, y2);
        const w = Math.abs(x2 - startX), h = Math.abs(y2 - startY);
        box.style.left = (left - rect.left) + 'px';
        box.style.top = (top - rect.top) + 'px';
        box.style.width = w + 'px';
        box.style.height = h + 'px';
        return { left, top, right: left + w, bottom: top + h };
    };
    let lastBounds = updateBox(startX, startY);

    const onMove = (ev) => { lastBounds = updateBox(ev.clientX, ev.clientY); };
    const onUp = () => {
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerup', onUp);
        box.remove();
        applyPlannerBoxSelection(lastBounds);
    };
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
}

function attachPlannerBoxSelect() {
    const canvas = document.getElementById('planner-canvas');
    if (!canvas || canvas.dataset.boxSelectBound) return;
    canvas.dataset.boxSelectBound = "1";

    canvas.addEventListener('pointerdown', (e) => {
        if (!_plannerSelectMode) return;
        if (e.target.closest('.planner-node')) return;
        if (e.target.closest('.planner-view-controls')) return;
        if (e.target.closest('.planner-summary-panel')) return;
        if (e.button !== 0) return;

        e.preventDefault();
        canvas.setPointerCapture(e.pointerId);
        _plannerRunBoxSelectDrag(canvas, e.clientX, e.clientY, e.pointerId);
        hidePlannerRateTooltip();
    });
}

function applyPlannerBoxSelection(bounds) {
    _plannerSelectedNodeIds.clear();
    document.querySelectorAll('.planner-node').forEach(el => {
        const r = el.getBoundingClientRect();
        const hit = r.left < bounds.right && r.right > bounds.left &&
                    r.top < bounds.bottom && r.bottom > bounds.top;
        el.classList.toggle('selected', hit);
        if (hit) _plannerSelectedNodeIds.add(el.id.replace('planner-node-', ''));
    });
}

function deletePlannerSelectedNodes() {
    const ids = [..._plannerSelectedNodeIds];
    if (ids.length === 0) return;
    ids.forEach(id => {
        delete plannerState.nodes[id];
        Object.keys(plannerState.edges).forEach(eid => {
            const e = plannerState.edges[eid];
            if (e.fromNode === id || e.toNode === id) delete plannerState.edges[eid];
        });
    });
    _plannerSelectedNodeIds.clear();
    renderPlanner();
    savePlannerState();
    hidePlannerRateTooltip();
}

/* ==========================================================================
   SECTION: VIEW CONTROLS - ZOOM / GRID SNAP / FIT TO VIEW
   ========================================================================== */

function attachPlannerCanvasPan() {
    const canvas = document.getElementById('planner-canvas');
    if (!canvas || canvas.dataset.panBound) return;
    canvas.dataset.panBound = "1";

    canvas.addEventListener('pointerdown', (e) => {
         if (_plannerSelectMode) return; // Box-select handles it
        if (e.target.closest('.planner-node')) return;
        if (e.target.closest('.planner-edge-group')) return;
        if (e.target.closest('.planner-view-controls')) return;
        if (e.target.closest('.planner-summary-panel')) return;
        if (e.button !== 0) return;

        // --- Shift + drag on empty canvas = temporary box-select ---
        if (e.shiftKey) {
            e.preventDefault();
            canvas.setPointerCapture(e.pointerId);
            _plannerRunBoxSelectDrag(canvas, e.clientX, e.clientY, e.pointerId);
            hidePlannerRateTooltip();
            return;
        }

        canvas.setPointerCapture(e.pointerId);
        canvas.classList.add('panning');
        const startX = e.clientX, startY = e.clientY;
        const originX = _plannerSettings.viewport.x, originY = _plannerSettings.viewport.y;
        let moved = 0;

        const onMove = (ev) => {
            moved = Math.max(moved, Math.hypot(ev.clientX - startX, ev.clientY - startY));
            _plannerSettings.viewport.x = originX + (ev.clientX - startX);
            _plannerSettings.viewport.y = originY + (ev.clientY - startY);
            applyPlannerViewportTransform();
        };
        const onUp = () => {
            canvas.removeEventListener('pointermove', onMove);
            canvas.removeEventListener('pointerup', onUp);
            canvas.classList.remove('panning');
            savePlannerSettings();
            if (moved < 3) clearPlannerSelection();   // A plain click clears the selection
        };
        canvas.addEventListener('pointermove', onMove);
        canvas.addEventListener('pointerup', onUp);        
        hidePlannerRateTooltip();
    });
}

function plannerSetZoom(newZoom, anchorClientX, anchorClientY) {
    const canvas = document.getElementById('planner-canvas');
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const ax = anchorClientX ?? (rect.left + rect.width / 2);
    const ay = anchorClientY ?? (rect.top + rect.height / 2);
    const oldZoom = _plannerSettings.viewport.zoom || 1;

    newZoom = Math.min(PLANNER_ZOOM_MAX, Math.max(PLANNER_ZOOM_MIN, newZoom));
    if (Math.abs(newZoom - oldZoom) < 0.0001) return;

    const graphX = (ax - rect.left - _plannerSettings.viewport.x) / oldZoom;
    const graphY = (ay - rect.top - _plannerSettings.viewport.y) / oldZoom;

    _plannerSettings.viewport.zoom = newZoom;
    _plannerSettings.viewport.x = (ax - rect.left) - graphX * newZoom;
    _plannerSettings.viewport.y = (ay - rect.top) - graphY * newZoom;

    applyPlannerViewportTransform();
    savePlannerSettings();
}

function plannerZoomIn()  { plannerSetZoom((_plannerSettings.viewport.zoom || 1) * 1.2); }
function plannerZoomOut() { plannerSetZoom((_plannerSettings.viewport.zoom || 1) / 1.2); }

function attachPlannerWheelZoom() {
    const canvas = document.getElementById('planner-canvas');
    if (!canvas || canvas.dataset.wheelBound) return;
    canvas.dataset.wheelBound = "1";
    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        plannerSetZoom((_plannerSettings.viewport.zoom || 1) * factor, e.clientX, e.clientY);
    }, { passive: false });
}

function attachPlannerPinchZoom() {
    const canvas = document.getElementById('planner-canvas');
    if (!canvas || canvas.dataset.pinchBound) return;
    canvas.dataset.pinchBound = "1";

    let pinchStartDist = 0;
    let pinchStartZoom = 1;
    let pinchMidpoint = null;

    canvas.addEventListener('touchstart', (e) => {
        if (e.touches.length === 2) {
            e.preventDefault();
            const [t1, t2] = e.touches;
            pinchStartDist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
            pinchStartZoom = _plannerSettings.viewport.zoom || 1;
            pinchMidpoint = { x: (t1.clientX + t2.clientX) / 2, y: (t1.clientY + t2.clientY) / 2 };
        }
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
        if (e.touches.length === 2 && pinchStartDist > 0) {
            e.preventDefault();
            const [t1, t2] = e.touches;
            const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
            const scale = dist / pinchStartDist;
            plannerSetZoom(pinchStartZoom * scale, pinchMidpoint.x, pinchMidpoint.y);
        }
    }, { passive: false });

    canvas.addEventListener('touchend', (e) => {
        if (e.touches.length < 2) pinchStartDist = 0;
    });
}

function attachPlannerKeyboardShortcuts() {
    const canvas = document.getElementById('planner-canvas');
    if (!canvas || canvas.dataset.keyBound) return;
    canvas.dataset.keyBound = "1";

    canvas.addEventListener('mouseenter', () => _plannerCanvasHovered = true);
    canvas.addEventListener('mouseleave', () => _plannerCanvasHovered = false);

    document.addEventListener('keydown', (e) => {
        if (!_plannerCanvasHovered) return;
        const tag = (e.target.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea') return;

        if (e.key === '+' || e.key === '=') { e.preventDefault(); plannerZoomIn(); }
        else if (e.key === '-' || e.key === '_') { e.preventDefault(); plannerZoomOut(); }
        else if (e.key === 'f' || e.key === 'F') { e.preventDefault(); plannerFitToView(); }
        else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); plannerUndo(); }
        else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); plannerRedo(); }        
        else if ((e.key === 'Delete' || e.key === 'Backspace') && _plannerSelectedNodeIds.size > 0) {
            e.preventDefault();
            deletePlannerSelectedNodes();
        }
        else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
            // --- Ctrl/Cmd + A selects all nodes ---        
            e.preventDefault();
            _plannerSelectedNodeIds.clear();
            Object.keys(plannerState.nodes).forEach(id => _plannerSelectedNodeIds.add(id));
            document.querySelectorAll('.planner-node').forEach(el => {
                const id = el.id.replace('planner-node-', '');
                el.classList.toggle('selected', _plannerSelectedNodeIds.has(id));
            });
        }
    });
}

function plannerSnapVal(v) {
    const g = _plannerSettings.gridSize || 0;
    if (!g) return v;
    return Math.round(v / g) * g;
}

function plannerCycleGridSnap() {
    const idx = PLANNER_GRID_STEPS.indexOf(_plannerSettings.gridSize || 0);
    _plannerSettings.gridSize = PLANNER_GRID_STEPS[(idx + 1) % PLANNER_GRID_STEPS.length];
    updatePlannerGridButton();
    updatePlannerGridBackground();
    savePlannerSettings();
}

function updatePlannerGridButton() {
    const btn = document.getElementById('planner-grid-btn');
    if (!btn) return;
    const g = _plannerSettings.gridSize || 0;
    btn.textContent = g ? `⊞${g}` : '⊞';
    btn.title = g ? `Grid Snap: ${g}px` : 'Grid Snap: Off';
    btn.classList.toggle('active', !!g);
}

function updatePlannerGridBackground() {
    const canvas = document.getElementById('planner-canvas');
    if (!canvas) return;
    const g = _plannerSettings.gridSize || 0;
    const zoom = _plannerSettings.viewport.zoom || 1;

    if (!g) {
        canvas.style.backgroundImage = 'radial-gradient(#2a2a2a 1px, transparent 1px)';
        canvas.style.backgroundSize = '24px 24px';
    } else {
        const size = g * zoom;
        canvas.style.backgroundImage =
            'linear-gradient(to right, rgba(255,255,255,0.07) 1px, transparent 1px), ' +
            'linear-gradient(to bottom, rgba(255,255,255,0.07) 1px, transparent 1px)';
        canvas.style.backgroundSize = `${size}px ${size}px`;
    }
    canvas.style.backgroundPosition = `${_plannerSettings.viewport.x}px ${_plannerSettings.viewport.y}px`;
}

function togglePlannerEdgeStyle() {
    _plannerSettings.edgeStyle = _plannerSettings.edgeStyle ? 0 : 1;
    updatePlannerEdgeStyleButton();
    renderPlannerEdges(_plannerLastFlows || plannerResolveFlows());
    savePlannerSettings();
}

function updatePlannerEdgeStyleButton() {
    const btn = document.getElementById('planner-edge-style-btn');
    if (!btn) return;
    const isChevron = _plannerSettings.edgeStyle === 1;
    btn.textContent = isChevron ? '⋙' : '⇢';
    btn.title = isChevron
        ? 'Edge Style: Arrow (static)'
        : 'Edge Style: Dashed (animated)';
}

function plannerFitToView(nodeIds = []) {
    let nodes = Object.values(plannerState.nodes);
    if(nodeIds.length > 0) {
        const nodeIdSet = new Set(nodeIds);
        nodes = nodes.filter(node => nodeIdSet.has(node.id));
    }
    const canvas = document.getElementById('planner-canvas');
    if (!canvas) return;

    if (nodes.length === 0) {
        _plannerSettings.viewport = { x: 0, y: 0, zoom: 1 };
        applyPlannerViewportTransform();
        savePlannerSettings();
        return;
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    nodes.forEach(node => {
        const el = document.getElementById('planner-node-' + node.id);
        const w = el ? el.offsetWidth : 220;
        const h = el ? el.offsetHeight : 120;
        minX = Math.min(minX, node.x);
        minY = Math.min(minY, node.y);
        maxX = Math.max(maxX, node.x + w);
        maxY = Math.max(maxY, node.y + h);
    });

    const PAD = 60;
    minX -= PAD; minY -= PAD; maxX += PAD; maxY += PAD;
    const graphW = Math.max(1, maxX - minX);
    const graphH = Math.max(1, maxY - minY);

    const rect = canvas.getBoundingClientRect();
    let zoom = Math.min(rect.width / graphW, rect.height / graphH);
    zoom = Math.min(PLANNER_ZOOM_MAX, Math.max(PLANNER_ZOOM_MIN, zoom));

    _plannerSettings.viewport.zoom = zoom;
    _plannerSettings.viewport.x = (rect.width - graphW * zoom) / 2 - minX * zoom;
    _plannerSettings.viewport.y = (rect.height - graphH * zoom) / 2 - minY * zoom;

    applyPlannerViewportTransform();
    if (_plannerLastFlows) renderPlannerEdges(_plannerLastFlows);
    savePlannerSettings();
}

/* ---------------- HEAT SOURCE (shared with Calculator "Heating Device") ---------------- */

function renderPlannerHeatSelect() {
    const sel = document.getElementById('planner-heat-select');
    if (!sel) return;
    sel.innerHTML = '';
    Object.entries(DB.machines || {})
        .filter(([, m]) => m.isGenerator)
        .sort(([a], [b]) => a.localeCompare(b))
        .forEach(([name]) => {
            const icon = name === 'Steam Heating Pad' ? '♨' : '🔥';
            sel.appendChild(new Option(`${icon} ${t(name, 'machines')}`, name));
        });
    sel.value = DB.settings.selectedHeatingDevice || 'Stone Furnace';
}

function onPlannerHeatSourceChange(deviceName) {
    DB.settings.selectedHeatingDevice = deviceName;
    const mainSel = document.getElementById('heatingDeviceSelect');
    if (mainSel) {
        mainSel.value = deviceName;
        if (typeof onLogisticsChange === 'function') onLogisticsChange(); // persists + recalculates Calculator tab
    } else if (typeof persist === 'function') {
        persist();
    }
    renderPlanner();
}

/* ---------------- ADD / REMOVE NODES ---------------- */

function onPlannerAddNodeClick() {
    const { graphX, graphY } = _plannerGetCenterGraphPos();
    openPlannerItemPicker(graphX, graphY, 'recipe');
}

function _plannerGetCenterGraphPos() {
    const canvas = document.getElementById('planner-canvas');
    if (!canvas) return { graphX: 0, graphY: 0 };
    const rect = canvas.getBoundingClientRect(), zoom = _plannerSettings.viewport.zoom || 1;
    return { graphX: plannerSnapVal((rect.width / 2 - _plannerSettings.viewport.x) / zoom - 110), graphY: plannerSnapVal((rect.height / 2 - _plannerSettings.viewport.y) / zoom - 60) };
}

function onPlannerAddNoteClick() {
    const { graphX, graphY } = _plannerGetCenterGraphPos();
    plannerState._nodeSeq = (plannerState._nodeSeq || 0) + 1;
    const id = 'pnode_' + plannerState._nodeSeq;
    plannerState.nodes[id] = { id, kind: 'note', text: '', color: '#1a2c32', w: 200, h: 160, x: Math.round(graphX + Math.random() * 20), y: Math.round(graphY + Math.random() * 20) };
    renderPlanner(); savePlannerState();
}

function onPlannerAddPortalClick() {
    const { graphX, graphY } = _plannerGetCenterGraphPos();
    openPlannerItemPicker(graphX, graphY, 'portal');
}

function onPlannerAddWaypointClick() {
    const { graphX, graphY } = _plannerGetCenterGraphPos();
    plannerState._nodeSeq = (plannerState._nodeSeq || 0) + 1;
    const newNodeId = 'pnode_' + plannerState._nodeSeq;
    plannerState.nodes[newNodeId] = {
        id: newNodeId, kind: 'waypoint', portalItem: 'Any', machineCount: 1,
        x: Math.round(graphX + Math.random() * 20), y: Math.round(graphY + Math.random() * 20)
    };
    savePlannerState();
    renderPlanner();
}

function onPlannerCanvasContextMenu(e) {
    if (e.target.closest('.planner-node')) return;
    e.preventDefault();
    const g = plannerScreenToGraph(e.clientX, e.clientY);
    openPlannerItemPicker(g.x - 110, g.y - 20, 'recipe');
}

function openPlannerItemPicker(graphX, graphY, kind) {
    const originalSelectItem = window.selectItem;
    window.selectItem = (name) => {
        window.selectItem = originalSelectItem;
        if (kind === 'recipe' && getRecipesFor(name).length === 0) {
            alert(t('This item has no recipe and cannot be added as a Planner node.', 'ui'));
            return;
        }
        addPlannerNode(name, graphX, graphY, kind);
    };
    openItemPicker();
}

function addPlannerNode(itemName, graphX, graphY, kind = 'recipe') {
    if (kind === 'portal' || kind === 'waypoint') {
        plannerState._nodeSeq = (plannerState._nodeSeq || 0) + 1;
        const id = 'pnode_' + plannerState._nodeSeq;
        plannerState.nodes[id] = { id, kind, portalItem: itemName, machineCount: 1, x: Math.round(graphX + Math.random() * 20), y: Math.round(graphY + Math.random() * 20) };
        renderPlanner(); savePlannerState();
        return;
    }

    const recipe = getActiveRecipe(itemName); // Only read once at creation; later preferred-recipe changes don't affect it
    if (!recipe) return;

    plannerState._nodeSeq = (plannerState._nodeSeq || 0) + 1;
    const id = 'pnode_' + plannerState._nodeSeq;
    plannerState.nodes[id] = {
        id, kind: 'recipe',
        recipeId: recipe.id,
        recipeModifiers: DB.settings?.recipeModifiers?.[recipe.id],
        machineCount: 1,
        x: Math.round(graphX),
        y: Math.round(graphY)
    };
    renderPlanner();
    savePlannerState();
}

function removePlannerNode(nodeId) {
    delete plannerState.nodes[nodeId];
    Object.keys(plannerState.edges).forEach(eid => {
        const e = plannerState.edges[eid];
        if (e.fromNode === nodeId || e.toNode === nodeId) delete plannerState.edges[eid];
    });
    renderPlanner();
    savePlannerState();
    hidePlannerRateTooltip();
}

function onPlannerClearAllClick() {
    if (!plannerState) return;

    const nodeCount = Object.keys(plannerState.nodes).length;
    const edgeCount = Object.keys(plannerState.edges).length;
    if (nodeCount === 0 && edgeCount === 0) return;

    plannerState.nodes = {};
    plannerState.edges = {};
    plannerState._nodeSeq = 0;
    plannerState._edgeSeq = 0;

    _plannerSelectedNodeIds.clear();
    _plannerLastFlows = null;

    renderPlanner();
    savePlannerState();
    hidePlannerRateTooltip();
}

/* ---------------- FULL RENDER ---------------- */

function renderPlanner() {
    const layer = document.getElementById('planner-nodes-layer');
    if (!layer) return;
    const flows = plannerResolveFlows();
    layer.innerHTML = '';
    Object.values(plannerState.nodes).forEach(node => {
        const el = createPlannerNodeEl(node, flows);
        if (_plannerSelectedNodeIds.has(node.id)) el.classList.add('selected');
        layer.appendChild(el);
    });
    applyPlannerViewportTransform();
    renderPlannerEdges(flows);
    updateAllPlannerLinkButtons();
    renderPlannerSummary(flows);
    renderPlannerEmptyHint();
}

/** Light refresh: recompute flows, then patch existing node cards and edges without rebuilding node DOM (keeps drag/input focus) */
function recomputeAndRefreshPlanner() {
    const flows = plannerResolveFlows();
    Object.values(plannerState.nodes).forEach(node => patchPlannerNodeDisplay(node, flows));
    renderPlannerEdges(flows);
    renderPlannerSummary(flows);
    return flows;
}

function createPlannerNodeEl(node, flows) {
    const wrap = document.createElement('div');
    wrap.className = 'planner-node';
    wrap.id = 'planner-node-' + node.id;
    wrap.style.left = node.x + 'px';
    wrap.style.top = node.y + 'px';
    if (node.isDone) { wrap.classList.add('node-done'); wrap.style.backgroundColor = '#2d5a2d'; wrap.style.borderColor = '#4CAF50'; }

    if (node.kind === 'note') return renderPlannerNoteNode(wrap, node);
    if (node.kind === 'portal') return renderPlannerPortalNode(wrap, node, flows);
    if (node.kind === 'waypoint') return renderPlannerWaypointNode(wrap, node, flows);

    const ports = flows.nodePortsCache[node.id] || computeNodePorts(node);
    wrap.innerHTML = ``;

    if (node.recipeId) {
        const heatTag = (ports.needsHeat || ports.heatItemsPerMin > 0) ? 'heat' : '';
        const fertTag = ports.fertItemsPerMin > 0 ? 'fert' : '';
        const goldTag = ports.goldCostPerMin > 0 ? 'gold' : '';
        const machineKey = ports.recipe ? ports.recipe.machine : '';
        const mainOut = ports.recipe ? Object.keys(ports.recipe.outputs)[0] : plannerMainOutput(node.recipeId) || '';
        const machineName = ports.recipe ? t(ports.recipe.machine, 'machines').replace('Advanced', 'Adv.') : t('Invaild Recipe', 'ui');
        const machineIconHtml = machineKey
        ? `<img src="img/machines/${machineKey.toLowerCase().replaceAll(' ', '-')}.png" class="planner-node-icon" onerror="this.style.opacity='0'">`
        : `<span class="planner-node-icon"></span>`;
        wrap.innerHTML += `
            <div class="planner-node-header ${heatTag} ${fertTag} ${goldTag}"
                onmouseenter="onPlannerHeaderHover(this, '${node.id}')"
                onmouseleave="hidePlannerRateTooltip()">
                ${machineIconHtml}
                <span class="planner-node-title">${machineName}</span>            
                <button class="planner-gear-btn ${node.isDone ? 'done-active' : ''}" title="${t('Toggle Done', 'ui')}" style="${node.isDone ? 'color:#4CAF50; font-weight:bold;' : ''}" onclick="event.stopPropagation(); togglePlannerNodeDone('${node.id}')">✔</button>
                <button class="planner-gear-btn" title="${t('Node Settings', 'ui')}" onclick="event.stopPropagation(); openPlannerNodeModal('${node.id}')">⚙</button>
                <button class="planner-close-btn" title="${t('Remove Node', 'ui')}" onclick="removePlannerNode('${node.id}')">✕</button>
            </div>`;
    }
    else {
        const plan = plannerLibrary.plans[node.moduleId];
        const titleName = plan ? plan.name : t('Invalid Module', 'ui');
        wrap.innerHTML += `
        <div class="planner-node-header module" 
            onmouseenter="onPlannerHeaderHover(this, '${node.id}')"
            onmouseleave="hidePlannerRateTooltip()">
            <span class="planner-node-title">${titleName}</span>            
            <button class="planner-gear-btn ${node.isDone ? 'done-active' : ''}" title="${t('Toggle Done', 'ui')}" style="${node.isDone ? 'color:#4CAF50; font-weight:bold;' : ''}" onclick="event.stopPropagation(); togglePlannerNodeDone('${node.id}')">✔</button>
                <button class="planner-gear-btn" title="${t('Node Settings', 'ui')}" onclick="event.stopPropagation(); openPlannerNodeModal('${node.id}')">⚙</button>
            <button class="planner-close-btn" title="${t('Remove Node', 'ui')}" onclick="removePlannerNode('${node.id}')">✕</button>
        </div>`;
    }

    const errorMessage = ports.errorCode ? 
        `<div id="planner-node-error-${node.id}">${t('Error')}: ${t(ports.errorCode)}</div>` : 
        `<span id="planner-node-error-${node.id}"></span>`;
    wrap.innerHTML += `
        <div class="planner-node-body" id="planner-node-body-${node.id}">
            ${errorMessage}
            ${renderPlannerPortsHtml(node, ports, flows)}
            <div class="planner-machine-count-row">
                <button class="planner-gear-btn" title="${t('Auto-generate upstream', 'ui')}" onclick="autoGenerateUpstreamNodes('${node.id}')">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M12 2L6 12h5l-1 8 7-12h-5l1-6z"/>
                    </svg>                
                </button>
                <input type="number" min="0" step="1" value="${Number(node.machineCount.toFixed(3))}"
                    title="${t('Machine Count', 'ui')}"
                    data-mc-for="${node.id}"
                    onfocus="onPlannerMachineCountFocus('${node.id}', this)"
                    onblur="onPlannerMachineCountBlur('${node.id}', this)"
                    oninput="updatePlannerMachineCount('${node.id}', this.value)">
                <button class="planner-link-btn ${_plannerLinkMode ? 'active' : ''}"
                        data-link-for="${node.id}"
                        onclick="togglePlannerLinkMode()"
                        title="${t('Link machine count changes', 'ui')}">                        
                            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M9 17H7A5 5 0 0 1 7 7h2"/>
                            <path d="M15 7h2a5 5 0 1 1 0 10h-2"/>
                            <line x1="8" y1="12" x2="16" y2="12"/>
                            </svg>                        
                        </button>
            </div>
            <div class="planner-heatfert-row" id="planner-heatfert-${node.id}">
                ${renderPlannerHeatFertHtml(ports, node)}
            </div>
        </div>
    `;

    attachPlannerNodeDrag(wrap, node);
    return wrap;
}

function _plannerEscapeHtml(value) {
    return String(value ?? '').replace(/[&<>\"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '\"':'&quot;', "'":'&#39;' }[c]));
}

function renderPlannerNoteNode(wrap, node) {
    wrap.className += ' planner-note-node';
    wrap.style.width = (node.w || 220) + 'px'; wrap.style.height = (node.h || 160) + 'px'; wrap.style.background = node.color || '#4a3f2a';
    wrap.innerHTML = `<div class="planner-note-header planner-node-header"><input class="planner-note-color-swatch" type="color" value="${_plannerEscapeHtml(node.color || '#4a3f2a')}" onclick="event.stopPropagation()" onchange="updatePlannerNoteColor('${node.id}', this.value)"><span>${t('NOTE')}</span><span style="margin-left:auto"></span><button class="planner-close-btn" onclick="removePlannerNode('${node.id}')">✕</button></div><textarea class="planner-note-textarea" oninput="updatePlannerNoteText('${node.id}', this.value)">${_plannerEscapeHtml(node.text)}</textarea><div class="planner-note-resize-handle"></div>`;
    attachPlannerNodeDrag(wrap, node); attachPlannerNoteResize(wrap, node); return wrap;
}

function renderPlannerPortalNode(wrap, node, flows) {
    const ports = flows.nodePortsCache[node.id] || computeNodePorts(node);
    const title = node.portalItem || t('Select Item', 'ui');
    const isReversed = node.direction === -1;

    if (isReversed) {
        wrap.classList.add('reversed');
    }
    if (node.isDone) { wrap.classList.add('node-done'); wrap.style.backgroundColor = '#2d5a2d'; wrap.style.borderColor = '#4CAF50'; }

    const errorMessageHtml = ports.errorCode 
        ? `<div>${t('Error')}: ${t(ports.errorCode, 'ui')}</div>` 
        : '';

    const machineCountValue = Number((node.machineCount ?? 1).toFixed(3));

    wrap.innerHTML = `
        <div class="planner-node-header portal">
            <span class="planner-node-icon">🌀</span>
            <span class="planner-node-title" onclick="event.stopPropagation(); plannerPickPortalItem('${node.id}')">
                ${_plannerEscapeHtml(title)}
            </span>
            <button class="planner-gear-btn ${node.isDone ? 'done-active' : ''}" title="${t('Toggle Done', 'ui')}" style="${node.isDone ? 'color:#4CAF50; font-weight:bold;' : ''}" onclick="event.stopPropagation(); togglePlannerNodeDone('${node.id}')">✔</button>
                <button class="planner-gear-btn" title="switch direction" onclick="event.stopPropagation(); plannerToggleNodeDirection('${node.id}')">
                ⇄
            </button>
            <button class="planner-close-btn" onclick="removePlannerNode('${node.id}')">
                ✕
            </button>
        </div>
        <div class="planner-node-body" id="planner-node-body-${node.id}">
            ${errorMessageHtml}
            ${renderPlannerPortsHtml(node, ports, flows)}
            <div class="planner-machine-count-row">
                <button class="planner-gear-btn" title="${t('Auto-generate upstream (one level)', 'ui')}" onclick="event.stopPropagation(); autoGenerateUpstreamNodes('${node.id}')">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M12 2L6 12h5l-1 8 7-12h-5l1-6z"/>
                    </svg>
                </button>
                <input type="number" min="0" step="1" value="${machineCountValue}" data-mc-for="${node.id}"
                    title="${t('Items per minute', 'ui')}"
                    oninput="updatePlannerMachineCount('${node.id}', this.value)">
                <span class="planner-portal-rate-unit">/m</span>
                <button class="planner-gear-btn" title="${t('Balance existing upstream to this rate, then generate whatever is still missing', 'ui')}" onclick="event.stopPropagation(); plannerPortalBuildUpstream('${node.id}')">🌳</button>
            </div>
        </div>
    `;

    attachPlannerNodeDrag(wrap, node); 
    return wrap;
}

/** Portal 🌳: rescale the upstream chain that already exists to the portal's rate
 *  (same as Auto-Balance Upstream), then recursively generate nodes only for remaining shortages. */
function plannerPortalBuildUpstream(nodeId) {
    if (!plannerState.nodes[nodeId]) return;
    if (getPlannerUpstreamNodeIds(nodeId).size > 1) _calculateNodeDemand(nodeId);
    autoGenerateAllUpstreamNodes(nodeId); // renders + saves
}

function plannerToggleNodeDirection(nodeId) {
    const node = plannerState.nodes[nodeId];
    if (!node) return;
    node.direction = (node.direction === -1) ? 1 : -1;
    renderPlanner();
    savePlannerState();
}

function attachPlannerNoteResize(wrap, node) {
    const handle = wrap.querySelector('.planner-note-resize-handle'); if (!handle) return;
    handle.addEventListener('pointerdown', e => { e.stopPropagation(); e.preventDefault(); handle.setPointerCapture(e.pointerId); const sx=e.clientX, sy=e.clientY, sw=node.w||220, sh=node.h||160;
        const move = ev => { const z=_plannerSettings.viewport.zoom||1; node.w=Math.max(80, sw+(ev.clientX-sx)/z); node.h=Math.max(50, sh+(ev.clientY-sy)/z); wrap.style.width=node.w+'px'; wrap.style.height=node.h+'px'; };
        const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); savePlannerState(); }; handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up); });
}

function updatePlannerNoteText(nodeId, text) { const node=plannerState.nodes[nodeId]; if (!node) return; node.text=text; clearTimeout(_noteSaveTimers.get(nodeId)); _noteSaveTimers.set(nodeId, setTimeout(() => savePlannerState(), 600)); }
function updatePlannerNoteColor(nodeId, color) { const node=plannerState.nodes[nodeId]; if (!node) return; node.color=color; const el=document.getElementById('planner-node-'+nodeId); if (el) el.style.background=color; savePlannerState(); }
function plannerPickPortalItem(nodeId) { const node=plannerState.nodes[nodeId]; if (!node) return; const old=window.selectItem; window.selectItem=name => { node.portalItem=name; window.selectItem=old; closeModal('picker-modal'); recomputeAndRefreshPlanner(); savePlannerState(); }; openItemPicker(); }

function onPlannerHeaderHover(headerEl, nodeId) {
    const node = plannerState.nodes[nodeId];
    if (!node) return;
    const rates = plannerGetNodeRates(node);
    if (!rates || rates.errorCode) return; // No recipe or invalid (circular / missing plan): don't show
    showPlannerRateTooltip(headerEl, rates);
}

function renderPlannerPortsHtml(node, ports, flows) {
    const orderedInputs = applyPortOrder(ports.inputs, node.portOrder?.in);
    const orderedOutputs = applyPortOrder(ports.outputs, node.portOrder?.out);
    const inRows = orderedInputs.map(p => renderPlannerPortRow(node.id, p, 'in', flows)).join('');
    const outRows = orderedOutputs.map(p => renderPlannerPortRow(node.id, p, 'out', flows)).join('');
    return `<div class="planner-ports-row">
        <div class="planner-ports-col planner-ports-in">${inRows || `<div class="planner-port-empty">—</div>`}</div>
        <div class="planner-ports-col planner-ports-out">${outRows || `<div class="planner-port-empty">—</div>`}</div>
    </div>`;
}

function renderPlannerPortRow(nodeId, port, dir, flows) {
    const itemDef = DB.items[port.item] || {};
    const key = plannerPortKey(nodeId, port.item, dir);
    const connected = flows && (flows.portConnections[key] || []).length > 0;
    const remaining = flows ? (flows.portRemaining[key] ?? port.rate) : port.rate;

    let colorClass = 'planner-port-gray';
    let rateClass = '';
    let badgeHtml = '';

    if (dir === 'out') {
        if (connected) {
            colorClass = 'planner-port-green';
            if (remaining > 0.001) {
                badgeHtml = `<span class="planner-port-badge planner-badge-surplus">+${formatVal(remaining)}</span>`;
                colorClass = rateClass = 'planner-port-yellow';
            }
        } else {
            if (port.rate > 0.001) {
                badgeHtml = `<span class="planner-port-badge planner-badge-surplus">+${formatVal(port.rate)}</span>`;
                colorClass = 'planner-port-yellow';
            }
        }
    } else {
        if (connected) {
            if (remaining > 0.001) {
                colorClass = rateClass = 'planner-port-red';
                badgeHtml = `<span class="planner-port-badge planner-badge-shortage">-${formatVal(remaining)}</span>`;
            } else {
                colorClass = 'planner-port-green';
            }
        } else {
            colorClass = 'planner-port-gray';
        }
    }

    const dot = `<span class="planner-port-dot ${colorClass}" data-item="${port.item}" data-dir="${dir}"></span>`;
    const icon = `<img src="img/item${itemDef.id ?? 0}.png" width="16" height="16">`;
    const name = `<span class="planner-port-name">${port.item}</span>`;
    const rate = `<span class="planner-port-rate">${formatVal(port.rate)}</span>`;
    if (dir === 'in') return `<div class="planner-port planner-port-in ${rateClass}" title="${port.item}">${badgeHtml}${dot}${rate}${icon}${name}</div>`;
    return `<div class="planner-port planner-port-out ${rateClass}" title="${port.item}">${name}${icon}${rate}${dot}${badgeHtml}</div>`;
}

function renderPlannerHeatFertHtml(ports, node) {
    let html = renderPlannerBeltChipHtml(node);
    if (ports.heatItemsPerMin > 0.001) {
        const fuelDef = DB.items[DB.settings.defaultFuel] || {};
        html += `<span class="heat-tag">-${formatVal(ports.heatItemsPerMin)}/m <img src="img/item${fuelDef.id ?? 0}.png" class="item-icon-small" title="${DB.settings.defaultFuel}"></span>`;
    }
    if (ports.fertItemsPerMin > 0.001) {
        const fertDef = DB.items[DB.settings.defaultFert] || {};
        html += `<span class="bio-tag">-${formatVal(ports.fertItemsPerMin)}/m <img src="img/item${fertDef.id ?? 0}.png" class="item-icon-small" title="${DB.settings.defaultFert}"></span>`;
    }
    if (ports.goldCostPerMin > 0.001) {
        html += `<span class="gold-tag">-${formatVal(ports.goldCostPerMin)}/m <img src="img/copper.png" class="item-icon-small"></span>`;
    }
    return html;
}

/* ---------------- MACHINES PER BELT ---------------- */

/**
 * For a recipe node: how many machines one belt can feed/carry on each solid port
 * (liquids such as Steam are piped, so they are skipped). `limit` is the tightest port.
 */
function plannerGetNodeBeltInfo(node) {
    if (!node || (node.kind && node.kind !== 'recipe') || !node.recipeId) return null;
    const rates = plannerGetRecipeRates(node.recipeId, node.recipeModifiers);
    if (!rates || rates.errorCode || !rates.recipe) return null;
    const beltSpeed = getBeltSpeed(DB.settings.lvlBelt || 0);
    const ports = [];
    const add = (list, dir) => list.forEach(p => {
        const def = DB.items[p.item];
        if (!def || def.liquid || !(p.rate > 0)) return;
        let speed = beltSpeed; // same effective belt rules as plannerGetRecipeRates
        if (def.category === 'Currency') speed *= 50;
        else if (dir === 'out' && rates.recipe.sharedOutputs) speed /= rates.recipe.sharedOutputs;
        ports.push({ item: p.item, dir, perMachine: p.rate, machinesPerBelt: speed / p.rate });
    });
    add(rates.inputsPerMachine, 'in');
    add(rates.outputsPerMachine, 'out');
    if (ports.length === 0) return null;
    const limit = ports.reduce((a, b) => (b.machinesPerBelt < a.machinesPerBelt ? b : a));
    // Whole machines that fit on one belt without overflowing it (fractional if a single machine exceeds a belt)
    const wholePerBelt = limit.machinesPerBelt >= 1 ? Math.floor(limit.machinesPerBelt + 1e-6) : limit.machinesPerBelt;
    return { beltSpeed, ports, limit, wholePerBelt };
}

function renderPlannerBeltChipHtml(node) {
    const info = plannerGetNodeBeltInfo(node);
    if (!info) return '';
    const beltsUsed = node.machineCount / info.limit.machinesPerBelt;
    const lines = [
        `${t('Belt', 'ui')}: ${formatVal(info.beltSpeed)}/m`,
        ...info.ports.map(p => `${p.item} (${t(p.dir === 'in' ? 'in' : 'out', 'ui')}): 1 ${t('belt', 'ui')} = ${formatVal(p.machinesPerBelt)} ${t('machines', 'ui')}`),
        `${t('Now', 'ui')}: ${beltsUsed.toFixed(2)} ${t('belts of', 'ui')} ${info.limit.item}`,
        t('Click: set machine count to fill the next whole belt', 'ui')
    ];
    return `<span class="belt-tag" title="${_plannerEscapeHtml(lines.join('\n'))}"
        onpointerdown="event.stopPropagation()" onclick="event.stopPropagation(); plannerFillNodeBelts('${node.id}')">🛤 ${formatVal(info.wholePerBelt)}/${t('belt', 'ui')} <span class="belt-tag-used">(${beltsUsed.toFixed(1)})</span></span>`;
}

/** Round machine count up to fill whole belts on the tightest port; if already full, add one more belt. */
function plannerFillNodeBelts(nodeId) {
    const node = plannerState.nodes[nodeId];
    const info = plannerGetNodeBeltInfo(node);
    if (!info) return;
    const per = info.wholePerBelt;
    let belts = Math.max(1, Math.ceil(node.machineCount / per - 1e-6));
    if (Math.abs(node.machineCount - belts * per) < 1e-6) belts += 1;
    updatePlannerMachineCount(nodeId, belts * per);
    flashPlannerElements(`[data-mc-for="${nodeId}"]`, 'mc-flash');
}

/* ==========================================================================
   SECTION: PORT ORDER OPTIMIZATION (single-node barycenter/median)
   ========================================================================== */

/**
 * Reorder a list of ports by node.portOrder (if present).
 * Items not in portOrder count as Infinity and go last,
 * keeping their original relative order (stable sort).
 * @param {{item:string, rate:number}[]} portList
 * @param {string[]|undefined} orderArr
 */
function applyPortOrder(portList, orderArr) {
    if (!orderArr || orderArr.length === 0) return portList;
    const indexMap = new Map(orderArr.map((item, i) => [item, i]));
    return [...portList].sort((a, b) => {
        const ia = indexMap.has(a.item) ? indexMap.get(a.item) : Infinity;
        const ib = indexMap.has(b.item) ? indexMap.get(b.item) : Infinity;
        return ia - ib; // Array.sort is stable (guaranteed in modern browsers/V8), ties keep their order
    });
}

/**
 * Median of an array (input doesn't need to be sorted)
 */
function _plannerMedian(values) {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Sort score for one port (item + dir):
 * the median card-center y of all nodes connected to that port.
 * Unconnected ports return null (the caller puts them last).
 * @param {string} nodeId
 * @param {string} item
 * @param {'in'|'out'} dir
 * @param {object} flows  return value of plannerResolveFlows()
 */
function _plannerPortSortScore(nodeId, item, dir, flows) {
    const key = plannerPortKey(nodeId, item, dir);
    const edgeIds = flows.portConnections[key] || [];
    if (edgeIds.length === 0) return null;

    const yValues = [];
    edgeIds.forEach(edgeId => {
        const edge = plannerState.edges[edgeId];
        if (!edge) return;
        const otherNodeId = (dir === 'in') ? edge.fromNode : edge.toNode;
        const otherEl = document.getElementById('planner-node-' + otherNodeId);
        if (!otherEl) return;
        yValues.push(otherEl.offsetTop + otherEl.offsetHeight / 2);
    });
    if (yValues.length === 0) return null;
    return _plannerMedian(yValues);
}

/**
 * Sort a list of ports by _plannerPortSortScore and return the item names in order.
 * Connected ports go by score (median center y of the connected nodes), smallest first;
 * unconnected ports always go last, keeping their original relative order.
 * @param {{item:string, rate:number}[]} portList
 * @param {string} nodeId
 * @param {'in'|'out'} dir
 * @param {object} flows
 * @returns {string[]}
 */
function _plannerComputePortOrder(portList, nodeId, dir, flows) {
    const scored = portList.map(p => ({
        item: p.item,
        score: _plannerPortSortScore(nodeId, p.item, dir, flows)
    }));
    const connected = scored.filter(s => s.score !== null).sort((a, b) => a.score - b.score);
    const unconnected = scored.filter(s => s.score === null);
    return [...connected, ...unconnected].map(s => s.item);
}

/**
 * Reorder the ports of a single node only (inputs and outputs separately),
 * so the connected nodes' y positions are as monotonic as possible, reducing crossings.
 * Doesn't affect other nodes' order or position.
 * @param {string} nodeId
 */
function plannerOptimizePortOrderForNode(nodeId) {
    const node = plannerState.nodes[nodeId];
    if (!node) return;

    const flows = _plannerLastFlows || plannerResolveFlows();
    const ports = flows.nodePortsCache[nodeId];
    if (!ports) return;

    node.portOrder = {
        in: _plannerComputePortOrder(ports.inputs, nodeId, 'in', flows),
        out: _plannerComputePortOrder(ports.outputs, nodeId, 'out', flows)
    };

    recomputeAndRefreshPlanner();
    savePlannerState();
}

/**
 * Run the single-node port sort once for every node in the current plan (one pass, no iteration).
 * All nodes share one flows snapshot instead of each resolving again.
 */
function plannerOptimizeAllPortOrders() {
    const flows = plannerResolveFlows();

    Object.values(plannerState.nodes).forEach(node => {
        const ports = flows.nodePortsCache[node.id];
        if (!ports) return;
        node.portOrder = {
            in: _plannerComputePortOrder(ports.inputs, node.id, 'in', flows),
            out: _plannerComputePortOrder(ports.outputs, node.id, 'out', flows)
        };
    });

    recomputeAndRefreshPlanner();
    savePlannerState();
}

/* ---------------- MACHINE COUNT UPDATE ---------------- */

function updatePlannerMachineCount(nodeId, value) {
    const node = plannerState.nodes[nodeId];
    if (!node) return;
    node.machineCount = Math.max(0, parseFloat(value) || 0);
    recomputeAndRefreshPlanner();
    savePlannerState();
}

/** Patch only one node card's content (ports/machine count/heat-fert) without rebuilding DOM, keeping input focus */
function patchPlannerNodeDisplay(node, flows) {
    if (node.kind === 'note') return;
    const ports = flows.nodePortsCache[node.id];
    if (!ports) return;
    const body = document.getElementById('planner-node-body-' + node.id);
    if (body) {
        const errEl = document.getElementById('planner-node-error-' + node.id);
        if (errEl) errEl.innerHTML = ports.errorCode ? `${t('Error')}: ${t(ports.errorCode)}` : '';
        const portsRowEl = body.querySelector('.planner-ports-row');
        if (portsRowEl) portsRowEl.outerHTML = renderPlannerPortsHtml(node, ports, flows);
        const heatFertEl = document.getElementById('planner-heatfert-' + node.id);
        if (heatFertEl) heatFertEl.innerHTML = renderPlannerHeatFertHtml(ports, node);
    }
    document.querySelectorAll(`[data-mc-for="${node.id}"]`).forEach(el => {
        if (document.activeElement !== el) el.value = Number(node.machineCount.toFixed(3));
    });

    const modalBody = document.getElementById('planner-node-modal-body');
    const modalEl = document.getElementById('planner-node-modal');
    if (modalBody && modalBody.dataset.nodeId === node.id && modalEl && modalEl.style.display === 'flex') {
        const modalPortsRow = modalBody.querySelector('.planner-ports-row');
        if (modalPortsRow) modalPortsRow.outerHTML = renderPlannerPortsHtml(node, ports, flows);
        const modalHeatFert = modalBody.querySelector('.planner-heatfert-row');
        if (modalHeatFert) modalHeatFert.innerHTML = renderPlannerHeatFertHtml(ports, node);
    }
}

function togglePlannerLinkMode() {
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
}

function onPlannerMachineCountFocus(nodeId, inputEl) {
    if (!_plannerLinkMode) return;
    const node = plannerState.nodes[nodeId];
    inputEl.dataset.oldVal = node ? node.machineCount : inputEl.value;
}

function onPlannerMachineCountBlur(nodeId, inputEl) {
    if (!_plannerLinkMode) { delete inputEl.dataset.oldVal; return; }
    const oldVal = parseFloat(inputEl.dataset.oldVal);
    const node = plannerState.nodes[nodeId];
    const newVal = node ? node.machineCount : parseFloat(inputEl.value);
    delete inputEl.dataset.oldVal;

    if (!oldVal || !newVal || oldVal === newVal) return; // Old 0 / new 0 / unchanged -> don't propagate

    const ratio = newVal / oldVal;
    propagatePlannerMachineRatio(nodeId, ratio);
}

function propagatePlannerMachineRatio(sourceNodeId, ratio) {
    let connected = [];
    if (_plannerLinkMode === 'all') {
        connected = [...getPlannerConnectedNodeIds(sourceNodeId)].filter(id => id !== sourceNodeId);
    } else if (_plannerLinkMode === 'upstream') {
        connected = [...getPlannerUpstreamNodeIds(sourceNodeId)].filter(id => id !== sourceNodeId);
    } else if (_plannerLinkMode === 'downstream') {
        connected = [...getPlannerDownstreamNodeIds(sourceNodeId)].filter(id => id !== sourceNodeId);
    }
    
    if (connected.length === 0) return;

    connected.forEach(id => {
        const n = plannerState.nodes[id];
        if (n && n.kind !== 'portal') n.machineCount = Math.max(0, n.machineCount * ratio);
    });

    recomputeAndRefreshPlanner();
    savePlannerState();
    flashPlannerLinkFeedback(sourceNodeId, connected);
}

/** Play a one-off flash animation on elements matching selector (remove and re-add the class, forcing a reflow) */
function flashPlannerElements(selector, flashClass, duration = 500) {
    document.querySelectorAll(selector).forEach(el => {
        el.classList.remove(flashClass);
        void el.offsetWidth;
        el.classList.add(flashClass);
        setTimeout(() => el.classList.remove(flashClass), duration);
    });
}

function flashPlannerLinkFeedback(sourceNodeId, affectedNodeIds) {
    flashPlannerElements(`[data-link-for="${sourceNodeId}"]`, 'link-flash');
    affectedNodeIds.forEach(id => flashPlannerElements(`[data-mc-for="${id}"]`, 'mc-flash'));
}

/* ---------------- DRAG NODE (header only) ---------------- */

function attachPlannerNodeDrag(wrap, node) {
    const header = wrap.querySelector('.planner-node-header');
    header.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button, input, textarea')) return;

        // --- Ctrl/Cmd + click toggles selection instead of dragging ---
        if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            e.stopPropagation();
            if (_plannerSelectedNodeIds.has(node.id)) {
                _plannerSelectedNodeIds.delete(node.id);
                wrap.classList.remove('selected');
            } else {
                _plannerSelectedNodeIds.add(node.id);
                wrap.classList.add('selected');
            }
            return;
        }

        e.preventDefault();
        header.setPointerCapture(e.pointerId);
        header.classList.add('dragging');
        const startX = e.clientX, startY = e.clientY;
        const originX = node.x, originY = node.y;
        hidePlannerRateTooltip();

        const isGroupDrag = _plannerSelectedNodeIds.has(node.id) && _plannerSelectedNodeIds.size > 1;
        const origins = isGroupDrag
            ? [..._plannerSelectedNodeIds]
                .map(id => plannerState.nodes[id])
                .filter(Boolean)
                .map(n => ({ id: n.id, x: n.x, y: n.y }))
            : [{ id: node.id, x: node.x, y: node.y }];

        const onMove = (ev) => {
            const zoom = _plannerSettings.viewport.zoom || 1;
            const dx = (ev.clientX - startX) / zoom;
            const dy = (ev.clientY - startY) / zoom;
            origins.forEach(o => {
                const n = plannerState.nodes[o.id];
                if (!n) return;
                n.x = plannerSnapVal(o.x + dx);
                n.y = plannerSnapVal(o.y + dy);
                const el = document.getElementById('planner-node-' + o.id);
                if (el) { el.style.left = n.x + 'px'; el.style.top = n.y + 'px'; }
            });
            if (_plannerLastFlows) renderPlannerEdges(_plannerLastFlows);
        };
        const onUp = () => {
            header.removeEventListener('pointermove', onMove);
            header.removeEventListener('pointerup', onUp);
            header.classList.remove('dragging');
            savePlannerState();
            plannerOptimizePortOrderForNode(node.id);
        };
        header.addEventListener('pointermove', onMove);
        header.addEventListener('pointerup', onUp);
    });
}

/* ==========================================================================
   SECTION: EDGES - drawing, connecting by dragging, deleting
   ========================================================================== */

function getPlannerPortDotEl(nodeId, item, dir) {
    const nodeEl = document.getElementById('planner-node-' + nodeId);
    if (!nodeEl) return null;
    const dots = nodeEl.querySelectorAll('.planner-port-dot');
    for (const d of dots) {
        if (d.dataset.item === item && d.dataset.dir === dir) return d;
    }
    return null;
}

function getPlannerPortGraphPos(nodeId, item, dir) {
    const dot = getPlannerPortDotEl(nodeId, item, dir);
    if (!dot) return null;
    const rect = dot.getBoundingClientRect();
    return plannerScreenToGraph(rect.left + rect.width / 2, rect.top + rect.height / 2);
}

function buildPlannerEdgePath(p1, p2, sign1 = 1, sign2 = -1) {
    const dx = Math.max(40, Math.abs(p2.x - p1.x) * 0.5);
    const c1 = { x: p1.x + dx * sign1, y: p1.y };
    const c2 = { x: p2.x + dx * sign2, y: p2.y };
    const d = `M ${p1.x} ${p1.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${p2.x} ${p2.y}`;
    // True midpoint of the cubic Bezier at t = 0.5, used to position the label
    const mid = {
        x: p1.x * 0.125 + c1.x * 0.375 + c2.x * 0.375 + p2.x * 0.125,
        y: p1.y * 0.125 + c1.y * 0.375 + c2.y * 0.375 + p2.y * 0.125
    };
    return { d, mid, c1, c2 };
}

function buildPlannerEdgePathD(p1, p2, sign1 = 1, sign2 = -1) {
    const dx = Math.max(40, Math.abs(p2.x - p1.x) * 0.5);
    return `M ${p1.x} ${p1.y} C ${p1.x + dx * sign1} ${p1.y}, ${p2.x + dx * sign2} ${p2.y}, ${p2.x} ${p2.y}`;
}

/**
 * Path d string for a row of ">" chevrons placed at fixed arc-length spacing along a cubic Bezier.
 * @param {number} spacing arc-length spacing between chevron centers (px)
 * @param {number} size    chevron size (depth and width are both size)
 */
function _plannerBuildChevronPath(p1, c1, c2, p2, spacing = 9, size = 5) {
    const SAMPLES = 200;
    const xs = new Float64Array(SAMPLES + 1);
    const ys = new Float64Array(SAMPLES + 1);
    const txs = new Float64Array(SAMPLES + 1);
    const tys = new Float64Array(SAMPLES + 1);
    const cum = new Float64Array(SAMPLES + 1);

    for (let i = 0; i <= SAMPLES; i++) {
        const t = i / SAMPLES;
        const mt = 1 - t;
        const a = mt * mt * mt;
        const b = 3 * mt * mt * t;
        const c = 3 * mt * t * t;
        const d = t * t * t;
        xs[i] = a * p1.x + b * c1.x + c * c2.x + d * p2.x;
        ys[i] = a * p1.y + b * c1.y + c * c2.y + d * p2.y;

        const a2 = 3 * mt * mt;
        const b2 = 6 * mt * t;
        const c2t = 3 * t * t;
        txs[i] = a2 * (c1.x - p1.x) + b2 * (c2.x - c1.x) + c2t * (p2.x - c2.x);
        tys[i] = a2 * (c1.y - p1.y) + b2 * (c2.y - c1.y) + c2t * (p2.y - c2.y);
    }

    cum[0] = 0;
    for (let i = 1; i <= SAMPLES; i++) {
        cum[i] = cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
    }
    const total = cum[SAMPLES];
    if (total < spacing) return '';

    const half = size / 2;
    let d = '';
    let seg = 0;

    for (let s = spacing * 0.5; s < total; s += spacing) {
        while (seg < SAMPLES - 1 && cum[seg + 1] < s) seg++;
        const segLen = cum[seg + 1] - cum[seg];
        const frac = segLen > 0 ? (s - cum[seg]) / segLen : 0;

        const x = xs[seg] + (xs[seg + 1] - xs[seg]) * frac;
        const y = ys[seg] + (ys[seg + 1] - ys[seg]) * frac;
        const dx = txs[seg] + (txs[seg + 1] - txs[seg]) * frac;
        const dy = tys[seg] + (tys[seg + 1] - tys[seg]) * frac;

        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len, uy = dy / len;
        const px = -uy, py = ux;

        const tipX = x + ux * half;
        const tipY = y + uy * half;
        const blX = x - ux * half + px * half;
        const blY = y - uy * half + py * half;
        const brX = x - ux * half - px * half;
        const brY = y - uy * half - py * half;

        d += `M${blX.toFixed(1)} ${blY.toFixed(1)}L${tipX.toFixed(1)} ${tipY.toFixed(1)}L${brX.toFixed(1)} ${brY.toFixed(1)}`;
    }
    return d;
}

function renderPlannerEdges(flows) {
    const svg = document.getElementById('planner-svg-layer');
    if (!svg) return;
    const beltSpeed = getBeltSpeed(DB.settings.lvlBelt || 0);
    const useChevron = _plannerSettings.edgeStyle === 1;
    let html = '';

    Object.values(plannerState.edges).forEach(edge => {
        const p1 = getPlannerPortGraphPos(edge.fromNode, edge.item, 'out');
        const p2 = getPlannerPortGraphPos(edge.toNode, edge.item, 'in');
        if (!p1 || !p2) return;

        const fromNode = plannerState.nodes[edge.fromNode];
        const toNode = plannerState.nodes[edge.toNode];
        const sign1 = (fromNode && fromNode.direction === -1) ? -1 : 1;
        const sign2 = (toNode && toNode.direction === -1) ? 1 : -1;

        const flow = flows.edgeFlow[edge.id] || 0;
        const itemDef = DB.items[edge.item] || {};
        const { d, mid, c1, c2 } = buildPlannerEdgePath(p1, p2, sign1, sign2);

        // Build the line path for the current mode
        const linePathHtml = useChevron
            ? `<path class="planner-edge-chevrons" d="${_plannerBuildChevronPath(p1, c1, c2, p2, 9, 5)}"></path>`
            : `<path class="planner-edge-line" d="${d}"></path>`;

        const beltCount = !itemDef.liquid ? (flow / beltSpeed) : null;
        // edge.color is now set as the group's color and picked up by stroke: currentColor
        const colorStyle = edge.color ? ` style="color:${edge.color};"` : '';
        const labelStyle = edge.color ? ` style="border-left:3px solid ${edge.color};"` : '';
        const beltArg = beltCount !== null ? beltCount : 'null';
        const hoverAttrs = `onmouseenter="showPlannerEdgeTooltip(event, '${edge.item.replace(/'/g, "\\'")}', ${flow}, ${beltArg})" onmousemove="movePlannerEdgeTooltip(event)" onmouseleave="hidePlannerEdgeTooltip()"`;

        html += `
            <g class="planner-edge-group" data-edge-id="${edge.id}" ${hoverAttrs}${colorStyle}>
                <path class="planner-edge-hit" d="${d}" onpointerdown="onPlannerEdgePointerDown(event, '${edge.id}')" onclick="onPlannerEdgeClick(event, '${edge.id}')"></path>
                ${linePathHtml}
                <foreignObject x="${mid.x - 60}" y="${mid.y - 15}" width="120" height="32" style="overflow:visible;">
                    <div xmlns="http://www.w3.org/1999/xhtml" class="planner-edge-label" onclick="openPlannerEdgeModal('${edge.id}')"${labelStyle}>
                        <img src="img/item${itemDef.id ?? 0}.png" width="16" height="16">
                        <span>${formatVal(flow)}/m</span>
                        ${beltCount !== null ? `<span class="planner-edge-belt">(${beltCount.toFixed(2)})</span>` : ''}
                    </div>
                </foreignObject>
            </g>`;
    });

    svg.innerHTML = html;
}

let _plannerEdgeDragEndedAt = 0;

/** Press + drag on a line: pull a reroute dot out of it at that spot and keep dragging the dot. */
function onPlannerEdgePointerDown(e, edgeId) {
    if (e.button !== 0 || e.altKey || e.ctrlKey || e.metaKey) return;
    e.stopPropagation();
    const startX = e.clientX, startY = e.clientY;
    let wpId = null;

    const onMove = (ev) => {
        const g = plannerScreenToGraph(ev.clientX, ev.clientY);
        if (!wpId) {
            if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return; // still a click
            wpId = plannerInsertWaypointOnEdge(edgeId, g.x, g.y, false);
            if (!wpId) return cleanup();
        }
        const n = plannerState.nodes[wpId];
        const el = document.getElementById('planner-node-' + wpId);
        if (!n || !el) return;
        n.x = Math.round(plannerSnapVal(g.x));
        n.y = Math.round(plannerSnapVal(g.y));
        el.style.left = n.x + 'px';
        el.style.top = n.y + 'px';
        if (_plannerLastFlows) renderPlannerEdges(_plannerLastFlows);
    };
    const cleanup = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
    };
    const onUp = () => {
        cleanup();
        if (wpId) {
            _plannerEdgeDragEndedAt = Date.now(); // the drag must not also open the edge settings
            savePlannerState(); // one undo step for insert + move
        }
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
}

/** Click on a line opens its settings; Alt+click drops a reroute dot at the clicked spot. */
function onPlannerEdgeClick(e, edgeId) {
    if (Date.now() - _plannerEdgeDragEndedAt < 300) return;
    if (e.altKey) {
        e.stopPropagation();
        const g = plannerScreenToGraph(e.clientX, e.clientY);
        plannerInsertWaypointOnEdge(edgeId, g.x, g.y);
        return;
    }
    openPlannerEdgeModal(edgeId);
}

/**
 * Split edge A->B into A->dot->B with a new waypoint at (graphX, graphY).
 * Both halves keep the original createdAt (flow priority) and color. Without a
 * position, the dot goes halfway between the two ports.
 */
function plannerInsertWaypointOnEdge(edgeId, graphX, graphY, save = true) {
    const edge = plannerState.edges[edgeId];
    if (!edge) return null;
    if (graphX === undefined || graphY === undefined) {
        const p1 = getPlannerPortGraphPos(edge.fromNode, edge.item, 'out');
        const p2 = getPlannerPortGraphPos(edge.toNode, edge.item, 'in');
        if (!p1 || !p2) return null;
        graphX = (p1.x + p2.x) / 2; graphY = (p1.y + p2.y) / 2;
    }

    plannerState._nodeSeq = (plannerState._nodeSeq || 0) + 1;
    const wpId = 'pnode_' + plannerState._nodeSeq;
    plannerState.nodes[wpId] = { id: wpId, kind: 'waypoint', portalItem: edge.item, machineCount: 1, x: Math.round(graphX), y: Math.round(graphY) };

    const extra = edge.color ? { color: edge.color } : {};
    [[edge.fromNode, wpId], [wpId, edge.toNode]].forEach(([fromNode, toNode]) => {
        plannerState._edgeSeq = (plannerState._edgeSeq || 0) + 1;
        const id = 'pedge_' + plannerState._edgeSeq;
        plannerState.edges[id] = { id, item: edge.item, fromNode, toNode, createdAt: edge.createdAt, ...extra };
    });
    delete plannerState.edges[edgeId];

    hidePlannerEdgeTooltip();
    renderPlanner();
    if (save) savePlannerState();
    return wpId;
}

/* ---- Drag-to-connect interaction ---- */

function attachPlannerPortDragHandlers() {
    const layer = document.getElementById('planner-nodes-layer');
    if (!layer || layer.dataset.portDragBound) return;
    layer.dataset.portDragBound = "1";
    layer.addEventListener('pointerdown', (e) => {
        const row = e.target.closest('.planner-port');
        if (!row) return;
        const dot = row.querySelector('.planner-port-dot');
        if (!dot) return;
        e.stopPropagation();
        e.preventDefault();
        startPlannerConnectionDrag(dot, e);
    });
}

function startPlannerConnectionDrag(dotEl, e) {
    const nodeId = dotEl.closest('.planner-node').id.replace('planner-node-', '');
    const item = dotEl.dataset.item;
    const dir = dotEl.dataset.dir; // Direction of the starting port
    const svg = document.getElementById('planner-svg-layer');
    const startPos = getPlannerPortGraphPos(nodeId, item, dir) || plannerScreenToGraph(e.clientX, e.clientY);

    let previewEl = null;
    const updatePreview = (clientX, clientY) => {
        // If hovering over a valid port (opposite direction, same item), snap the preview line end to that port's dot
        let endPos = plannerScreenToGraph(clientX, clientY);
        const hoverEl = document.elementFromPoint(clientX, clientY);
        const hoverRow = hoverEl ? hoverEl.closest('.planner-port') : null;
        if (hoverRow) {
            const hoverDot = hoverRow.querySelector('.planner-port-dot');
            const hoverIsWp = !!hoverRow.closest('.planner-waypoint-node');
            const srcIsWp = plannerState.nodes[nodeId]?.kind === 'waypoint';
            const itemOk = hoverDot && (hoverDot.dataset.item === item || hoverDot.dataset.item === 'Any' || item === 'Any');
            if (hoverDot && hoverDot !== dotEl && itemOk && (hoverDot.dataset.dir !== dir || hoverIsWp || srcIsWp)) {
                const hoverNodeId = hoverRow.closest('.planner-node').id.replace('planner-node-', '');
                const snapped = getPlannerPortGraphPos(hoverNodeId, hoverDot.dataset.item, hoverDot.dataset.dir);
                if (snapped) endPos = snapped;
            }
        }

        const d = dir === 'out' ? buildPlannerEdgePathD(startPos, endPos) : buildPlannerEdgePathD(endPos, startPos);
        if (!previewEl) {
            previewEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            previewEl.setAttribute('class', 'planner-edge-preview');
            svg.appendChild(previewEl);
        }
        previewEl.setAttribute('d', d);
    };
    updatePreview(e.clientX, e.clientY);

    const onMove = (ev) => updatePreview(ev.clientX, ev.clientY);
    const onUp = (ev) => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        if (previewEl) previewEl.remove();

        const dropEl = document.elementFromPoint(ev.clientX, ev.clientY);
        const targetRow = dropEl ? dropEl.closest('.planner-port') : null;
        let targetDot = targetRow ? targetRow.querySelector('.planner-port-dot') : null;
        // Dropping anywhere on a waypoint (including its ring) connects to it
        if (!targetDot && dropEl) {
            const wpEl = dropEl.closest('.planner-waypoint-node');
            if (wpEl) targetDot = wpEl.querySelector('.planner-port-dot');
        }

        if (targetDot && targetDot !== dotEl) {
            tryCreatePlannerEdgeFromDots(nodeId, item, dir, targetDot);
            return;
        }
        const targetNodeEl = dropEl ? dropEl.closest('.planner-node') : null;
        if (!targetNodeEl) {
            // Dropped on empty canvas -> open the recipe menu for a new node
            const g = plannerScreenToGraph(ev.clientX, ev.clientY);
            openPlannerRecipePickerMenu({
                item, originDir: dir, sourceNodeId: nodeId,
                graphX: g.x, graphY: g.y,
                clientX: ev.clientX, clientY: ev.clientY
            });
        }
        // Dropped on a card but not on a port row -> cancel, do nothing
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
}

function tryCreatePlannerEdgeFromDots(sourceNodeId, item, sourceDir, targetDotEl) {
    const targetNodeEl = targetDotEl.closest('.planner-node');
    if (!targetNodeEl) return;
    const targetNodeId = targetNodeEl.id.replace('planner-node-', '');
    const targetItem = targetDotEl.dataset.item;
    let targetDir = targetDotEl.dataset.dir;
    
    if (targetNodeId === sourceNodeId) return;

    // Waypoints expose both directions at the same spot: if either end is a waypoint,
    // flip that end's direction so the connection always succeeds.
    if (targetDir === sourceDir) {
        if (plannerState.nodes[targetNodeId]?.kind === 'waypoint') targetDir = sourceDir === 'out' ? 'in' : 'out';
        else if (plannerState.nodes[sourceNodeId]?.kind === 'waypoint') sourceDir = targetDir === 'out' ? 'in' : 'out';
    }

    if (targetItem !== item && targetItem !== 'Any' && item !== 'Any') { console.log(t('Ports must be the same item to connect.', 'ui')); return; }
    if (targetDir === sourceDir) { console.log(t('Cannot connect two ports of the same direction.', 'ui')); return; }

    // If one of them is 'Any' (Waypoint), update it to the real item
    let finalItem = item;
    if (targetItem === 'Any' || item === 'Any') {
        const realItem = targetItem === 'Any' ? item : targetItem;
        if (realItem !== 'Any') finalItem = realItem;
        const anyNodeId = targetItem === 'Any' ? targetNodeId : sourceNodeId;
        const anyNode = plannerState.nodes[anyNodeId];
        if (anyNode && anyNode.kind === 'waypoint') {
            anyNode.portalItem = realItem;
            // Also need to re-render to update the ports
            
        }
    }

    const fromNode = sourceDir === 'out' ? sourceNodeId : targetNodeId;
    const toNode = sourceDir === 'out' ? targetNodeId : sourceNodeId;

    const dup = Object.values(plannerState.edges).some(e =>
        e.fromNode === fromNode && e.toNode === toNode && e.item === finalItem);
    if (dup) { console.log(t('These two ports are already connected.', 'ui')); return; }

    plannerState._edgeSeq = (plannerState._edgeSeq || 0) + 1;
    const edgeId = 'pedge_' + plannerState._edgeSeq;
    plannerState.edges[edgeId] = { id: edgeId, item: finalItem, fromNode, toNode, createdAt: plannerState._edgeSeq };

    let flows = plannerResolveFlows();
    renderPlanner();

    // When connecting from sourceNode's input and sourceNode is still short of this item afterwards,
    // raise targetNode's machine count to cover the shortfall.
    if (sourceDir !== 'out') {
        const sourceInKey = plannerPortKey(sourceNodeId, item, 'in');
        const shortage = flows.portRemaining[sourceInKey] || 0;
        if (shortage > 0.001) {
            const targetNode = plannerState.nodes[targetNodeId];
            const rates = targetNode ? plannerGetRecipeRates(targetNode.recipeId, targetNode.recipeModifiers) : null;
            const perMachineRate = rates
                ? (rates.outputsPerMachine.find(p => p.item === item) || {}).rate || 0
                : 0;
            if (targetNode && perMachineRate > 0) {
                targetNode.machineCount += shortage / perMachineRate;
                flows = recomputeAndRefreshPlanner();
                flashPlannerElements(`[data-mc-for="${targetNodeId}"]`, 'mc-flash');
            }
        }
    }
    savePlannerState();
}


/* ==========================================================================
   SECTION: EMPTY CANVAS HINT (shown when the active plan has no nodes)
   ========================================================================== */

/** Content of the help popup: [key combination, description] */
function _plannerEmptyHintEntries() {
    return [
        [t('Right-click canvas / + Add Node', 'ui'), t('Add a new recipe node', 'ui')],
        [t('Drag empty canvas', 'ui'), t('Pan the view', 'ui')],        
        [t('▭ Select Mode + drag', 'ui'), t('Box-select multiple nodes', 'ui')],
        [t('Shift + drag empty canvas', 'ui'), t('Temporary box-select', 'ui')],
        [t('Ctrl/Cmd + click node', 'ui'), t('Toggle single node selection', 'ui')],
        [t('Ctrl/Cmd + A', 'ui'), t('Select all nodes', 'ui')],
        [t('Delete / Backspace', 'ui'), t('Delete selected nodes', 'ui')],
        [t('Mouse wheel / Pinch', 'ui'), t('Zoom in/out', 'ui')],
        [t('+ / − / F key', 'ui'), t('Zoom / Fit all nodes to view', 'ui')],
        [t('Ctrl/Cmd + Z / Y', 'ui'), t('Undo / Redo', 'ui')],
        [t('Drag port dot to another port', 'ui'), t('Connect two ports', 'ui')],
        [t('Drag port dot to empty canvas', 'ui'), t('Create a new connected node', 'ui')]
    ];
}

/** Show or remove the central help hint depending on whether the current plan is empty */
function renderPlannerEmptyHint() {
    const canvas = document.getElementById('planner-canvas');
    if (!canvas) return;
    let hintEl = document.getElementById('planner-empty-hint');

    const isEmpty = Object.keys(plannerState.nodes).length === 0;
    if (!isEmpty) {
        if (hintEl) hintEl.remove();
        return;
    }

    if (!hintEl) {
        hintEl = document.createElement('div');
        hintEl.id = 'planner-empty-hint';
        hintEl.className = 'planner-empty-hint';
        canvas.appendChild(hintEl);
    }

    const rows = _plannerEmptyHintEntries()
        .map(([key, desc]) => `
            <div class="planner-empty-hint-row">
                <span class="planner-empty-hint-key">${key}</span>
                <span class="planner-empty-hint-desc">${desc}</span>
            </div>`)
        .join('');

    hintEl.innerHTML = `
        <div class="planner-empty-hint-title">${t('Planner Controls', 'ui')}</div>
        ${rows}
    `;
}

function renderPlannerWaypointNode(wrap, node, flows) {
    wrap.classList.add('planner-waypoint-node');

    const item = node.portalItem || 'Any';
    const outKey = plannerPortKey(node.id, item, 'out');
    const inKey = plannerPortKey(node.id, item, 'in');
    const connectedIn = !!(flows && (flows.portConnections[inKey] || []).length);
    const connectedOut = !!(flows && (flows.portConnections[outKey] || []).length);
    if (connectedIn && connectedOut) wrap.classList.add('wp-connected');
    else if (connectedIn || connectedOut) wrap.classList.add('wp-half');

    const throughput = flows ? (flows.portTheoretical[outKey] || 0) : 0;
    const tip = `${item === 'Any' ? t('Waypoint', 'ui') : item}${throughput > 0.001 ? ' · ' + formatVal(throughput) + '/m' : ''}\n`
        + t('Drag ring: move · Drag center: connect · Double-click: delete', 'ui');

    wrap.ondblclick = (e) => { e.stopPropagation(); removePlannerNode(node.id); };

    // Outer ring = drag handle (planner-node-header so the standard node drag applies).
    // Center = both ports stacked at the same spot, so edges meet at the dot's center.
    // The 'out' port is on top: dragging from a waypoint usually continues the route downstream;
    // tryCreatePlannerEdgeFromDots flips the direction automatically when needed.
    wrap.innerHTML = `
        <div class="planner-node-header planner-waypoint-handle" title="${_plannerEscapeHtml(tip)}"></div>
        <div class="planner-port planner-waypoint-port"><span class="planner-port-dot" data-item="${_plannerEscapeHtml(item)}" data-dir="in"></span></div>
        <div class="planner-port planner-waypoint-port" title="${_plannerEscapeHtml(tip)}"><span class="planner-port-dot" data-item="${_plannerEscapeHtml(item)}" data-dir="out"></span></div>
    `;

    attachPlannerNodeDrag(wrap, node);
    return wrap;
}

function togglePlannerNodeDone(nodeId) {
    const node = plannerState.nodes[nodeId];
    if (node) {
        node.isDone = !node.isDone;
        savePlannerState();
        renderPlanner();
    }
}
