// Main calculation engine for the Planner tab
// Global Memeber Used: DB, plannerState
// Dependency: alchemy_planner.js

/* ==========================================================================
   SECTION: PLAN DEPENDENCY ANALYSIS (module usage / cycle detection)
   ========================================================================== */

/** All moduleIds referenced directly by module nodes in a plan (deduplicated) */
function _getDirectModuleIds(plan) {
    const ids = new Set();
    Object.values(plan.data.nodes || {}).forEach(node => {
        if (node.moduleId) ids.add(node.moduleId);
    });
    return [...ids];
}

/**
 * Recursively (BFS) expand every module planId uses (including indirect ones) and detect circular references.
 * It only counts as a cycle if the expansion leads back to planId itself;
 * several modules sharing the same lower module (diamond dependency) is not a cycle.
 * @returns { modules: string[], hasCycle: boolean }
 */
function getPlannerModulesUsedBy(planId) {
    const originPlan = plannerLibrary.plans[planId];
    if (!originPlan) return { modules: [], hasCycle: false };

    const visited = new Set();
    let hasCycle = false;
    const queue = [..._getDirectModuleIds(originPlan)];

    while (queue.length) {
        const cur = queue.shift();
        if (cur === planId) { hasCycle = true; continue; }
        if (visited.has(cur)) continue;
        visited.add(cur);
        const curPlan = plannerLibrary.plans[cur];
        if (!curPlan) continue; // Reference to a plan that no longer exists, skip (broken reference)
        _getDirectModuleIds(curPlan).forEach(id => queue.push(id));
    }

    return { modules: [...visited], hasCycle };
}

/** Which plans use planId as a module (directly or indirectly) */
function getPlannerModulesUsingPlan(planId) {
    const users = [];
    plannerLibrary.planOrder.forEach(id => {
        if (id === planId || !plannerLibrary.plans[id]) return;
        const { modules } = getPlannerModulesUsedBy(id);
        if (modules.includes(planId)) users.push(id);
    });
    return users;
}

/* ==========================================================================
   SECTION: RECIPE / RATE CALCULATION
   ========================================================================== */

const PLANNER_STEAM_HEAT_VALUE = 20; // 1 Steam = 20 P (Steam Boiler: 3000 P/s -> 150 Steam/s)

/* ---- Per-plan energy settings (heating device / fuel / fertilizer) ----
 * Each plan's data carries `energy: { heating, fuel, fert }`. Calculations use the plan currently
 * being resolved (_plannerCalcPlanData, set by plannerResolveFlows while computing a module plan),
 * otherwise the active plan. Missing values fall back to the Calculator's global settings. */
let _plannerCalcPlanData = null;

/** Energy settings from the global Calculator settings (used to initialize plans that have none) */
function plannerDefaultEnergy() {
    return {
        heating: DB.settings.selectedHeatingDevice || 'Stone Furnace',
        fuel: DB.settings.defaultFuel,
        fert: DB.settings.defaultFert
    };
}

/** Effective energy settings for a plan's data object */
function plannerEnergyOf(planData) {
    const e = (planData && planData.energy) || {};
    const d = plannerDefaultEnergy();
    return {
        heating: (e.heating && DB.machines[e.heating]?.isGenerator) ? e.heating : d.heating,
        fuel: (e.fuel && DB.items[e.fuel]?.heat) ? e.fuel : d.fuel,
        fert: (e.fert && DB.items[e.fert]?.nutrientValue) ? e.fert : d.fert
    };
}

/** Energy settings for the plan currently being calculated (module plan during its resolve, else the active plan) */
function plannerEnergy() {
    return plannerEnergyOf(_plannerCalcPlanData || (typeof plannerState !== 'undefined' ? plannerState : null));
}

/** Heated machines consume Steam instead of fuel when the plan's heating device is the Steam Heating Pad.
 *  The Steam Boiler itself always burns fuel (otherwise it would need its own output). */
function plannerUsesSteamHeat(recipe) {
    return plannerEnergy().heating === 'Steam Heating Pad' && recipe && recipe.machine !== 'Steam Boiler';
}

function plannerGetRawRecipe(recipeId) {
    return (DB.recipes || []).find(r => r.id === recipeId) || null;
}

function plannerMainOutput(recipeId) {
    const r = plannerGetRawRecipe(recipeId);
    return r ? Object.keys(r.outputs)[0] : null;
}

function plannerGetRecipeTime(recipe) {
    let recipeTime = recipe.baseTime || 1;
    const nutrientCost = recipe.nutrientCost || 0;
    if (nutrientCost > 0 && recipe.machine === "Nursery") {
        const fertSpeed = DB.items[plannerEnergy().fert]?.maxFertility || 1;
        recipeTime = nutrientCost / fertSpeed;
    }
    return recipeTime;
}

/**
 * Per-machine input/output/heat/fert rates per minute for a recipe id (plus optional recipeModifiers,
 * e.g. advanced machine catalysts). Not affected by any node's machineCount.
 * Returns: { recipe, inputsPerMachine, outputsPerMachine, heatItemsPerMachine, fertItemsPerMachine, goldCostPerMachine, errorCode }
 */
function plannerGetRecipeRates(recipeId, recipeModifiers) {    
    const recipe = getRecipeById(recipeId, recipeModifiers);
    if (!recipe) {
        const rawRecipe = plannerGetRawRecipe(recipeId);
        if (rawRecipe && rawRecipe.customInputSlot && !recipeModifiers?.customInput) {
            return {
                recipe: null, inputsPerMachine: [], outputsPerMachine: [],
                heatItemsPerMachine: 0, fertItemsPerMachine: 0, goldCostPerMachine: 0,
                errorCode: 'Missing Custom Input' };
        }
    
        return { recipe: null, inputsPerMachine: [], outputsPerMachine: [],
             heatItemsPerMachine: 0, fertItemsPerMachine: 0, goldCostPerMachine: 0,
             errorCode: 'Missing Recipe' };
    }

    const lvlBelt = DB.settings.lvlBelt || 0;
    const lvlSpeed = DB.settings.lvlSpeed || 0;
    const lvlAlchemy = DB.settings.lvlAlchemy || 0;
    const lvlFuel = DB.settings.lvlFuel || 0;
    const lvlFert = DB.settings.lvlFert || 0;    
    const beltSpeed = getBeltSpeed(lvlBelt);
    const speedMult = getSpeedMult(lvlSpeed);
    const alchemyMult = getAlchemyMult(lvlAlchemy);

    const recipeTime = plannerGetRecipeTime(recipe);    
    const mainOut = Object.keys(recipe.outputs)[0];
    const nutrientCost = recipe.nutrientCost || 0;  

    let batchesPerMinPerMachine = (60 / (recipeTime || 1)) * speedMult;
    const inputsPerMachine = Object.entries(recipe.inputs || {}).map(([item, qty]) => ({
        item, rate: qty * batchesPerMinPerMachine
    }));
    const outputsPerMachine = Object.entries(recipe.outputs || {}).map(([item, qty]) => {
        const effQty = item === mainOut ? applyAlchemyMult(recipe.machine, qty, alchemyMult) : qty;
        return { item, rate: effQty * batchesPerMinPerMachine };
    });

    // Check port belt speed limits. inputsPerMachine isn't checked for now because some machines have several input ports
    let batchesRatio = 1.0;
    for (const { item, rate } of outputsPerMachine) {
        const itemDef = DB.items[item];
        if (itemDef && !itemDef.liquid) {
            let effectiveBeltSpeed = beltSpeed;
            if (itemDef.category === "Currency") effectiveBeltSpeed *= 50;
            else if (recipe.sharedOutputs) effectiveBeltSpeed /= recipe.sharedOutputs;
            if (rate > effectiveBeltSpeed) {
                batchesRatio = Math.min(batchesRatio, effectiveBeltSpeed/rate);
            }
        }
    }

    if (batchesRatio < 1) {
        batchesPerMinPerMachine *= batchesRatio;
        inputsPerMachine.forEach(io => io.rate *= batchesRatio);
        outputsPerMachine.forEach(io => io.rate *= batchesRatio);
    }

    // Fuel use (heatCost -> fuel items/min, per machine)
    let heatItemsPerMachine = 0;
    const heatByItem = {}; // fuel item -> items/min per machine (the part of that input port burned for heat)
    let needsHeat = false; // true for heated machines whether heat comes from fuel or Steam
    const machineDef = DB.machines[recipe.machine];
    if (machineDef && machineDef.heatCost) {
        needsHeat = true;
        const heatingDeviceName = plannerEnergy().heating;
        const heatingDevice = DB.machines[heatingDeviceName]?.isGenerator
            ? DB.machines[heatingDeviceName]
            : (DB.machines["Stone Furnace"] || { heatSelf: 0, slots: 3 });
        const slotsRequired = machineDef.slotsRequired || 1;
        const heatingSlots = heatingDevice.slots || 3;
        let activeHeat = machineDef.heatCost * speedMult;
        if (machineDef.heatCost < 0) activeHeat = (recipe.heatCost ?? 0) * speedMult;
        const heatingDevicesNeededPerMachine = 1 / (heatingSlots / slotsRequired);
        const totalHeatPerSecPerMachine = heatingDevicesNeededPerMachine * (heatingDevice.heatSelf || 0) * speedMult
            + activeHeat;
        if (plannerUsesSteamHeat(recipe)) {
            // Steam Heating Pad: heat is delivered as Steam (20 P per Steam), exposed as a real
            // input port so it can be wired to Steam Boiler nodes / auto-generated upstream.
            const steamRate = (totalHeatPerSecPerMachine * 60) / PLANNER_STEAM_HEAT_VALUE;
            const existing = inputsPerMachine.find(p => p.item === 'Steam');
            if (existing) existing.rate += steamRate;
            else inputsPerMachine.push({ item: 'Steam', rate: steamRate });
        } else {
            const fuelName = plannerEnergy().fuel;
            const fuelDef = DB.items[fuelName] || {};
            const grossFuelEnergy = (fuelDef.heat || 1) * (1 + lvlFuel * 0.10);
            heatItemsPerMachine = (totalHeatPerSecPerMachine * 60) / grossFuelEnergy;
            if (fuelName && heatItemsPerMachine > 0) {
                // The fuel is a real input port too, so it can be wired to the recipe that makes it.
                heatByItem[fuelName] = heatItemsPerMachine;
                const existing = inputsPerMachine.find(p => p.item === fuelName);
                if (existing) existing.rate += heatItemsPerMachine;
                else inputsPerMachine.push({ item: fuelName, rate: heatItemsPerMachine });
            }
        }
    }

    // Fertilizer use (Nursery, per machine)
    let fertItemsPerMachine = 0;
    if (nutrientCost > 0) {
        const totalNutrientsPerMinPerMachine = batchesPerMinPerMachine * nutrientCost;
        const fertDef = DB.items[plannerEnergy().fert] || { nutrientValue: 144 };
        const grossFertVal = fertDef.nutrientValue * (1 + lvlFert * 0.10);
        fertItemsPerMachine = totalNutrientsPerMinPerMachine / grossFertVal;
    }

    // Gold cost: only for recipes without inputs (Purchasing Portal / Bank Portal etc.)
    let goldCostPerMachine = 0;
    if (Object.keys(recipe.inputs || {}).length === 0) {
        const itemDef = DB.items[mainOut] || {};
        const customCost = DB.settings.customCosts?.[mainOut];
        let unitPrice = 0;
        if (typeof customCost === 'number' && customCost > 0) unitPrice = customCost;
        else if (itemDef.category === 'Currency') unitPrice = itemDef.sellPrice || 0;
        else unitPrice = itemDef.buyPrice || 0;

        const mainOutRate = (outputsPerMachine.find(p => p.item === mainOut) || {}).rate || 0;
        goldCostPerMachine = mainOutRate * unitPrice;
    }

    return { recipe, inputsPerMachine, outputsPerMachine, heatItemsPerMachine, heatByItem, needsHeat, fertItemsPerMachine, goldCostPerMachine, errorCode: '' };
}

/**
 * From the node's current machine count and the shared settings (preferredRecipes/recipeModifiers/upgrade levels),
 * compute the rate of every input/output port of the node and the machine's own fuel/fertilizer use.
 * Returns: { recipe, inputs, outputs, heatItemsPerMin, fertItemsPerMin, goldCostPerMin, errorCode }
 */
function computeNodePorts(node) {
    if (node.kind === 'note') return { recipe: null, inputs: [], outputs: [], heatItemsPerMin: 0, fertItemsPerMin: 0, goldCostPerMin: 0, errorCode: '' };
    const rates = plannerGetNodeRates(node);
    const result = { recipe : null, inputs: [], outputs: [], heatItemsPerMin: 0, fertItemsPerMin: 0, goldCostPerMin: 0, errorCode: '' };
    
    if (rates.errorCode) return { ...result, errorCode: rates.errorCode };

    const mc = node.machineCount;
    result.recipe = rates.recipe;
    result.inputs = rates.inputsPerMachine.map(p => ({ item: p.item, rate: p.rate * mc }));
    result.outputs = rates.outputsPerMachine.map(p => ({ item: p.item, rate: p.rate * mc }));
    result.heatItemsPerMin = rates.heatItemsPerMachine * mc;
    result.heatByItem = {};
    Object.entries(rates.heatByItem || {}).forEach(([item, r]) => { result.heatByItem[item] = r * mc; });
    result.needsHeat = !!rates.needsHeat || result.heatItemsPerMin > 0;
    result.fertItemsPerMin = rates.fertItemsPerMachine * mc;
    result.goldCostPerMin = rates.goldCostPerMachine * mc;
    return result;
}

/* ==========================================================================
   SECTION: MODULE NODES (plan-as-virtual-recipe)
   ========================================================================== */

/**
 * Dispatch to the per-machine / per-unit rate calculation for the node type (recipe or module).
 * Same return format as plannerGetRecipeRates():
 * { recipe, inputsPerMachine, outputsPerMachine, heatItemsPerMachine, fertItemsPerMachine, errorCode }
 */
function plannerGetNodeRates(node) {
    if (node.kind === 'note') return null;
    if (node.kind === 'portal' || node.kind === 'waypoint') return plannerGetPortalRates(node);
    if (node.moduleId) return plannerGetModuleRates(node.moduleId);
    return plannerGetRecipeRates(node.recipeId, node.recipeModifiers);
}

/**
 * Input/output/heat/fert rates a module plan (moduleId) exposes at multiplier 1.
 * If plannerLibrary.plans[moduleId] doesn't exist, returns errorCode = 'Missing Reference'
 * Uses getPlannerModulesUsedBy(planId) to detect circular references; if found, returns errorCode = 'Circular Reference'
 * { recipe, inputsPerMachine, outputsPerMachine, heatItemsPerMachine, fertItemsPerMachine, errorCode }
 */
function plannerGetModuleRates(moduleId) {
    const result = { recipe: null, inputsPerMachine: [], outputsPerMachine: [], heatItemsPerMachine: 0, fertItemsPerMachine: 0, goldCostPerMachine: 0, errorCode: '' };
    try {
        const plan = plannerLibrary.plans[moduleId];
        if (!plan) return {...result, errorCode: 'Missing Reference'};
        if (getPlannerModulesUsedBy(moduleId).hasCycle) return {...result, errorCode: 'Circular Reference'};

        // The module computes with its own energy settings. Its fuel is a real input port (exposed below
        // through inputShortage), so heat stays per fuel item; fertilizer is converted into the calling
        // plan's fertilizer (same nutrients, different item).
        const outer = plannerEnergy();
        const inner = plannerEnergyOf(plan.data);
        const base = _computeFlowsForPlanData(plan);
        if (!base) return {...result, errorCode: 'Missing Reference'};
        const fertRatio = (DB.items[inner.fert]?.nutrientValue || 144) / (DB.items[outer.fert]?.nutrientValue || 144);

        return {
            recipe: null,
            inputsPerMachine: Object.entries(base.inputShortage).map(([item, qty]) => ({ item, rate: qty })),
            outputsPerMachine: Object.entries(base.outputSurplus).map(([item, qty]) => ({ item, rate: qty })),
            heatItemsPerMachine: base.heatTotal,
            heatByItem: base.heatByItem,
            fertItemsPerMachine: base.fertTotal * fertRatio,
            goldCostPerMachine: base.goldCostTotal,
            errorCode: ''
        };
    }
    catch (e) {
        console.error(e);
        return {...result, errorCode: 'Unkown Error'};
    }
}

/**
 * Read-only calculation: for a planId, compute the plan's overall external
 * input shortfall / output surplus / heat / fert / gold totals (baseline at machine count 1).
 * Doesn't write to plannerState, call savePlannerState, or remove invalid edges.
 */
function _computeFlowsForPlanData(plan) {
    if (!plan || !plan.data) return null;

    const flow = plannerResolveFlows(plan.data);

    const inputShortage = {};
    const outputSurplus = {};
    let heatTotal = 0, fertTotal = 0, goldCostTotal = 0;
    const heatByItem = {};

    Object.values(flow.nodePortsCache).forEach(ports => {
        heatTotal += ports.heatItemsPerMin || 0;
        Object.entries(ports.heatByItem || {}).forEach(([item, r]) => { heatByItem[item] = (heatByItem[item] || 0) + r; });
        fertTotal += ports.fertItemsPerMin || 0;
        goldCostTotal += ports.goldCostPerMin || 0;
    });

    Object.keys(flow.portRemaining).forEach(key => {
        const val = flow.portRemaining[key];
        if (!(val > 0.001)) return;
        const parts = key.split('::'); // nodeId::item::dir
        const item = parts[1];
        const dir = parts[2];
        if (dir === 'out') outputSurplus[item] = (outputSurplus[item] || 0) + val;
        else inputShortage[item] = (inputShortage[item] || 0) + val;
    });

    return { inputShortage: inputShortage, outputSurplus: outputSurplus, heatTotal: heatTotal, heatByItem: heatByItem, fertTotal: fertTotal, goldCostTotal: goldCostTotal };
}


/* ==========================================================================
   SECTION: FLOW RESOLUTION
   ========================================================================== */

function plannerPortKey(nodeId, item, dir) {
    return `${nodeId}::${item}::${dir}`;
}

/**
 * Recalculate the flows and port states of the whole planner graph.
 *
 * Steps:
 * 1. Estimate the theoretical rate of every port on every node.
 * 2. Remove edges made invalid by a recipe change (the item no longer belongs to that port).
 * 3. Allocate flow in creation order (`createdAt`), first come first served.
 *
 * @param {Object|null} [planData=null] Planner graph data. If null, uses the global `plannerState` and marks this as the main calculation.
 * @returns { nodePortsCache, portTheoretical, portRemaining, portConnections, edgeFlow } the computed flows and states
 */
function plannerResolveFlows(planData = null) {
    const prevCalcPlan = _plannerCalcPlanData;
    _plannerCalcPlanData = planData || plannerState;
    try {
        return _plannerResolveFlowsImpl(planData);
    } finally {
        _plannerCalcPlanData = prevCalcPlan;
    }
}

function _plannerResolveFlowsImpl(planData) {
    let isMain = false;
    if (planData === null) {
        planData = plannerState;
        isMain = true;
    }
    const nodePortsCache = {};
    Object.values(planData.nodes).forEach(node => {
        nodePortsCache[node.id] = computeNodePorts(node);
    });

    if (isMain) {
        // Remove invalid edges (e.g. after a node's recipe changes, the item is no longer an input/output)
        let changed = false;
        Object.keys(planData.edges).forEach(eid => {
            const e = planData.edges[eid];
            const fromPorts = nodePortsCache[e.fromNode];
            const toPorts = nodePortsCache[e.toNode];
            const fromOk = fromPorts && fromPorts.outputs.some(p => p.item === e.item);
            const toOk = toPorts && toPorts.inputs.some(p => p.item === e.item);
            if (!fromOk || !toOk) { delete planData.edges[eid]; changed = true; }
        });
        if (changed) savePlannerState();
    }

    const portTheoretical = {};
    Object.entries(nodePortsCache).forEach(([nodeId, ports]) => {
        ports.inputs.forEach(p => { portTheoretical[plannerPortKey(nodeId, p.item, 'in')] = p.rate; });
        ports.outputs.forEach(p => { portTheoretical[plannerPortKey(nodeId, p.item, 'out')] = p.rate; });
    });

    const portRemaining = Object.assign({}, portTheoretical);
    const portConnections = {};
    const edgeFlow = {};

    const isWaypoint = id => planData.nodes[id]?.kind === 'waypoint';
    const allEdges = Object.values(planData.edges);
    allEdges.forEach(edge => {
        edgeFlow[edge.id] = 0;
        const outKey = plannerPortKey(edge.fromNode, edge.item, 'out');
        const inKey = plannerPortKey(edge.toNode, edge.item, 'in');
        (portConnections[outKey] = portConnections[outKey] || []).push(edge.id);
        (portConnections[inKey] = portConnections[inKey] || []).push(edge.id);
    });

    // Waypoints are pure routing: they neither produce nor consume. Every chain
    // realSource -> waypoint(s) -> realSink is resolved as one "virtual" edge between the
    // two real ports, so a waypoint can only pass on what its sources actually supply.
    // The resulting flow is then written back onto every visual edge along the path.
    const outEdgesOf = {};
    allEdges.forEach(e => { (outEdgesOf[e.fromNode] = outEdgesOf[e.fromNode] || []).push(e); });
    const flowEdges = [];
    allEdges.forEach(edge => {
        if (isWaypoint(edge.fromNode)) return; // routes are enumerated from their real source only
        if (!isWaypoint(edge.toNode)) {
            flowEdges.push({ fromNode: edge.fromNode, toNode: edge.toNode, item: edge.item, order: edge.createdAt, tie: edge.createdAt, path: [edge.id] });
            return;
        }
        const seenSinks = new Set();
        const walk = (wpId, path, visited, maxOrder) => {
            (outEdgesOf[wpId] || []).forEach(next => {
                if (next.item !== edge.item || visited.has(next.toNode)) return;
                const nextPath = [...path, next.id];
                const order = Math.max(maxOrder, next.createdAt);
                if (isWaypoint(next.toNode)) {
                    walk(next.toNode, nextPath, new Set([...visited, next.toNode]), order);
                } else if (!seenSinks.has(next.toNode)) {
                    seenSinks.add(next.toNode);
                    flowEdges.push({ fromNode: edge.fromNode, toNode: next.toNode, item: edge.item, order, tie: edge.createdAt, path: nextPath });
                }
            });
        };
        walk(edge.toNode, [edge.id], new Set([edge.toNode]), edge.createdAt);
    });

    flowEdges.sort((a, b) => (a.order - b.order) || (a.tie - b.tie));
    flowEdges.forEach(fe => {
        const outKey = plannerPortKey(fe.fromNode, fe.item, 'out');
        const inKey = plannerPortKey(fe.toNode, fe.item, 'in');
        const flow = Math.max(0, Math.min(portRemaining[outKey] ?? 0, portRemaining[inKey] ?? 0));
        portRemaining[outKey] = (portRemaining[outKey] ?? 0) - flow;
        portRemaining[inKey] = (portRemaining[inKey] ?? 0) - flow;
        fe.path.forEach(eid => { edgeFlow[eid] += flow; });
    });

    // Waypoint ports simply display the throughput; they never count as surplus/shortage.
    Object.values(planData.nodes).forEach(node => {
        if (node.kind !== 'waypoint') return;
        const ports = nodePortsCache[node.id];
        if (!ports) return;
        let maxFlow = 0;
        ports.inputs.forEach(p => {
            const inKey = plannerPortKey(node.id, p.item, 'in');
            const outKey = plannerPortKey(node.id, p.item, 'out');
            let inFlow = 0, outFlow = 0;
            (portConnections[inKey] || []).forEach(eid => inFlow += edgeFlow[eid]);
            (portConnections[outKey] || []).forEach(eid => outFlow += edgeFlow[eid]);
            const totalFlow = Math.max(inFlow, outFlow);
            maxFlow = Math.max(maxFlow, totalFlow);
            portTheoretical[inKey] = portTheoretical[outKey] = totalFlow;
            portRemaining[inKey] = portRemaining[outKey] = 0;
            p.rate = totalFlow;
        });
        ports.outputs.forEach(p => { p.rate = portTheoretical[plannerPortKey(node.id, p.item, 'out')] || 0; });
        node.machineCount = maxFlow || 1;
    });

    const flows = { nodePortsCache, portTheoretical, portRemaining, portConnections, edgeFlow };
    if (isMain) _plannerLastFlows = flows;
    return flows;
}

function plannerGetAvailableRateAtPort(nodeId, item, dir) {
    const flows = plannerResolveFlows();
    const key = plannerPortKey(nodeId, item, dir);
    return flows.portRemaining[key] ?? (flows.portTheoretical[key] ?? 0);
}

/**
 * All edges on a port (nodeId + item + dir), sorted by createdAt (smaller = higher priority).
 * dir === 'out': edges with fromNode === nodeId (priority when the node is the supplier)
 * dir === 'in' : edges with toNode   === nodeId (priority when the node is the consumer)
 */
function plannerGetSiblingEdges(nodeId, item, dir) {
    return Object.values(plannerState.edges)
        .filter(e => e.item === item && (dir === 'out' ? e.fromNode === nodeId : e.toNode === nodeId))
        .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Swap edgeId's createdAt with the neighboring edge in its port's priority order (fromNode-out or toNode-in),
 * to change the first-come-first-served flow order. delta: -1 (up / higher priority) or +1 (down / lower priority).
 */
function plannerMoveEdgePriority(edgeId, dir, delta) {
    const edge = plannerState.edges[edgeId];
    if (!edge) return;
    const nodeId = dir === 'out' ? edge.fromNode : edge.toNode;
    const siblings = plannerGetSiblingEdges(nodeId, edge.item, dir);
    const idx = siblings.findIndex(e => e.id === edgeId);
    const swapIdx = idx + delta;
    if (idx === -1 || swapIdx < 0 || swapIdx >= siblings.length) return;

    const other = siblings[swapIdx];
    const tmp = edge.createdAt;
    edge.createdAt = other.createdAt;
    other.createdAt = tmp;

    recomputeAndRefreshPlanner();
    savePlannerState();
    openPlannerEdgeModal(edgeId); // Re-render the modal to refresh the order/flow display
}

/* ==========================================================================
   SECTION: GRAPH NODE BFS
   ========================================================================== */

/** BFS from sourceNodeId: every node id in its undirected connected component (including itself) */
function getPlannerConnectedNodeIds(startNodeId) {
    const adjacency = {};
    Object.values(plannerState.edges).forEach(e => {
        (adjacency[e.fromNode] = adjacency[e.fromNode] || []).push(e.toNode);
        (adjacency[e.toNode] = adjacency[e.toNode] || []).push(e.fromNode);
    });
    const visited = new Set([startNodeId]);
    const queue = [startNodeId];
    while (queue.length) {
        const cur = queue.shift();
        (adjacency[cur] || []).forEach(nb => {
            if (!visited.has(nb)) { visited.add(nb); queue.push(nb); }
        });
    }
    return [...visited];
}

/** BFS against edge direction (toNode -> fromNode): every upstream node supplying this node (including itself) */
function getPlannerUpstreamNodeIds(startNodeId) {
    const inAdj = {};
    Object.values(plannerState.edges).forEach(e => {
        (inAdj[e.toNode] = inAdj[e.toNode] || []).push(e.fromNode);
    });
    const visited = new Set([startNodeId]);
    const queue = [startNodeId];
    while (queue.length) {
        const cur = queue.shift();
        (inAdj[cur] || []).forEach(nb => {
            if (!visited.has(nb)) { visited.add(nb); queue.push(nb); }
        });
    }
    return visited;
}

/** BFS along edge direction (fromNode -> toNode): every downstream node consuming this node (including itself) */
function getPlannerDownstreamNodeIds(startNodeId) {
    const outAdj = {};
    Object.values(plannerState.edges).forEach(e => {
        (outAdj[e.fromNode] = outAdj[e.fromNode] || []).push(e.toNode);
    });
    const visited = new Set([startNodeId]);
    const queue = [startNodeId];
    while (queue.length) {
        const cur = queue.shift();
        (outAdj[cur] || []).forEach(nb => {
            if (!visited.has(nb)) { visited.add(nb); queue.push(nb); }
        });
    }
    return visited;
}

/* ==========================================================================
   SECTION: AUTO-GENERATE UPSTREAM NODES
   ========================================================================== */

/** Estimated node card height: 116px base + 24px * max(input ports, output ports) */
function estimatePlannerNodeHeight(recipe) {
    if (!recipe) return 116;
    const inCount = Object.keys(recipe.inputs || {}).length;
    const outCount = Object.keys(recipe.outputs || {}).length;
    return 116 + 24 * Math.max(inCount, outCount);
}

/**
 * Generate upstream nodes to the left of the source node for its current input shortfall (using preferred recipes)
 * and connect them. Only one level; no recursion (see autoGenerateAllUpstreamNodes for the recursive version).
 * Returns the ids of the nodes created by this call (for recursion); no render/save (the caller does that).
 */
function _autoGenerateUpstreamNodesCore(nodeId) {
    const sourceNode = plannerState.nodes[nodeId];
    if (!sourceNode) return [];

    const flows = plannerResolveFlows();
    const ports = flows.nodePortsCache[nodeId];
    if (!ports) return [];

    const deficits = [];
    ports.inputs.forEach(p => {
        const key = plannerPortKey(nodeId, p.item, 'in');
        const remaining = flows.portRemaining[key] ?? 0;
        if (remaining > 0.001) deficits.push({ item: p.item, deficit: remaining });
    });
    if (deficits.length === 0) return [];

    const plans = [];
    deficits.forEach(({ item, deficit }) => {
        // The node makes this item itself (e.g. Coke-fuelled Coke crucible): feed it from its own output
        if (sourceNode.kind !== 'portal' && sourceNode.kind !== 'waypoint' && ports.outputs.some(o => o.item === item)) {
            const exists = Object.values(plannerState.edges).some(e => e.fromNode === nodeId && e.toNode === nodeId && e.item === item);
            if (!exists) {
                plannerState._edgeSeq = (plannerState._edgeSeq || 0) + 1;
                const edgeId = 'pedge_' + plannerState._edgeSeq;
                plannerState.edges[edgeId] = { id: edgeId, item, fromNode: nodeId, toNode: nodeId, createdAt: plannerState._edgeSeq };
            }
            return;
        }
        const recipe = getActiveRecipe(item);
        if (!recipe) return; // Skip items without a recipe (raw materials / external inputs)

        const rates = plannerGetRecipeRates(recipe.id, DB.settings.recipeModifiers?.[recipe.id]);
        if (!rates) return;
        const perMachineRate = (rates.outputsPerMachine.find(p => p.item === item) || {}).rate || 0;
        if (perMachineRate <= 0) return;

        let machineCount = deficit / perMachineRate;
        machineCount = Math.max(0, machineCount);

        plans.push({ item, recipe, recipeModifiers: DB.settings.recipeModifiers?.[recipe.id], machineCount });
    });
    if (plans.length === 0) return [];

    const sourceEl = document.getElementById('planner-node-' + nodeId);
    const sourceHeight = sourceEl ? sourceEl.offsetHeight : 116;
    const newNodeWidth = 250; // Default .planner-node width in style.css
    let x = plannerSnapVal(sourceNode.x - newNodeWidth - 120);

    const heights = plans.map(p => estimatePlannerNodeHeight(p.recipe));
    const baseGap = _plannerSettings.gridSize ? Math.min(80, Math.max(20, _plannerSettings.gridSize)) : 20;
    const count = plans.length;
    const yPositions = new Array(count);

    if (count % 2 === 1) {
        const midIdx = Math.floor(count / 2);
        yPositions[midIdx] = sourceNode.y;
        let curTop = sourceNode.y;
        for (let i = midIdx - 1; i >= 0; i--) {
            curTop -= (baseGap + heights[i + 1]);
            yPositions[i] = curTop;
        }
        let curBottom = sourceNode.y + heights[midIdx];
        for (let i = midIdx + 1; i < count; i++) {
            yPositions[i] = curBottom + baseGap;
            curBottom = yPositions[i] + heights[i];
        }
    } else {
        const totalHeight = heights.reduce((s, h) => s + h, 0) + baseGap * (count - 1);
        const sourceCenterY = sourceNode.y + sourceHeight / 2;
        let curY = sourceCenterY - totalHeight / 2;
        for (let i = 0; i < count; i++) {
            yPositions[i] = curY;
            curY += heights[i] + baseGap;
        }
    }

    const createdIds = [];
    plans.forEach((plan, i) => {
        let y = plannerSnapVal(yPositions[i]);

        plannerState._nodeSeq = (plannerState._nodeSeq || 0) + 1;
        const newNodeId = 'pnode_' + plannerState._nodeSeq;
        plannerState.nodes[newNodeId] = {
            id: newNodeId, kind: 'recipe',
            recipeId: plan.recipe.id,
            recipeModifiers: plan.recipeModifiers,
            machineCount: plan.machineCount,
            x: Math.round(x),
            y: Math.round(y)
        };

        plannerState._edgeSeq = (plannerState._edgeSeq || 0) + 1;
        const edgeId = 'pedge_' + plannerState._edgeSeq;
        plannerState.edges[edgeId] = {
            id: edgeId, item: plan.item, fromNode: newNodeId, toNode: nodeId,
            createdAt: plannerState._edgeSeq
        };

        createdIds.push(newNodeId);
    });

    return createdIds;
}

/** Public version: expand one level, then render + save right away */
function autoGenerateUpstreamNodes(nodeId) {
    const created = _autoGenerateUpstreamNodesCore(nodeId);
    if (created.length === 0) return;
    renderPlanner();
    savePlannerState();
}

/**
 * Recursive version: keep expanding upstream from nodeId until no node has a shortfall.
 */
function autoGenerateAllUpstreamNodes(rootNodeId) {
    const expandingRecipes = new Set();
    const allCreated = [];

    function dfs(nodeId) {
        const node = plannerState.nodes[nodeId];
        if (!node) return;
        // Portals may be the root (e.g. "I need 100 Coal/min here"); everything generated below is a recipe node.
        const isPortalRoot = nodeId === rootNodeId && node.kind === 'portal';
        if (node.kind !== 'recipe' && !isPortalRoot) return;

        if (nodeId != rootNodeId) {
            const cats = node.recipeModifiers?.catalysts;
            if (cats && cats.length > 0) return; // Don't expand child nodes that use catalysts
        }

        if (expandingRecipes.has(node.recipeId))
            return;

        expandingRecipes.add(node.recipeId);

        const created = _autoGenerateUpstreamNodesCore(nodeId);
        allCreated.push(...created);
        created.forEach(dfs);

        expandingRecipes.delete(node.recipeId);
    }

    dfs(rootNodeId);
    console.info('Create upstream nodes: ' + allCreated.length);

    // Size everything (including loops such as self-fed fuel) to exactly what the root needs
    if (!_calculateNodeDemand(rootNodeId).ok) console.warn('Upstream contains a loop that cannot feed itself; left unbalanced.');

    _plannerSelectedNodeIds.clear();
    _plannerSelectedNodeIds.add(rootNodeId);
    allCreated.forEach(id => _plannerSelectedNodeIds.add(id));

    renderPlanner();
    savePlannerState();
}

/** Select rootNodeId and all its upstream nodes (every ancestor along input edges), add them to the selection and redraw */
function plannerSelectAllUpstreamNodes(rootNodeId) {
    const visited = getPlannerUpstreamNodeIds(rootNodeId);
    _plannerSelectedNodeIds.clear();
    visited.forEach(id => _plannerSelectedNodeIds.add(id));
    renderPlanner();
}

/** Delete every upstream node except rootNodeId */
function removeAllUpsteamNodes(rootNodeId) {
    const visited = getPlannerUpstreamNodeIds(rootNodeId);
    visited.delete(rootNodeId);
    visited.forEach(nId => delete plannerState.nodes[nId]);
    renderPlanner();
    savePlannerState();
}

/* ==========================================================================
   SECTION: LAYOUT UPSTREAM (BFS spanning tree, RT-style layout)
   ========================================================================== */

const PLANNER_LAYOUT_COL_GAP = 280;   // Horizontal gap between depth levels (including node width)
const PLANNER_LAYOUT_ROW_GAP = 40;    // Minimum vertical gap between nodes on the same level

/**
 * Lay out only the upstream nodes of rootNodeId.
 * First BFS backwards along input edges to build a spanning tree
 * (each node keeps only the first edge that reached it as its parent; cross-subtree edges are ignored for layout).
 * Then compute each subtree's vertical space post-order and assign coordinates top-down pre-order,
 * centering each parent on its children (similar to a D3 tree / Reingold-Tilford layout).
 * The root stays where it is; upstream levels spread to the left of the root's x.
 */
function plannerAutoLayoutUpstream(rootNodeId) {
    const root = plannerState.nodes[rootNodeId];
    if (!root) return;

    const inAdj = {};
    Object.keys(plannerState.nodes).forEach(id => { inAdj[id] = []; });
    Object.values(plannerState.edges).forEach(e => {
        if (!inAdj[e.toNode] || !plannerState.nodes[e.fromNode]) return;
        inAdj[e.toNode].push(e.fromNode);
    });

    const children = _plannerBuildUpstreamTree(rootNodeId, inAdj);
    if (Object.keys(children).length === 0 || (children[rootNodeId] || []).length === 0) return; // No upstream nodes to lay out

    const extents = {};
    _plannerComputeExtent(rootNodeId, children, extents);
    _plannerAssignTreeCoordinates(rootNodeId, children, extents);

    renderPlanner();
    savePlannerState();
}

/**
 * BFS along inAdj (against edge direction, going upstream) to build a spanning tree rooted at rootId.
 * Each node gets exactly one parent (the node that first reached it); if a node feeds several
 * downstream nodes (merge), only the first path is a tree edge and the rest are ignored for layout.
 * Returns { [nodeId]: childNodeId[] }, only for nodes with children (leaves are not included).
 */
function _plannerBuildUpstreamTree(rootId, inAdj) {
    const visited = new Set([rootId]);
    const children = {};
    const queue = [rootId];
    while (queue.length) {
        const cur = queue.shift();
        (inAdj[cur] || []).forEach(parent => {
            if (visited.has(parent)) return; // Already claimed by another node, treat as a cross edge
            visited.add(parent);
            (children[cur] = children[cur] || []).push(parent);
            queue.push(parent);
        });
    }
    return children;
}

/**
 * Post-order: compute the vertical space (extent) each subtree needs.
 * Leaf: extent = its own card height.
 * Non-leaf: extent = sum of child extents + gaps, and at least its own card height
 */
function _plannerComputeExtent(nodeId, children, extents) {
    const el = document.getElementById('planner-node-' + nodeId);
    const ownHeight = el ? el.offsetHeight : 140;
    const kids = children[nodeId] || [];

    if (kids.length === 0) {
        extents[nodeId] = ownHeight;
        return ownHeight;
    }

    let childrenTotal = 0;
    kids.forEach(childId => {
        childrenTotal += _plannerComputeExtent(childId, children, extents);
    });
    childrenTotal += (kids.length - 1) * PLANNER_LAYOUT_ROW_GAP;

    const extent = Math.max(ownHeight, childrenTotal);
    extents[nodeId] = extent;
    return extent;
}

/**
 * Pre-order: assign coordinates top-down.
 * Each node gets a vertical range [top, top+extent);
 * its children are stacked in order and centered within that range,
 * and the parent's own y is centered between the first and last child's centers.
 * x depends only on depth: the root is depth 0, and each level upstream moves one COL_GAP to the left.
 */
function _plannerAssignTreeCoordinates(rootId, children, extents) {
    const root = plannerState.nodes[rootId];

    function place(nodeId, depth, top, extent) {
        const kids = children[nodeId] || [];
        const node = plannerState.nodes[nodeId];

        if (depth > 0) node.x = root.x - depth * PLANNER_LAYOUT_COL_GAP;

        if (kids.length === 0) {
            if (depth > 0) node.y = top; // A leaf takes the top of its range (range height = its own height)
            return;
        }

        // Stack the children in order and record each center y for centering the parent
        let cursor = top;
        const childCenters = [];
        kids.forEach(childId => {
            const childExtent = extents[childId];
            place(childId, depth + 1, cursor, childExtent);
            childCenters.push(cursor + childExtent / 2);
            cursor += childExtent + PLANNER_LAYOUT_ROW_GAP;
        });

        if (depth > 0) {
            const centerY = (childCenters[0] + childCenters[childCenters.length - 1]) / 2;
            const el = document.getElementById('planner-node-' + nodeId);
            const ownHeight = el ? el.offsetHeight : 140;
            node.y = centerY - ownHeight / 2;
        }
    }

    place(rootId, 0, root.y - extents[rootId] / 2, extents[rootId]);
}

/* ==========================================================================
   SECTION: IMPORT FROM CALCULATOR RESULT
   ========================================================================== */

/**
 * Convert the Calculator tab's current result (calcResult = return value of AlchemyCalcEngine.runCalculation)
 * into planner nodes and add them to the active plan.
 *
 * Stage 1: walk treeRoots and aggregate nodes by recipe.id (summing machineCount), skipping raw/external leaves
 * Stage 2: create the main parent-child edges
 * Stage 3: pair positive/negative byproducts[].producers entries to create recycle edges
 *          (a negative entry's pathKey is the node producing the byproduct; the recycle edge should connect to
 *           its parent, because the parent is the recipe that actually consumes the byproduct)
 * Stage 4: add to the current plan, offset by the existing nodes' bounding box to avoid overlap
 * Stage 5: reuse the RT-style layout (a virtual root wrapping the real roots)
 * Stage 6: after resolveFlows, remove recycle edges whose flow is close to 0
 */
function plannerImportFromCalcResult(calcResult, params) {
    if (!calcResult || !calcResult.treeRoots || calcResult.treeRoots.length === 0) {
        alert(t('No calculation result to import.', 'ui'));
        return;
    }

    const aggMap = {};          // recipeId -> { recipeId, recipeModifiers, machineCount }
    const pathKeyToAgg = {};    // pathKey -> recipeId (only paths aggregated into nodes)
    const parentOfPathKey = {}; // pathKey -> parent's pathKey (or null)
    const pendingEdgeSet = new Set();
    const pendingEdges = [];    // { fromKey, toKey, item, isRecycle }
    const rootAggKeys = new Set();

    function addPendingEdge(fromKey, toKey, item, isRecycle) {
        if (!fromKey || !toKey) return;
        const dedupeKey = `${fromKey}|${toKey}|${item}`;
        if (pendingEdgeSet.has(dedupeKey)) return;
        pendingEdgeSet.add(dedupeKey);
        pendingEdges.push({ fromKey, toKey, item, isRecycle: !!isRecycle });
    }

    // ---- Stage 1 + 2: walk the tree, aggregate nodes + create main edges ----
    function walk(node, parentPathKey, parentAggKey) {
        parentOfPathKey[node.pathKey] = parentPathKey;

        const isAggregatable = node.recipe && !node.isRaw && !node.isExternal;
        if (!isAggregatable) return; // raw/external/recipe-less leaf: skip, no node

        const key = node.recipe.id;
        pathKeyToAgg[node.pathKey] = key;
        if (!aggMap[key]) {
            aggMap[key] = {
                recipeId: node.recipe.id,
                recipeModifiers: DB.settings.recipeModifiers?.[node.recipe.id],
                machineCount: 0
            };
        }
        aggMap[key].machineCount += node.machineCount;

        if (parentAggKey) {
            addPendingEdge(key, parentAggKey, node.item, false);
        }

        node.children.forEach(child => walk(child, node.pathKey, key));
    }

    calcResult.treeRoots.forEach(entry => {
        walk(entry.root, null, null);
        if (entry.root.recipe && !entry.root.isRaw && !entry.root.isExternal) {
            rootAggKeys.add(entry.root.recipe.id);
        }
    });
    // internalModules (fuel/fertilizer modules) are not handled here

    // Aggregated nodes with machineCount <= 0 are not created
    Object.keys(aggMap).forEach(key => {
        if (aggMap[key].machineCount <= 0.000001) {
            delete aggMap[key];
            rootAggKeys.delete(key);
        }
    });

    // ---- Stage 3: recycle edges ----
    (calcResult.byproducts || []).forEach(bypEntry => {
        const item = bypEntry.item;
        const positives = []; // Suppliers (nodes producing this byproduct)
        const negatives = []; // Consumers (the node's parent, the recipe that actually uses this byproduct)

        (bypEntry.producers || []).forEach(p => {
            if (p.rate > 0.0001) {
                const aggKey = pathKeyToAgg[p.pathKey];
                if (aggKey && aggMap[aggKey]) positives.push(aggKey);
            } else if (p.rate < -0.0001) {
                const parentPathKey = parentOfPathKey[p.pathKey];
                const parentAggKey = parentPathKey ? pathKeyToAgg[parentPathKey] : null;
                if (parentAggKey && aggMap[parentAggKey]) negatives.push(parentAggKey);
            }
        });

        positives.forEach(fromKey => {
            negatives.forEach(toKey => addPendingEdge(fromKey, toKey, item, true));
        });
    });

    if (Object.keys(aggMap).length === 0) {
        alert(t('Nothing to import (no producible nodes).', 'ui'));
        return;
    }

    // ---- Stage 4: add to the current plan, compute the coordinate offset ----
    const hasExisting = Object.keys(plannerState.nodes).length > 0;
    let existingMaxX = -Infinity, existingMinY = Infinity;
    if (hasExisting) {
        Object.values(plannerState.nodes).forEach(n => {
            existingMaxX = Math.max(existingMaxX, n.x + 200); // 200 = card width
            existingMinY = Math.min(existingMinY, n.y);
        });
    }
    const offsetX = hasExisting ? existingMaxX + 150 : 0;
    const offsetY = hasExisting ? existingMinY : 0;

    // Create the actual nodes
    const keyToNodeId = {};
    Object.entries(aggMap).forEach(([key, agg]) => {
        plannerState._nodeSeq = (plannerState._nodeSeq || 0) + 1;
        const nodeId = 'pnode_' + plannerState._nodeSeq;
        keyToNodeId[key] = nodeId;
        plannerState.nodes[nodeId] = {
            id: nodeId, kind: 'recipe',
            recipeId: agg.recipeId,
            recipeModifiers: agg.recipeModifiers,
            machineCount: agg.machineCount,
            x: 0, y: 0
        };
    });


    // ---- Create the actual edges; recycle edges get a smaller createdAt than all existing edges, so top priority ----

    let existingMinCreatedAt = 0;
    Object.values(plannerState.edges).forEach(e => {
        existingMinCreatedAt = Math.min(existingMinCreatedAt, e.createdAt);
    });
    let nextRecycleCreatedAt = existingMinCreatedAt - 1; // Decreasing, so recycle edges all come first

    const recycleEdgeIds = [];
    pendingEdges.forEach(({ fromKey, toKey, item, isRecycle }) => {
        const fromNode = keyToNodeId[fromKey], toNode = keyToNodeId[toKey];
        if (!fromNode || !toNode) return;
        plannerState._edgeSeq = (plannerState._edgeSeq || 0) + 1;
        const edgeId = 'pedge_' + plannerState._edgeSeq;
        const createdAt = isRecycle ? (nextRecycleCreatedAt--) : plannerState._edgeSeq;
        plannerState.edges[edgeId] = { id: edgeId, item, fromNode, toNode, createdAt, ...(isRecycle ? {color: 'var(--byproduct)'} : {}) };
        if (isRecycle) recycleEdgeIds.push(edgeId);
    });

    // ---- Stage 5: layout ----
    const newNodeIds = Object.values(keyToNodeId);
    const rootNodeIds = [...rootAggKeys].map(k => keyToNodeId[k]).filter(Boolean);
    _plannerLayoutImportedGraph(newNodeIds, rootNodeIds, offsetX, offsetY);

    // ---- Stage 6: remove recycle edges with flow close to 0 ----
    const flows = plannerResolveFlows();
    recycleEdgeIds.forEach(eid => {
        if (plannerState.edges[eid] && (flows.edgeFlow[eid] || 0) < 0.001) {
            delete plannerState.edges[eid];
        }
    });

    renderPlanner();
    savePlannerState();
    requestAnimationFrame(() => plannerFitToView(newNodeIds));
}

/**
 * Apply the RT-style layout to a batch of newly imported nodes:
 * hang all real roots under a virtual root that never becomes a node,
 * reuse _plannerBuildUpstreamTree / _plannerComputeExtent / _plannerAssignTreeCoordinates,
 * then delete the virtual root and move the whole batch by offsetX/offsetY.
 */
function _plannerLayoutImportedGraph(newNodeIds, rootNodeIds, offsetX, offsetY) {
    if (newNodeIds.length === 0) return;

    const virtualId = '__virtual_root__';
    plannerState.nodes[virtualId] = { id: virtualId, kind: 'recipe', x: 0, y: 0, machineCount: 0, recipeId: null };

    // Render once so the new nodes' DOM cards exist and their height can be measured for _plannerComputeExtent
    renderPlanner();

    const idSet = new Set(newNodeIds);
    const inAdj = {};
    newNodeIds.forEach(id => inAdj[id] = []);
    inAdj[virtualId] = rootNodeIds.length > 0 ? rootNodeIds : newNodeIds;

    Object.values(plannerState.edges).forEach(e => {
        if (idSet.has(e.fromNode) && idSet.has(e.toNode) && inAdj[e.toNode]) {
            inAdj[e.toNode].push(e.fromNode);
        }
    });

    const children = _plannerBuildUpstreamTree(virtualId, inAdj);
    const extents = {};
    _plannerComputeExtent(virtualId, children, extents);
    _plannerAssignTreeCoordinates(virtualId, children, extents);

    delete plannerState.nodes[virtualId];

    let minX = Infinity, minY = Infinity;
    newNodeIds.forEach(id => {
        const n = plannerState.nodes[id];
        if (!n) return;
        minX = Math.min(minX, n.x);
        minY = Math.min(minY, n.y);
    });
    if (!isFinite(minX)) { minX = 0; minY = 0; }

    newNodeIds.forEach(id => {
        const n = plannerState.nodes[id];
        if (!n) return;
        n.x = plannerSnapVal(n.x - minX + offsetX);
        n.y = plannerSnapVal(n.y - minY + offsetY);
    });
}

/* ==========================================================================
   SECTION: ENCAPSULATE SELECTED NODES INTO MODULE
   ========================================================================== */

/** From the selected nodes' output ports, the item with the highest cauldronCost, used for naming */
function _findHighestCauldronCostOutputItem(nodeIds) {
    let bestItem = null;
    let bestCost = -Infinity;
    nodeIds.forEach(id => {
        const node = plannerState.nodes[id];
        if (!node) return;
        const rates = plannerGetRecipeRates(node.recipeId, node.recipeModifiers);
        if (!rates) return;
        rates.outputsPerMachine.forEach(({ item }) => {
            const cost = DB.items[item]?.cauldronCost;
            if (typeof cost === 'number' && cost > bestCost) {
                bestCost = cost;
                bestItem = item;
            }
        });
    });
    return bestItem;
}

/** Wrap the selected nodes and their internal edges into a new module (plan) and leave a module node in their place */
function encapsulatePlannerSelectedNodes() {
    const selectedIds = [..._plannerSelectedNodeIds];
    if (selectedIds.length === 0) return;
    const selectedSet = new Set(selectedIds);

    // 1. Classify edges
    const internalEdges = [];
    const inEdges = [];
    const outEdges = [];
    Object.values(plannerState.edges).forEach(edge => {
        const fromIn = selectedSet.has(edge.fromNode);
        const toIn = selectedSet.has(edge.toNode);
        if (fromIn && toIn) internalEdges.push(edge);
        else if (toIn) inEdges.push(edge);
        else if (fromIn) outEdges.push(edge);
    });

    // 2. Name: the highest-cauldronCost output among the selected nodes, otherwise a timestamp
    const namingItem = _findHighestCauldronCostOutputItem(selectedIds);
    const planName = namingItem ? `${t('Module', 'ui')} - ${namingItem}` : `${t('Module', 'ui')} - ${Date.now()}`;

    // 3. Center of the selected nodes (where the new module node goes)
    let sumX = 0, sumY = 0, count = 0;
    selectedIds.forEach(id => {
        const node = plannerState.nodes[id];
        if (!node) return;
        const el = document.getElementById('planner-node-' + id);
        const w = el ? el.offsetWidth : 250;
        const h = el ? el.offsetHeight : 140;
        sumX += node.x + w / 2;
        sumY += node.y + h / 2;
        count++;
    });
    const centerX = count > 0 ? sumX / count : 0;
    const centerY = count > 0 ? sumY / count : 0;

    // 4. Create the new plan and move the nodes + internal edges into it (deep copy)
    const newPlan = _createPlan(planName);
    newPlan.data.nodes = {};
    selectedIds.forEach(id => {
        const node = plannerState.nodes[id];
        if (node) newPlan.data.nodes[id] = JSON.parse(JSON.stringify(node));
    });
    newPlan.data.edges = {};
    internalEdges.forEach(edge => {
        newPlan.data.edges[edge.id] = JSON.parse(JSON.stringify(edge));
    });
    // So ids of nodes/edges added to the new plan later don't collide with the moved ids
    newPlan.data._nodeSeq = plannerState._nodeSeq || 0;
    newPlan.data._edgeSeq = plannerState._edgeSeq || 0;

    // 5. Remove the selected nodes + internal edges from the original plan
    selectedIds.forEach(id => delete plannerState.nodes[id]);
    internalEdges.forEach(edge => delete plannerState.edges[edge.id]);

    // 6. Create the new module node in their place
    plannerState._nodeSeq = (plannerState._nodeSeq || 0) + 1;
    const moduleNodeId = 'pnode_' + plannerState._nodeSeq;
    plannerState.nodes[moduleNodeId] = {
        id: moduleNodeId, kind: 'module',
        recipeId: null,
        moduleId: newPlan.id,
        machineCount: 1,
        x: Math.round(centerX - 100),
        y: Math.round(centerY - 70)
    };

    // 7. Point the in/out edges at the new module node
    inEdges.forEach(edge => { edge.toNode = moduleNodeId; });
    outEdges.forEach(edge => { edge.fromNode = moduleNodeId; });

    // 8. Register the new plan in the library and create its initial undo snapshot
    plannerLibrary.plans[newPlan.id] = newPlan;
    plannerLibrary.planOrder.push(newPlan.id);
    plannerHistory[newPlan.id] = {
        stack: [JSON.parse(JSON.stringify(newPlan.data))],
        index: 0
    };

    // 9. Clear the selection, redraw and save
    _plannerSelectedNodeIds.clear();
    renderPlanner();
    savePlannerState();       // Record this edit of the (original) plan in undo history
    savePlannerLibraryMeta(); // Make sure the new plan is written to localStorage
    renderPlannerToolbarSelect(); // So the dropdown can select the new plan
}

function plannerGetPortalRates(node) {
    const result = { recipe: null, inputsPerMachine: [], outputsPerMachine: [], heatItemsPerMachine: 0, fertItemsPerMachine: 0, errorCode: '' };
    const item = node.portalItem;
    if (item === 'Any') return { ...result, inputsPerMachine: [{ item: 'Any', rate: 1 }], outputsPerMachine: [{ item: 'Any', rate: 1 }] };
    if (!item || !DB.items[item]) return { ...result, errorCode: 'No Item Selected' };
    return { ...result, inputsPerMachine: [{ item, rate: 1 }], outputsPerMachine: [{ item, rate: 1 }] };
}
