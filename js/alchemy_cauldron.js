/* ==========================================================================
   SECTION: CAULDRON STORAGE
   ========================================================================== */

const CAULDRON_STORAGE_KEY = "alchemy_cauldron_v1";

let cauldronState = {
    activeType: 0, // 0: Cauldron, 1: Advanced Cauldron
    activeProfile: 0,
    favorites: [],
    heatPerCopper: 20,   // Heat-to-copper conversion rate
    nutrPerCopper: 12,   // Nutrient-to-copper conversion rate
    showEstCost: true,
    orderByEstCost: true,
    stepMode: 0,   // 0: single step, 1: multi-step
    intermediateLimit: 3,   // Max number of intermediate products in multi-step mode
    profiles: [
        { candidates: [] }, // Profile 1
        { candidates: [] }, // Profile 2
        { candidates: [] }  // Profile 3
    ]
};

// Multi-step result cache
let multiStepState = {
    dirty: true,
    steps: [null, null, null, null]  // Map<item, {cost, cauldronCostSum, recipeInputs}>
};

// Active upstream filter: { item, stepIdx } or null (no filter)
let _multiStepUpstreamFilter = null;

let cauldronCandidates = new Set(); // Names of the checked items
let cauldronCatFilter = "[All]";
let cauldronFilterItems = [null, null, null];
let cauldronTargetOutput = null;
let _cauldronCostCache = new Map();   // item name -> number | null

function isVaildCandidate(itemName) {
    const item = DB.items[itemName];
    return item && item.cauldronCost !== undefined && !(item.liquid) && !(item.virtual);
}

// Init: called after init() in alchemy_ui.js
function initCauldron() {
    loadCauldronSettings();    
    buildItemBaseCost();
    populateCauldronCategories();
    renderCandidatePool();
    renderCauldronFavorites();
    translateText();
    pickFilterItem(1,true);
    pickFilterItem(2,true);
    updateCauldronTargetOutputUI();
    switchCauldronType(cauldronState.activeType, false);
    switchCauldronProfile(cauldronState.activeProfile, false);
    switchCauldronStepMode(cauldronState.stepMode, false);
    document.getElementById('cauldron-order-by-est-cost').checked = cauldronState.orderByEstCost;
    document.getElementById('cauldron-show-est-cost').checked = cauldronState.showEstCost;
    document.getElementById('cauldron-intermediate-limit').value = cauldronState.intermediateLimit;    
    runCauldronSimulation();
}

function loadCauldronSettings() {
    const saved = localStorage.getItem(CAULDRON_STORAGE_KEY);
    if (saved) {
        try {
            cauldronState = JSON.parse(saved);
        } catch (e) {
            console.error("Cauldron settings corrupt, using defaults.");
        }
    } else {
        // On first run, Profile 1 selects everything
        cauldronState.profiles[0].candidates = Object.keys(DB.items).filter(isVaildCandidate);        
        // Profile 2 defaults to plants + their products
        cauldronState.profiles[1].candidates = Array.from(getPresetCandidates('Herbs'));
        // Profile 3 defaults to coins + raw materials
        cauldronState.profiles[2].candidates = Array.from(getPresetCandidates('Gold'));
        cauldronState.showEstCost = true;
        cauldronState.orderByEstCost = true;
    }
    if (!(cauldronState.heatPerCopper > 0)) cauldronState.heatPerCopper = 20;
    if (!(cauldronState.nutrPerCopper > 0)) cauldronState.nutrPerCopper = 12;
    if (cauldronState.stepMode === undefined) cauldronState.stepMode = 0;
    if (cauldronState.intermediateLimit === undefined) cauldronState.intermediateLimit = 3;
}

function saveCauldronSettings() {
    // Sync the Set back to the current profile
    cauldronState.profiles[cauldronState.activeProfile].candidates = Array.from(cauldronCandidates);    
    localStorage.setItem(CAULDRON_STORAGE_KEY, JSON.stringify(cauldronState));
}

function syncCandidatesFromProfile() {
    const currentList = cauldronState.profiles[cauldronState.activeProfile].candidates || [];
    cauldronCandidates = new Set();
    currentList.forEach(key => {if(isVaildCandidate(key)) cauldronCandidates.add(key);});
    cauldronState.profiles[cauldronState.activeProfile].candidates = Array.from(cauldronCandidates);
}

function getPresetCandidates(poolType) {
    let candidateSet = new Set();
    try {
        let inputSet = new Set();
        if (poolType === 'Herbs') {
            Object.entries(DB.items).forEach(([name, item]) => {
                if (item.cauldronCost !== undefined && item.nutrientCost !== undefined) {
                    candidateSet.add(name);
                    inputSet.add(name);
                }
            });

            for (let round = 0; round < 1; round++) {
                let outputSet = new Set();
                for (const { inputs, outputs, machine } of DB.recipes) {
                    const inKeys = Object.keys(inputs || {});
                    const outKeys = Object.keys(outputs || {});
                    if (machine === 'Seed Plot' || DB.machines[machine]?.heatCost) continue;
                    if (inKeys.length >= 1 && outKeys.length === 1 && inKeys.every(key => inputSet.has(key)) && isVaildCandidate(outKeys[0])) {
                        outputSet.add(outKeys[0]);
                        //console.log(outKeys[0] + "," + round);
                    }
                }
                outputSet.forEach(item => candidateSet.add(item));
                inputSet = new Set(outputSet);
            }
        }
        else if (poolType === 'Gold') {
            Object.entries(DB.items).forEach(([name, item]) => {
                if (item.cauldronCost !== undefined && (item.buyPrice !== undefined || item.category === 'Currency')) {
                    candidateSet.add(name);
                }
            });
        }
    }
    catch (e) {
        console.error(e);
    }
    return candidateSet;
}

/* ==========================================================================
   SECTION: Estimate Cost
   ========================================================================== */

/**
 * Starting from base properties (customCost / buyPrice / nutrientCost ...),
 * repeatedly derive an estimated copper value for every item made by a single-output recipe.
 * Only recipes whose inputs all have known values and that have exactly one output are used.
 * Overwrites _cauldronCostCache when done.
 */
function buildItemBaseCost() {
    const cache = new Map();
    const heatPerCopper = cauldronState.heatPerCopper || 20;
    const nutrPerCopper = cauldronState.nutrPerCopper || 12;

    // ---- Round 0: base items (customCost / buyPrice / Currency / heat / nutrientValue) ----
    Object.entries(DB.items).forEach(([name, item]) => {
        let cost = null;
        const custom = DB.settings.customCosts?.[name];

        if (typeof custom === 'number' && custom > 0) {
            cost = custom;
        } else if (item.buyPrice > 0) {
            cost = item.buyPrice;
        } else if (item.category === 'Currency') {
            cost = item.sellPrice;
        } else if (item.nutrientCost > 0) {
            cost = item.nutrientCost / nutrPerCopper;
        }

        if (cost !== null && item.maxStack && item.maxStack < 0) cost /= (-item.maxStack);
        if (cost !== null) cache.set(name, cost);
    });

    function _setBaseCost(originItemName, value) {
        const itemName = getCurrentItemName(originItemName);
        if (DB.items[itemName] && !cache.has(itemName)) cache.set(itemName, value);
    }

    // Special cases for precious metals
    _setBaseCost('Crude Silver Powder', 1500);
    _setBaseCost('Silver Ingot', 6000);
    _setBaseCost('Crude Gold Dust', 12500);
    _setBaseCost('Gold Ingot', 100000);

    // ---- Repeat: find recipes whose inputs are all known and that have a single output ----
    for (;;) {
        const newlyResolved = new Map(); // Values found this round; merged after the full round (first one wins)

        for (const recipe of DB.recipes) {
            // Skip all cauldron recipes, both collected and official ones
            //if (recipe.id.startsWith('AUTO_GENERATED_CAULDRON')) continue;
            if (recipe.machine === 'Cauldron' || recipe.machine === 'Advanced Cauldron') continue;

            const outKeys = Object.keys(recipe.outputs || {});
            if (outKeys.length !== 1) continue; // Skip multi-output recipes
            const outName = outKeys[0];
            if (cache.has(outName) || newlyResolved.has(outName)) continue;

            const inKeys = Object.keys(recipe.inputs || {});
            if (inKeys.length === 0) continue; // Recipes without inputs (Bank Portal etc.) are not used
            if (!inKeys.every(k => cache.has(k))) continue;

            // Items with negative maxStack: convert the cached value back to one whole item first
            let inputCostSum = 0;
            inKeys.forEach(k => { 
                const maxStack = DB.items[k]?.maxStack;
                inputCostSum += cache.get(k) * ((maxStack < 0) ? -maxStack : 1) * recipe.inputs[k]; 
            });

            // Machine heat use -> copper cost (approximation: heat per batch from the recipe's baseTime)
            let heatCostPerBatch = 0;
            const machine = DB.machines[recipe.machine];
            if (machine && machine.heatCost) {
                heatCostPerBatch = machine.heatCost > 0
                    ? machine.heatCost * (recipe.baseTime || 1)
                    : (recipe.heatCost || 0); // heatCost < 0 (e.g. Cauldron) uses the recipe's own heatCost
            }
            const heatCostConverted = heatCostPerBatch / heatPerCopper;


            const outQty = recipe.outputs[outName];
            const maxStack = DB.items[outName]?.maxStack;
            const unitCost = (inputCostSum + heatCostConverted) / outQty;
            const finalValue = maxStack < 0 ? (unitCost / -maxStack) : unitCost; // Convert back to the cost of a single portion
            newlyResolved.set(outName, finalValue); 
        }

        if (newlyResolved.size === 0) break; // Nothing new to derive, done
        newlyResolved.forEach((cost, name) => cache.set(name, cost));
    }

    _cauldronCostCache = cache;
    return cache;
}

/** Estimated value of one item, or null if unknown */
function getItemBaseCost(itemName) {
    return _cauldronCostCache.has(itemName) ? _cauldronCostCache.get(itemName) : null;
}

// inputs: string[], e.g. the r.inputs array of a cauldron result
function getRecipeEstCost(inputs) {
    let totalCost = 0;
    let string = "";
    for (const name of inputs) {
        const cost = getItemBaseCost(name);
        if (cost === null) { totalCost = null; string = null; break; }; // Any unknown -> the whole total is unknown
        totalCost += cost;
        string += `${name}(${Number(cost.toFixed(2))}) `;
    }
    return { totalCost, string };
}

function onToggleCauldronCostDisplay() {
    cauldronState.showEstCost = document.getElementById('cauldron-show-est-cost').checked;
    // Re-render the currently expanded recipe lists (if any)
    document.querySelectorAll('.cauldron-card:not(.collapsed) .node-content[data-out]').forEach(el => {
        const childrenContainer = el.parentElement.querySelector('.node-children');
        renderRecipeRows(el.dataset.out, childrenContainer);
    });
    renderCauldronResults(lastCauldronResults);
    saveCauldronSettings();
}

function onToggleOrderByEstCost() {
    cauldronState.orderByEstCost = document.getElementById('cauldron-order-by-est-cost').checked;
    
    saveCauldronSettings();


    // Remember which cards are expanded (they collapse when re-rendered)
    const expandedCardIds = [];
    document.querySelectorAll('.cauldron-card:not(.collapsed)').forEach(card => {
        if (card.id) expandedCardIds.push(card.id);
    });

    // Re-render the whole result area (from the existing lastCauldronResults)
    renderCauldronResults(lastCauldronResults);

    // Restore the expanded state: find each card, remove the collapsed class and fill its children
    expandedCardIds.forEach(id => {
        const card = document.getElementById(id);
        if (!card) return;

        // Expand the card (remove the collapsed class)
        card.classList.remove('collapsed');

        // Fill the child content (if not filled yet)
        const content = card.querySelector('.node-content');
        const childrenContainer = card.querySelector('.node-children');
        if (content && childrenContainer) {
            const outName = content.dataset.out;
            if (outName && lastCauldronResults[outName]) {
                // Call the render function directly, same as inside toggleCauldronCard
                renderRecipeRows(outName, childrenContainer);
            }
        }
    });
}

/**
 * Refresh the recipe lists in all expanded cards (re-sort and re-render)
 */
function refreshExpandedCauldronCards() {
    document.querySelectorAll('.cauldron-card:not(.collapsed) .node-content[data-out]').forEach(el => {
        const childrenContainer = el.parentElement.querySelector('.node-children');
        const outName = el.dataset.out;
        if (childrenContainer && outName) {
            renderRecipeRows(outName, childrenContainer);
        }
    });
}

/* ==========================================================================
   SECTION: ITEM BASE COST MODAL
   ========================================================================== */

function openItemBaseCostModal() {
    document.getElementById('item-base-cost-modal-title').innerText = t('Base Item Cost List', 'ui');
    document.getElementById('base-cost-heat-label').innerText = t('Heat', 'ui') + ' ' + t('Cost', 'ui');
    document.getElementById('base-cost-fert-label').innerText = t('Nutr', 'ui') + ' ' + t('Cost', 'ui');
    //document.getElementById('custom-cost-btn-label-2').innerText = t('Manage Custom Costs', 'ui');
    _renderItemBaseCostRates();
    _populateItemBaseCostCategories();
    _renderItemBaseCostList();
    document.getElementById('item-base-cost-modal').style.display = 'flex';
}

function _renderItemBaseCostRates() {
    document.getElementById('base-cost-heat-per-copper').value = Number(cauldronState.heatPerCopper.toFixed(4));
    document.getElementById('base-cost-copper-per-heat').value = Number((1 / cauldronState.heatPerCopper).toFixed(6));
    document.getElementById('base-cost-fert-per-copper').value = Number(cauldronState.nutrPerCopper.toFixed(4));
    document.getElementById('base-cost-copper-per-fert').value = Number((1 / cauldronState.nutrPerCopper).toFixed(6));
}

/**
 * Handle a change in any of the four heat/nutrient conversion inputs.
 * which: 'heatPerCopper' | 'copperPerHeat' | 'nutrPerCopper' | 'copperPerFert'
 */
function onBaseCostRateChange(which, value) {
    const val = parseFloat(value);
    if (!(val > 0)) return; // Ignore invalid values or 0 to avoid dividing by 0

    switch (which) {
        case 'heatPerCopper': cauldronState.heatPerCopper = val; break;
        case 'copperPerHeat': cauldronState.heatPerCopper = 1 / val; break;
        case 'nutrPerCopper': cauldronState.nutrPerCopper = val; break;
        case 'copperPerNutr': cauldronState.nutrPerCopper = 1 / val; break;
    }

    saveCauldronSettings();
    _renderItemBaseCostRates();
    buildItemBaseCost();
    _renderItemBaseCostList();

    // Refresh the cost shown in the currently expanded recipes
    document.querySelectorAll('.cauldron-card:not(.collapsed) .node-content[data-out]').forEach(el => {
        const childrenContainer = el.parentElement.querySelector('.node-children');
        renderRecipeRows(el.dataset.out, childrenContainer);
    });
    if (cauldronState.stepMode === 1) runCauldronSimulation();
}

let _baseCostCatFilter = "[All]";

function _populateItemBaseCostCategories() {
    const sel = document.getElementById('base-cost-cat-select');
    const prevVal = _baseCostCatFilter;
    sel.innerHTML = '';

    // Count the items in each category
    const catCounts = new Map();
    let totalCount = 0;
    _cauldronCostCache.forEach((cost, name) => {
        const cat = DB.items[name]?.category;
        if (cat) {
            catCounts.set(cat, (catCounts.get(cat) || 0) + 1);
            totalCount++;
        }
    });

    // All categories except [All], sorted by count descending (ties by name ascending)
    const cats = Array.from(catCounts.keys());
    cats.sort((a, b) => {
        const countA = catCounts.get(a) || 0;
        const countB = catCounts.get(b) || 0;
        if (countA !== countB) return countB - countA; // Larger count first
        return a.localeCompare(b);                     // Same count: alphabetical
    });
    const sortedCats = ["[All]"].concat(cats);

    sortedCats.forEach(cat => {
        const baseLabel = t(cat, 'categories');
        const count = cat === "[All]" ? totalCount : (catCounts.get(cat) || 0);
        const label = `${baseLabel} (${count})`;
        sel.appendChild(new Option(label, cat));
    });

    sel.value = sortedCats.includes(prevVal) ? prevVal : "[All]";
    _baseCostCatFilter = sel.value;
}

function _renderItemBaseCostList() {
    _baseCostCatFilter = document.getElementById('base-cost-cat-select')?.value || "[All]";
    const container = document.getElementById('item-base-cost-list');

    let entries = [..._cauldronCostCache.entries()];
    if (_baseCostCatFilter !== "[All]") {
        entries = entries.filter(([name]) => DB.items[name]?.category === _baseCostCatFilter);
    }
    entries.sort((a, b) => a[1] - b[1]); // By estimated value, low to high

    if (entries.length === 0) {
        container.innerHTML = `<div style="color:#666; padding:10px; font-size:0.85em; text-align:center;">${t('No items found.', 'ui')}</div>`;
        return;
    }

    container.innerHTML = entries.map(([name, cost]) => {
        const itemDef = DB.items[name] || {};
        if (!itemDef) return ``;
        const stackTag = itemDef.maxStack < 0 ? '*' : '';
        return `
        <div class="multi-target-row">
            <img src="img/item${itemDef.id ?? 0}.png" width="20" height="20">
            <span class="item-name-label" style="flex:1;" title="${t('Cauldron Cost')}: ${Number(itemDef.cauldronCost)}">${name}${stackTag}</span>
            <span class="details" style="text-align:right; min-width:90px;">${formatCoinIcons(cost)}</span>
        </div>`;
    }).join('');
}

/* ==========================================================================
   SECTION: UI
   ========================================================================== */

function populateCauldronCategories() {
    const sel = document.getElementById('cauldron-cat-select');
    sel.innerHTML = '';
    
    const cats = ["[All]", "[Include]", "[Exclude]", "[Product]"];
    const itemCats = new Set();
    Object.values(DB.items).forEach(i => { if(i.category) itemCats.add(i.category); });
    const sortedCats = cats.concat(Array.from(itemCats));

    sortedCats.forEach(cat => {
        if (cat === "Liquid") return;
        let count = 0;
        let total = 0;

        Object.keys(DB.items).forEach(name => {
            const item = DB.items[name];
            if (!isVaildCandidate(name)) return;
            
            const isMatch = (cat === "[All]") || 
                            (cat === "[Include]" && cauldronCandidates.has(name)) ||
                            (cat === "[Exclude]" && !cauldronCandidates.has(name)) ||
                            (cat === "[Product]" && item.cauldronTarget) ||
                            (item.category === cat);
            
            if (isMatch) total++;
            if (isMatch && cauldronCandidates.has(name)) count++;
        });

        const option = new Option(`${t(cat, 'categories')} (${count}/${total})`, cat);
        sel.appendChild(option);
    });
}

/** Reads a "max" number field; empty / invalid -> null (no limit). */
function _readCandidateMax(id) {
    const raw = (document.getElementById(id)?.value || '').trim();
    if (raw === '') return null;
    const v = Number(raw);
    return Number.isFinite(v) ? v : null;
}

/**
 * Whether an item passes the candidate pool's current view filters:
 * category, search text, max point value (cauldronCost) and max coin value (estimated base cost).
 * Items whose coin value can't be estimated are hidden while a coin limit is set.
 * Select All / Deselect All / Only These act on exactly this set.
 */
function candidateMatchesView(name) {
    const item = DB.items[name];
    if (!item || !isVaildCandidate(name)) return false;

    const catOk = (cauldronCatFilter === "[All]") ||
                  (cauldronCatFilter === "[Include]" && cauldronCandidates.has(name)) ||
                  (cauldronCatFilter === "[Exclude]" && !cauldronCandidates.has(name)) ||
                  (cauldronCatFilter === "[Product]" && item.cauldronTarget) ||
                  (item.category === cauldronCatFilter);
    if (!catOk) return false;

    const searchText = (document.getElementById('cauldron-cand-search')?.value || '').trim().toLowerCase();
    if (searchText) {
        const altName = (typeof queryDualItemName === 'function' ? queryDualItemName(name) : '') || '';
        if (!name.toLowerCase().includes(searchText) && !altName.toLowerCase().includes(searchText)) return false;
    }

    const maxPoints = _readCandidateMax('cauldron-cand-max-points');
    if (maxPoints !== null && (item.cauldronCost || 0) > maxPoints) return false;

    const maxCoins = _readCandidateMax('cauldron-cand-max-coins');
    if (maxCoins !== null) {
        const coins = getItemBaseCost(name);
        if (coins === null || coins > maxCoins) return false;
    }
    return true;
}

function renderCandidatePool() {
    cauldronCatFilter = document.getElementById('cauldron-cat-select').value;
    const sortFlag = document.getElementById('cauldron-sort-by-cost').checked;
    const cauldronSortDescending = document.getElementById('cauldron-sort-order-btn').innerText === '▼';
    const container = document.getElementById('candidate-pool');
    container.innerHTML = '';

    let array = [];
    Object.keys(DB.items).forEach(name => {
        if (!candidateMatchesView(name)) return;
        const item = DB.items[name];
        array.push({name: name, cost:item.cauldronCost||0, target:item.cauldronTarget||0, id:item.id||0, coins:getItemBaseCost(name)});
    });

    if (sortFlag) array.sort((a, b) => (cauldronSortDescending ? (b.cost - a.cost) : (a.cost - b.cost)));

    array.forEach((item) => {
        const div = document.createElement('div');
        div.className = 'candidate-item';
        div.title = item.coins !== null ? `${t('Coin value')}: ≈${formatVal(item.coins)}` : '';
        const isChecked = cauldronCandidates.has(item.name) ? 'checked' : '';
        div.innerHTML = `
            <input type="checkbox" ${isChecked} onchange="toggleCandidate('${item.name}')">
            <img src="img/item${item.id ?? 0}.png" style="margin-left: 4px;" width="18" height="18" loading="lazy">
            <span class="cand-name" ${item.target > 0 ? 'style="color:#66ddff"' : ''}>${item.name}</span>
            <span class="cand-cost" title="${t('Cauldron Cost')}">${item.cost.toFixed(2)}</span>
        `;
        container.appendChild(div);
    });
}

// switchCauldronType: toggles the related UI and clears slot 3 when switching to Type 1
function switchCauldronType(index, triggerCalc = true) {
    cauldronState.activeType = index;
    for (let i = 0; i < 2; i++) {
        document.getElementById(`cauldron-type-${i}`).classList.toggle('active', i === index);
    }

    const isAdvancedCauldron = index === 1;
    document.getElementById('slot3-wrapper').style.display = isAdvancedCauldron ? 'none' : '';
    document.getElementById('filter-2-diff').parentElement.style.display = isAdvancedCauldron ? '' : 'none';
    document.getElementById('filter-2-same').parentElement.style.display = isAdvancedCauldron ? '' : '';
    document.getElementById('filter-3-diff').parentElement.style.display = isAdvancedCauldron ? 'none' : '';
    document.getElementById('filter-3-same').parentElement.style.display = isAdvancedCauldron ? 'none' : '';    

    if(triggerCalc) {
        saveCauldronSettings();
        runCauldronSimulation();
    }
}

function switchCauldronProfile(index, triggerCalc = true) {    
    cauldronState.activeProfile = index;
    syncCandidatesFromProfile();
    for (let i = 0; i < 3; i++) {
        document.getElementById(`cauldron-tab-${i}`).classList.toggle('active', i === index);
    }
    populateCauldronCategories();
    renderCandidatePool();
    if(triggerCalc) {
        saveCauldronSettings();
        runCauldronSimulation();
    }
}

function switchCauldronStepMode(mode, triggerCalc = true) {
    cauldronState.stepMode = mode;
    document.getElementById('cauldron-step-mode-0').classList.toggle('active', mode === 0);
    document.getElementById('cauldron-step-mode-1').classList.toggle('active', mode === 1);
    document.getElementById('cauldron-single-step-panel').style.display = mode === 0 ? '' : 'none';
    document.getElementById('cauldron-multistep-panel').style.display = mode === 1 ? '' : 'none';    

    if(triggerCalc) {
        saveCauldronSettings();
        if (mode === 1 && multiStepState.dirty) {
                runMultiStepCauldronSimulation();
        }
    }            
}

/**
 * Reset the current profile's candidate list to a preset (e.g. herbs/plants)
 */
function applyPreset(poolType) {
    const candidates = getPresetCandidates(poolType);
    cauldronCandidates = new Set(candidates);
    populateCauldronCategories();
    document.getElementById('cauldron-cat-select').value = cauldronCatFilter;
    renderCandidatePool();
    saveCauldronSettings();
    runCauldronSimulation();
}

function toggleCauldronSortOrder() {
    document.getElementById('cauldron-sort-order-btn').innerText = document.getElementById('cauldron-sort-order-btn').innerText === '▼' ? '▲' : '▼';
    renderCandidatePool();
}

function toggleCandidate(name) {
    if (cauldronCandidates.has(name)) cauldronCandidates.delete(name);
    else cauldronCandidates.add(name);
    populateCauldronCategories();
    document.getElementById('cauldron-cat-select').value = cauldronCatFilter;
    saveCauldronSettings();
    runCauldronSimulation();
}

/** check: true = select all visible, false = deselect all visible, 'only' = select exactly the visible ones. */
function bulkToggleCandidates(check) {
    const matches = Object.keys(DB.items).filter(candidateMatchesView);
    if (check === 'only') {
        cauldronCandidates = new Set(matches);
    } else {
        matches.forEach(name => {
            if (check) cauldronCandidates.add(name);
            else cauldronCandidates.delete(name);
        });
    }
    renderCandidatePool();
    populateCauldronCategories();
    document.getElementById('cauldron-cat-select').value = cauldronCatFilter;
    saveCauldronSettings();
    runCauldronSimulation();
}

/**
 * Handle item selection, reusing the existing Item Picker
 */
function pickFilterItem(slotIdx, clear = false) {
    if (clear) {
        cauldronFilterItems[slotIdx - 1] = null;
        updateFilterUI();
        return;
    }
    
    // Temporarily override selectItem
    const originalSelectItem = window.selectItem;
    window.selectItem = (name) => {
        cauldronFilterItems[slotIdx - 1] = name;
        updateFilterUI();
        window.selectItem = originalSelectItem; // Restore
        runCauldronSimulation();
    };
    
    openItemPicker();
}

function updateFilterUI() {
    for (let i = 1; i <= 3; i++) {
        const slotEl = document.getElementById(`slot${i}`);
        const ctrlEl = document.getElementById(`slot-ctrl-${i}`);
        const val = cauldronFilterItems[i - 1];
        
        // Update the picker text above
        slotEl.innerText = val ? val : t('Set Input') + ` ${i}`;
        slotEl.classList.toggle('active', !!val);

        // Update the control row HTML below
        if (val) {
            const item = DB.items[val];
            ctrlEl.innerHTML = `
                <button class="swap-btn" onclick="shiftFilterItem(${i}, -1, event)" title="${t('Click: cycle all items\nCtrl+Click: cycle within checked candidates only', 'ui')}">-</button>
                <img src="img/item${item.id ?? 0}.png" width="18" height="18" title="${val}">
                <span class="cand-cost">${Number(item.cauldronCost.toFixed(2))}</span>
                <button class="swap-btn" onclick="shiftFilterItem(${i}, 1, event)" title="${t('Click: cycle all items\nCtrl+Click: cycle within checked candidates only', 'ui')}">+</button>
            `;
            ctrlEl.style.visibility = 'visible';
        } else {
            // With no item selected, either hide it or show an empty hint
            ctrlEl.innerHTML = `<button class="swap-btn" style="opacity:0.3" onclick="shiftFilterItem(${i}, 1)">+</button>`;
            // or simply ctrlEl.style.visibility = 'hidden';
        }
    }
}

/**
 * Switch the selected item to the previous or next one
 * @param {number} slotIdx 1, 2, 3
 * @param {number} delta -1 or 1
 */
function shiftFilterItem(slotIdx, delta, event) {
    const useCandidatesOnly = !!(event && (event.ctrlKey || event.metaKey));
    const baseList = useCandidatesOnly ? [...cauldronCandidates] : Object.keys(DB.items);
    const list = baseList
        .filter(isVaildCandidate)
        .sort((a, b) => DB.items[a].cauldronCost - DB.items[b].cauldronCost);

    if (list.length === 0) return;

    const currentItem = cauldronFilterItems[slotIdx - 1];
    let nextIdx = 0;

    if (currentItem) {
        const currentIdx = list.indexOf(currentItem);
        // Wrap the index around
        nextIdx = (currentIdx + delta + list.length) % list.length;
    } else {
        // If empty, + starts from the first item and - from the last
        nextIdx = delta > 0 ? 0 : list.length - 1;
    }

    cauldronFilterItems[slotIdx - 1] = list[nextIdx];
    updateFilterUI();
    runCauldronSimulation();
}

function pickCauldronTargetOutput(clear = false) {
    if (clear) {
        cauldronTargetOutput = null;
        updateCauldronTargetOutputUI();
        runCauldronSimulation();
        return;
    }
    const hadProp = currentPickerProps.has('cauldronTarget');   // Remember the original state
    window.selectItem = (name) => {
        if (DB.items[name]?.cauldronTarget === undefined) {
            alert(t('Selected item is not a valid cauldron target.', 'ui'));
            return;   // No need to restore selectItem by hand; closeModal handles it
        }
        cauldronTargetOutput = name;
        closeModal('picker-modal');   // Triggers _runPickerCleanup
        updateCauldronTargetOutputUI();
        runCauldronSimulation();
    };
    currentPickerProps.add('cauldronTarget');
    _pickerOnClose = () => { if (!hadProp) currentPickerProps.delete('cauldronTarget'); };
    openItemPicker();
}

function updateCauldronTargetOutputUI() {
    const btn = document.getElementById('cauldron-target-output-btn');
    const clearBtn = document.getElementById('cauldron-target-output-clear');
    if (!btn) return;
    btn.innerText = cauldronTargetOutput ? cauldronTargetOutput : t('Set Target Output', 'ui');
    btn.classList.toggle('active', !!cauldronTargetOutput);
    if (clearBtn) clearBtn.style.display = cauldronTargetOutput ? '' : 'none';
}

function onMultiStepIntermediateLimitChange(value) {
    // Force an integer from 1 to 3
    let limit = parseInt(value, 10);
    if (!Number.isFinite(limit)) limit = 3;
    limit = Math.max(1, Math.min(3, limit));

    const input = document.getElementById('cauldron-intermediate-limit');
    if(input) input.value = limit;
    cauldronState.intermediateLimit = limit;
    saveCauldronSettings();
    runCauldronSimulation();
}

/* ==========================================================================
   SECTION: ASYNC CAULDRON CALCULATION
   ========================================================================== */

let lastCauldronResults = {}; // Global store of the computed results

async function runCauldronSimulation() {
    if (cauldronState.activeType === 1) {
        await runCauldronSimulationType1();
    } else {
        await runCauldronSimulationType0();
    }

    multiStepState.dirty = true;
    if (cauldronState.stepMode === 1) {
        await runMultiStepCauldronSimulation();
    }
}

/**
 * Linear interpolation: time and heat from cauldronTarget
 */
function getCauldronStats(target) {
    const t = [1, 100, 1000, 10000, 1000000];
    const times = [3, 6, 12, 24, 60];
    const heats = [1, 20, 200, 1500, 10000];

    // Boundaries
    if (target <= t[0]) return { time: times[0], heat: heats[0] };
    if (target >= t[t.length - 1]) return { time: times[times.length - 1], heat: heats[heats.length - 1] };

    // Find the interval
    for (let i = 0; i < t.length - 1; i++) {
        if (target >= t[i] && target <= t[i+1]) {
            const p = (target - t[i]) / (t[i+1] - t[i]); // Fraction
            return {
                time: Math.round((times[i] + p * (times[i+1] - times[i]))*10)/10,
                heat: Math.round((heats[i] + p * (heats[i+1] - heats[i]))*10)/10
            };
        }
    }
}

function _getCauldronValidTargets() {
    return Object.keys(DB.items)
        .filter(name => DB.items[name].cauldronTarget !== undefined)
        .map(name => ({
            name: name,
            id: DB.items[name].id || 3000,
            target: DB.items[name].cauldronTarget,
            mult: DB.items[name].cauldronMulti || 1,
        }));
}

/** Cauldron (3 slots), pure function: resolves only the output item, no UI/filtering */
function resolveCauldronOutput3(n0, n1, n2, validTargets) {
    const c0 = DB.items[n0].cauldronCost, c1 = DB.items[n1].cauldronCost, c2 = DB.items[n2].cauldronCost;

    let ratio = 1.0;
    if (n0 === n1 && n1 === n2) ratio = 0.5;
    else if (n0 === n1 || n1 === n2 || n0 === n2) ratio = 0.65;

    const T = (c0 + c1 + c2) * ratio;

    // Tie-breaker short-cut patch
    if (T === 556) return { output: getCurrentItemName('Crude Shard'), ratio, T };

    let bestItem = null;
    let bestValue = 0;
    let minDistance = Infinity;
    for (const target of validTargets) {
        const dist = Math.abs((T - target.target) * target.mult);
        if (dist < minDistance) {
            minDistance = dist;
            bestItem = target.name;
            bestValue = target.id;
        } else if (Math.abs(dist - minDistance) < 1e-7) {
            if (target.id < bestValue) {
                bestItem = target.name;
                bestValue = target.id;
            }
        }
    }
    return { output: bestItem, ratio, T };
}

/** Advanced Cauldron (2 slots), pure function: resolves only the output item, no UI/filtering */
function resolveCauldronOutput2(nA, nB, validTargets, maxTargetItem, minTargetItem) {
    const cA = DB.items[nA].cauldronCost;
    const cB = DB.items[nB].cauldronCost;
    const T = (nA === nB) ? cA : Math.abs(cA - cB);

    let bestItem = null;
    let minDistance = Infinity;

    if (nA === nB) {
        bestItem = maxTargetItem ? maxTargetItem.name : null;
        for (const target of validTargets) {
            const dist = target.target - T;
            if (1e-7 < dist && dist < minDistance && target.name !== nA) {
                minDistance = dist;
                bestItem = target.name;
            }
        }
    } else {
        const higherName = cA > cB ? nA : nB;
        const higherCost = cA > cB ? cA : cB;
        bestItem = minTargetItem ? minTargetItem.name : null;
        for (const target of validTargets) {
            const dist = Math.abs(T - target.target);
            if (dist < minDistance && target.target < higherCost && target.name !== higherName) {
                minDistance = dist;
                bestItem = target.name;
            }
        }
    }
    return { output: bestItem, T };
}

async function runCauldronSimulationType0() {
    const f100 = document.getElementById('filter-3-diff').checked;
    const f065 = document.getElementById('filter-2-same').checked;
    const f050 = document.getElementById('filter-3-same').checked;
    function isRecipeMatch(inputs, ratio) {
        if (ratio === 1.0 && !f100) return false;
        if (ratio === 0.65 && !f065) return false;
        if (ratio === 0.5 && !f050) return false;
        return true;
    }

    const validTargets = _getCauldronValidTargets();

    const list = [...cauldronCandidates].filter(isVaildCandidate);
    list.sort((a, b) => (DB.items[b].cauldronCost - DB.items[a].cauldronCost)); // Largest first

    const progText = document.getElementById('cauldron-progress');

    const resultsByOutput = {};
    const totalCombos = (list.length * (list.length + 1) * (list.length + 2)) / 6;
    let comboCount = 0; let recipeCount = 0;
    let lastUpdate = Date.now();
    let n0, n1, n2;

    if (list.length === 0) {
        for (let i = 0; i < 3; i++) {
            if (cauldronFilterItems[i]) {
                list.push(cauldronFilterItems[i]);
            }
        }
    }

    for (let i = 0; i < list.length; i++) {
        n0 = cauldronFilterItems[0] ?? list[i];
        for (let j = i; j < list.length; j++) {
            n1 = cauldronFilterItems[1] ?? list[j];
            for (let k = j; k < list.length; k++) {
                n2 = cauldronFilterItems[2] ?? list[k];

                let ratio = 1.0;
                if (n0 === n1 && n1 === n2) ratio = 0.5;
                else if (n0 === n1 || n1 === n2 || n0 === n2) ratio = 0.65;

                if (isRecipeMatch([n0, n1, n2], ratio)) {
                    const res = resolveCauldronOutput3(n0, n1, n2, validTargets);
                    const c0 = DB.items[n0].cauldronCost, c1 = DB.items[n1].cauldronCost, c2 = DB.items[n2].cauldronCost;
                    if (!([n0, n1, n2].includes(res.output) && !cauldronFilterItems.includes(res.output))) {
                        if (!resultsByOutput[res.output]) resultsByOutput[res.output] = [];
                        resultsByOutput[res.output].push({
                            inputs: [n0, n1, n2],
                            totalValue: (c0 + c1 + c2)
                        });
                        recipeCount++;
                    }
                }
                comboCount++;
                if (cauldronFilterItems[2] != null) break;
            }

            /*
            if (Date.now() - lastUpdate > 150) {
                progText.innerText = `${Math.round((comboCount / totalCombos) * 100)}%`;
                await new Promise(r => setTimeout(r, 0));
                lastUpdate = Date.now();
            }
            */
            if (cauldronFilterItems[1] != null) break;
        }
        if (cauldronFilterItems[0] != null) break;
    }

    lastCauldronResults = resultsByOutput;

    renderCauldronResults(resultsByOutput);
    checkUnattainableItems(new Set(Object.keys(resultsByOutput)));
    progText.innerText = `${t('Total count of recipes')}: (${recipeCount}) `;
}

async function runCauldronSimulationType1() {

    const include2diff = document.getElementById('filter-2-diff').checked;
    const include2same = document.getElementById('filter-2-same').checked;

    function isRecipeMatch(nA, nB) {
        if (nA === nB) return include2same;
        else return include2diff;
    }

    const validTargets = _getCauldronValidTargets();
    const maxTargetItem = validTargets.reduce((prev, current) => (prev.target > current.target) ? prev : current);
    const minTargetItem = validTargets.reduce((prev, current) => (prev.target < current.target) ? prev : current);

    const list = [...cauldronCandidates].filter(isVaildCandidate);
    list.sort((a, b) => (DB.items[b].cauldronCost - DB.items[a].cauldronCost));

    const progText = document.getElementById('cauldron-progress');

    const resultsByOutput = {};
    const totalCombos = (list.length * (list.length + 1)) / 2;
    let comboCount = 0; let recipeCount = 0;
    let lastUpdate = Date.now();

    if (list.length === 0) {
        for (let i = 0; i < 2; i++) {
            if (cauldronFilterItems[i]) {
                list.push(cauldronFilterItems[i]);
            }
        }
    }

    for (let i = 0; i < list.length; i++) {
        const nA = cauldronFilterItems[0] ?? list[i];
        for (let j = i; j < list.length; j++) {
            const nB = cauldronFilterItems[1] ?? list[j];

            const res = resolveCauldronOutput2(nA, nB, validTargets, maxTargetItem, minTargetItem);
            if (isRecipeMatch(nA, nB)) {
                const cA = DB.items[nA].cauldronCost, cB = DB.items[nB].cauldronCost;
                if (!resultsByOutput[res.output]) resultsByOutput[res.output] = [];
                resultsByOutput[res.output].push({
                    inputs: [nA, nB],
                    totalValue: cA + cB,
                    displayValue: res.T
                });
                recipeCount++;
            }

            comboCount++;
            if (cauldronFilterItems[1] != null) break;
        }

        /*
        if (Date.now() - lastUpdate > 150) {
            progText.innerText = `${Math.round((comboCount / totalCombos) * 100)}%`;
            await new Promise(r => setTimeout(r, 0));
            lastUpdate = Date.now();
        }
        */
        if (cauldronFilterItems[0] != null) break;
    }

    lastCauldronResults = resultsByOutput;

    renderCauldronResults(resultsByOutput);
    checkUnattainableItems(new Set(Object.keys(resultsByOutput)));
    progText.innerText = `${t('Number of matching recipes')}: (${recipeCount}) `;
}

/**
 * Multi-step calculation: starting from the candidate pool (Step 0), each round uses cauldron combinations to find cheaper products,
 * for at most 4 rounds (Step 0-3). Each round only overwrites when the new cost is lower;
 * on equal cost, the smaller total real cauldronCost wins.
 */
async function runMultiStepCauldronSimulation() {
    console.time('runMultiStepCauldronSimulation');
    const progText = document.getElementById('cauldron-multistep-progress');
    if (progText) progText.innerText = '';

    const validTargets = _getCauldronValidTargets();
    const maxTargetItem = validTargets.length ? validTargets.reduce((p, c) => (p.target > c.target ? p : c)) : null;
    const minTargetItem = validTargets.length ? validTargets.reduce((p, c) => (p.target < c.target ? p : c)) : null;

    const heatPerCopper = cauldronState.heatPerCopper || 20;
    const isType1 = cauldronState.activeType === 1;

    // ---- Step 0: base costs from the candidate pool ----
    const step0 = new Map();
    cauldronCandidates.forEach(item => {
        if (!isVaildCandidate(item)) return;
        const cost = getItemBaseCost(item);
        if (cost === null) return;
        step0.set(item, { cost, cauldronCostSum: DB.items[item].cauldronCost, recipeInputs: null });
    });

    const steps = [step0];

    function isBetter(cand, existing) {
        if (!existing) return true;
        if (cand.cost < existing.cost - 1e-9) return true;
        if (Math.abs(cand.cost - existing.cost) < 1e-9 && cand.cauldronCostSum < existing.cauldronCostSum) return true;
        return false;
    }

    for (let stepIdx = 1; stepIdx <= 4; stepIdx++) {
        const prev = steps[stepIdx - 1];
        const next = new Map(prev); // Inherit every item from the previous round
        const pool = [...prev.keys()];
        const bestThisRound = new Map(); // output -> {cost, cauldronCostSum, recipeInputs}

        function considerCombo(inputs, output) {
            if (!output || inputs.includes(output)) return;

            let cost = 0, cauldronCostSum = 0;
            let intermediateCount = 0;
            for (const inp of inputs) {
                const rec = prev.get(inp);
                cost += rec.cost;
                cauldronCostSum += DB.items[inp].cauldronCost;
                if (rec.cost != getItemBaseCost(inp)) intermediateCount++;
            }
            if (intermediateCount > cauldronState.intermediateLimit) return; // Too many intermediate products

            const ingredientsCost = cost;
            const stats = getCauldronStats(DB.items[output].cauldronTarget);
            const heatCost = (stats.heat * stats.time) / heatPerCopper;
            cost += heatCost;

            const cand = { cost, cauldronCostSum, recipeInputs: inputs.slice(), ingredientsCost, heatCost };
            if (isBetter(cand, bestThisRound.get(output))) {
                bestThisRound.set(output, cand);
            }
        }

        let comboCount = 0;
        let lastUpdate = Date.now();

        if (isType1) {
            const totalCombos = (pool.length * (pool.length + 1)) / 2;
            for (let i = 0; i < pool.length; i++) {
                for (let j = i; j < pool.length; j++) {
                    const nA = pool[i], nB = pool[j];
                    const res = resolveCauldronOutput2(nA, nB, validTargets, maxTargetItem, minTargetItem);
                    considerCombo([nA, nB], res.output);
                    comboCount++;
                    if (Date.now() - lastUpdate > 150) {
                        if (progText) progText.innerText = `Step ${stepIdx}: ${Math.round((comboCount / totalCombos) * 100)}%`;
                        await new Promise(r => setTimeout(r, 0));
                        lastUpdate = Date.now();
                    }
                }
            }
        } else {
            const totalCombos = (pool.length * (pool.length + 1) * (pool.length + 2)) / 6;
            for (let i = 0; i < pool.length; i++) {
                for (let j = i; j < pool.length; j++) {
                    for (let k = j; k < pool.length; k++) {
                        const n0 = pool[i], n1 = pool[j], n2 = pool[k];
                        const res = resolveCauldronOutput3(n0, n1, n2, validTargets);
                        considerCombo([n0, n1, n2], res.output);
                        comboCount++;
                        
                        /*
                        if (Date.now() - lastUpdate > 150) {
                            if (progText) progText.innerText = `Step ${stepIdx}: ${Math.round((comboCount / totalCombos) * 100)}%`;
                            await new Promise(r => setTimeout(r, 0));
                            lastUpdate = Date.now();
                        }
                        */
                    }
                }
            }
        }

        bestThisRound.forEach((cand, output) => {
            if (isBetter(cand, next.get(output))) next.set(output, cand);
        });

        steps.push(next);
    }

    multiStepState.steps = steps;
    multiStepState.dirty = false;
    if (progText) progText.innerText = '';

    const _msScrollEl = document.querySelector('.cauldron-multistep-scroll');
    const _msSavedScrollTop = _msScrollEl ? _msScrollEl.scrollTop : 0;
    renderMultiStepTable();
    if (_msScrollEl) _msScrollEl.scrollTop = _msSavedScrollTop;

    const finalStep = multiStepState.steps[multiStepState.steps.length - 1];
    const producedSet = finalStep ? new Set(finalStep.keys()) : new Set();
    checkUnattainableItems(producedSet);

    console.timeEnd('runMultiStepCauldronSimulation');
}

/* ==========================================================================
   SECTION: RESULT RENDERING
   ========================================================================== */

/**
 * Trace back along recipeInputs from item (its result in round stepIdx).
 * Returns:
 *   rowItems: names of all upstream ancestors (used to filter table rows, excluding the item itself)
 *   cellKeys: set of "item::stepIdx" keys for every cell the trace passes through
 *             (including the item's own cell at stepIdx), used to mark the active up-arrow buttons
 */
function _computeMultiStepUpstreamAncestors(item, stepIdx) {
    const rowItems = new Set();
    const cellKeys = new Set([`${item}::${stepIdx}`]);
    function walk(curItem, curStepIdx) {
        if (curStepIdx < 0) return;
        const stepMap = multiStepState.steps[curStepIdx];
        const rec = stepMap ? stepMap.get(curItem) : null;
        if (!rec || !rec.recipeInputs) return;
        rec.recipeInputs.forEach(inputName => {
            rowItems.add(inputName);
            cellKeys.add(`${inputName}::${curStepIdx - 1}`);
            walk(inputName, curStepIdx - 1);
        });
    }
    walk(item, stepIdx);
    return { rowItems, cellKeys };
}

/** Toggle the upstream filter for a cell (item @ stepIdx); pressing the same cell again clears it */
function toggleMultiStepUpstreamFilter(item, stepIdx) {
    if (_multiStepUpstreamFilter && _multiStepUpstreamFilter.item === item && _multiStepUpstreamFilter.stepIdx === stepIdx) {
        _multiStepUpstreamFilter = null;
    } else {
        _multiStepUpstreamFilter = { item, stepIdx };
    }
    renderMultiStepTable();
}

/** Whether this output + inputs combination is already a favorite */
function _isMultiStepFavRecipe(output, inputs) {
    if (!inputs) return false;
    const key = [...inputs].sort().join(',');
    return cauldronState.favorites.some(f => f.output === output && [...f.inputs].sort().join(',') === key);
}

/** fav-btn click: toggle the favorite and redraw the table (keeping the current filter) */
function toggleMultiStepFav(item, inputsJson) {
    const inputs = JSON.parse(inputsJson);
    toggleFavorite(...inputs, item);
    renderMultiStepTable();
}

function renderMultiStepTable() {
    const thead = document.getElementById('cauldron-multistep-thead');
    const tbody = document.getElementById('cauldron-multistep-tbody');
    if (!thead || !tbody) return;

    thead.innerHTML = `<th>${t('Item')}</th>` +
        multiStepState.steps.map((_, idx) => `<th>${t('Step')} ${idx}</th>`).join('');

    const itemSet = new Set();
    multiStepState.steps.forEach(stepMap => {
        if (stepMap) stepMap.forEach((_, item) => itemSet.add(item));
    });

    let rows = [...itemSet].sort((a, b) => {
        const ta = DB.items[a]?.cauldronCost ?? Infinity;
        const tb = DB.items[b]?.cauldronCost ?? Infinity;
        return ta - tb;
    });

    // With an active upstream filter, keep only the target item and all its ancestors
    let _msChainCellKeys = null;
    if (_multiStepUpstreamFilter) {
        const { item: activeItem, stepIdx: activeStepIdx } = _multiStepUpstreamFilter;
        const { rowItems, cellKeys } = _computeMultiStepUpstreamAncestors(activeItem, activeStepIdx);
        _msChainCellKeys = cellKeys;
        if(rowItems.size > 0) rows = rows.filter(r => r === activeItem || rowItems.has(r));
    }

    if (rows.length === 0) {
        tbody.innerHTML = `<tr><td style="color:#666; padding:20px; text-align:center;">${t('No recipes meet the criteria.', 'ui')}</td></tr>`;
        return;
    }

    tbody.innerHTML = rows.map(item => {
        const def = DB.items[item] || {};
        const targetText = def.cauldronTarget !== undefined
            ? `<div class="ms-target">${t('Cauldron Target')}: ${def.cauldronTarget}</div>`
            : '';
        const nameCell = `
            <td>
                <div class="ms-item-name" title="${t('Cauldron Cost')}: ${Number(def.cauldronCost?.toFixed(2) ?? 0)}">
                    <img src="img/item${def.id ?? 0}.png" width="20" height="20" class="item-icon-small">
                    <span>${item}</span>
                </div>
                ${targetText}
            </td>`;

        let prevCost = null;
        const cellsHtml = multiStepState.steps.map((stepMap, idx) => {
            const rec = stepMap ? stepMap.get(item) : null;
            if (!rec) {
                return `<td class="ms-cell ms-empty">—</td>`;
            }

            const cost = Math.ceil(rec.cost);
            const extraStyle = (prevCost == null || cost < prevCost) ? '' : 'style="color: gray; opacity:25%;"';
            let costTitleAttr = '';
            if (rec.recipeInputs) {
                const ingCost = Math.ceil(rec.ingredientsCost ?? 0);
                const heatCostVal = Math.ceil(rec.heatCost ?? 0);
                costTitleAttr = ` title="${t('Ingredients')}${t('Cost')}: ${ingCost.toLocaleString()}\n${t('Heat')}${t('Cost')}: ${heatCostVal.toLocaleString()}"`;
            }
            const costHtml = `<div class="ms-cost-row"${costTitleAttr}>${cost.toLocaleString()}<img src="img/copper.png" class="item-icon-small"></div>`;

            // Update prevCost to the current effective cost
            prevCost = cost;

            let recipeHtml;
            let cellActiveClass = '';
            if (rec.recipeInputs) {
                const cellKey = `${item}::${idx}`;
                const isChainMember = !!(_msChainCellKeys && _msChainCellKeys.has(cellKey));
                const isClickedCell = !!(_multiStepUpstreamFilter && _multiStepUpstreamFilter.item === item && _multiStepUpstreamFilter.stepIdx === idx);
                if (isClickedCell) cellActiveClass = ' ms-cell-active';

                const isFav = _isMultiStepFavRecipe(item, rec.recipeInputs);
                const inputsJson = JSON.stringify(rec.recipeInputs).replace(/"/g, '&quot;');
                const prevStepMap = multiStepState.steps[idx - 1];
                const icons = rec.recipeInputs.map(n => {
                    const d = DB.items[n] || {};
                    const inputRec = prevStepMap ? prevStepMap.get(n) : null;
                    const inputCost = inputRec ? Math.ceil(inputRec.cost) : null;
                    const titleText = inputCost !== null ? `${n} (${inputCost.toLocaleString()})` : n;
                    return `<img src="img/item${d.id ?? 0}.png" width="18" height="18" title="${titleText}">`;
                }).join('');

                recipeHtml = `
                    <div class="ms-recipe-row">
                        <button class="ms-upstream-btn ${isChainMember ? 'active' : ''}"
                            title="${t('Show Upstream Ingredients')}"
                            onclick="toggleMultiStepUpstreamFilter('${item}', ${idx})">▲</button>
                        <span class="ms-recipe-icons">${icons}</span>
                        <button class="btn-fav ms-fav-btn ${isFav ? 'active' : ''}"
                            title="${t('Toggle Favorite')}"
                            onclick="toggleMultiStepFav('${item}', '${inputsJson}')">${isFav ? '★' : '☆'}</button>
                    </div>`;
            } else {
                recipeHtml = `<div class="ms-recipe-row">—</div>`;
            }

            return `<td class="ms-cell${cellActiveClass}" ${extraStyle}>${costHtml}${recipeHtml}</td>`;
        }).join('');

        return `<tr>${nameCell}${cellsHtml}</tr>`;
    }).join('');
}

function renderCauldronResults(data) {
    const container = document.getElementById('cauldron-results');
    container.innerHTML = '';

    const sortedOutputs = cauldronTargetOutput ?
        Object.keys(data).filter(key => key === cauldronTargetOutput) :
        Object.keys(data).sort((a, b) => (DB.items[a].cauldronTarget || 0) - (DB.items[b].cauldronTarget || 0));

    if (sortedOutputs.length === 0) {
        container.innerHTML = `<div style="color:#666; padding:24px; text-align:center; font-style:italic;">${t('No recipes meet the criteria.', 'ui')}</div>`;
        return;
    }

    sortedOutputs.forEach(outName => {
        const outputItem = DB.items[outName];
        const recipes = data[outName];
        const stats = getCauldronStats(outputItem.cauldronTarget);
        const card = document.createElement('div');
        card.className = 'node cauldron-card collapsed';
        card.id = `cauldron-out-${outName.replace(/\s+/g, '-')}`; // For lookup
        
        // Scan all recipes of this product for the lowest estimated cost (O(N), N = its recipe count)
        let minEstCost = null;
        let minEstCostRecipe = null;
        let resultString = ""; 
        if (cauldronState.showEstCost) {
            let minValue = Infinity;
            recipes.forEach(r => {
                const { totalCost, string } = getRecipeEstCost(r.inputs);
                if (totalCost !== null && (minEstCost === null || totalCost < minEstCost || (totalCost == minEstCost && r.totalValue < minValue))) {
                    minEstCost = totalCost;
                    minEstCostRecipe = r.inputs;
                    resultString = string;
                    minValue = r.totalValue;
                }
            });
        }
        // Build minCostTag
        const minCostTag = (minEstCost !== null && minEstCostRecipe)
            ? `<span class="cost-tag help-tag" title="${t('Minimum')+t('Estimated Cost')}: ${resultString}">
                ${Math.ceil(minEstCost).toLocaleString()} 
                <img src="img/copper.png" class="item-icon-small">
               </span>`
            : '';

        card.innerHTML = `
            <div class="node-content compact-card" data-out="${outName}" onclick="toggleCauldronCard(this, this.parentElement)">
                <span class="tree-arrow">▼</span>
                <img src="img/item${outputItem.id ?? 0}.png" class="item-icon" title="${t('Target Item')}">
                <span class="item-link"><strong>${outName}</strong></span>                
                <span class="qty help-tag" style="font-size:0.9em;" title="${t('Number of matching recipes')}">(${recipes.length})</span>
                <span class="info-tag help-tag" title="${t('Base Time')}">${stats.time.toFixed(1)}s</span>
                <span class="heat-tag help-tag" title="${t('Heat Cost')}">${stats.heat.toFixed(1)}P/s</span>
                ${minCostTag}
                <span class="push-right">
                <div class="details help-tag" title="${t('Cauldron Target')}">T: ${outputItem.cauldronTarget}</div>
            </div>
            <div class="node-children">
                <div class="loading-placeholder" style="padding:10px; color:#666; font-size:0.8em;">Loading recipes...</div>
            </div>
        `;
        container.appendChild(card);
    });

    if (sortedOutputs.length === 1) {        
        // With only one product, expand it right away
        const firstCardContent = container.querySelector('.node-content');
        if (firstCardContent) {
            // Call the function directly, passing this (content) and parent (card)
            toggleCauldronCard(firstCardContent, firstCardContent.parentElement);
        }
    }
}

// 1. Build a lookup cache so rendering doesn't scan the array repeatedly
function getFavoriteKey(out, inputs) {
    return `${out}|${[...inputs].sort().join(',')}`;
}

function toggleCauldronCard(thisCard, cardElement) {
    const childrenContainer = cardElement.querySelector('.node-children');
    const isCollapsed = cardElement.classList.contains('collapsed');
    
    if (isCollapsed) {
        // Re-render on every expand (clearing old content keeps the DOM light)
        childrenContainer.innerHTML = '<div class="loading-placeholder"></div>';
        const outName = thisCard.dataset.out;
        renderRecipeRows(outName, childrenContainer);
    }
    cardElement.classList.toggle('collapsed');
}

function renderRecipeRows(outName, container) {
    const recipes = lastCauldronResults[outName];
    if (!recipes || recipes.length === 0) {
        container.innerHTML = '';
        return;
    }

    // Precompute estCost (only has a value when showEstCost is true)
    const recipesWithEst = recipes.map(r => {
        let estCost = null;
        let estString = '';
        if (cauldronState.showEstCost) {
            const { totalCost, string } = getRecipeEstCost(r.inputs);
            estCost = totalCost;    // May be null
            estString = string || '';
        }
        return { ...r, estCost, estString };
    });

    // Sort
    if (cauldronState.orderByEstCost) {
        // By estCost ascending, null last, then by totalValue ascending
        recipesWithEst.sort((a, b) => {
            if (a.estCost === null && b.estCost === null) {
                return a.totalValue - b.totalValue;
            }
            if (a.estCost === null) return 1;
            if (b.estCost === null) return -1;
            if (a.estCost !== b.estCost) return a.estCost - b.estCost;
            return a.totalValue - b.totalValue;
        });
    } else {
        // Only by totalValue ascending (original behavior)
        recipesWithEst.sort((a, b) => a.totalValue - b.totalValue);
    }

    // Pre-index favorites, from O(N*M) down to O(N)
    const favSet = new Set(
        cauldronState.favorites
            .filter(f => f.output === outName)
            .map(f => [...f.inputs].sort().join(','))
    );

    container.innerHTML = '';
    const CHUNK_SIZE = 100; // Simple HTML renders fast in modern browsers
    let currentIndex = 0;

    // Event delegation: only needs binding once (ideally on the parent at page init, not here)
    if (!container.dataset.hasListener) {
        container.addEventListener('click', (e) => {
            const btn = e.target.closest('.btn-fav');
            if (btn) toggleFavoriteStar(e, btn);
        });
        container.dataset.hasListener = "true";
    }

    function renderChunk() {
        const end = Math.min(currentIndex + CHUNK_SIZE, recipesWithEst.length);
        const rows = [];
        for (let i = currentIndex; i < end; i++) {
            const r = recipesWithEst[i];
            rows.push(createRecipeRowHtml(r, outName, favSet));
        }
        container.insertAdjacentHTML('beforeend', rows.join(''));
        currentIndex = end;
        if (currentIndex < recipesWithEst.length) {
            requestAnimationFrame(renderChunk);
        }
    }

    requestAnimationFrame(renderChunk);
}

function createRecipeRowHtml(r, outName, favSet) {
    const { inputs, totalValue, estCost, estString } = r;
    const displayValue = r.displayValue !== undefined ? r.displayValue : totalValue;
    
    // Look up in the precomputed Set, much faster
    const sortedKey = [...inputs].sort().join(',');
    const isFav = favSet.has(sortedKey);
    
    let resultTag = `<span style="cursor:help;" title="${t('Calculation result')}">${Number(displayValue.toFixed(1))}</span>`;

    let ratioTag = '';
    if (cauldronState.activeType === 0) {
        const [i0, i1, i2] = inputs;
        if (i0 === i1 && i1 === i2) {
            ratioTag = `<span style="color:var(--danger); cursor:help;" title="${t('Discount for 3 identical inputs (0.5×)')}"> * 0.5</span>`;
        } else if (i0 === i1 || i1 === i2 || i2 === i0) {
            ratioTag = `<span style="color:var(--warn); cursor:help;" title="${t('Discount for 2 identical inputs (0.65×)')}"> * 0.65</span>`;
        }
    }

    // Prepare the HTML fragments
    const inputsHtml = inputs.map(n => {
        const item = DB.items[n] || { id: 0, cauldronCost: 0 };
        return `<img src="img/item${item.id}.png" class="item-icon-small">
                ${n} <span title="${t('Cauldron Cost')}" style="cursor:help;"><small>(${Number(item.cauldronCost.toFixed(1))})</small></span>`;
    }).join(' + ');

    const dataAttrs = inputs.map((n, idx) => `data-i${idx + 1}="${n}"`).join(' ');

    // Build the cost tag from estCost and estString
    let costHtml = '';
    if (cauldronState.showEstCost && estCost !== null) {
        costHtml = `<span class="cost-tag" style="margin-left:auto; margin-right:5px" 
                     title="${t('Estimated Cost')}: ${estString}">
                     ${Math.ceil(estCost).toLocaleString()} <img src="img/copper.png" class="item-icon-small">
                   </span>`;
    }

    return `
    <div class="cauldron-recipe-row">
        <span class="recipe-text">
            ${inputsHtml} 
            <span style="color:var(--info);">➔</span> ${resultTag} ${ratioTag}
        </span>
        ${costHtml}
        <button title="${t('Toggle Favorite')}" class="btn-fav ${isFav ? 'active' : ''}" 
            ${dataAttrs} data-out="${outName}">
            ${isFav ? '★' : '☆'}
        </button>
    </div>`;
}

function toggleFavoriteStar(event, btn) {
    event.stopPropagation();
    const { i1, i2, i3, out } = btn.dataset;
    const favs = cauldronState.favorites;

    // Type 1 has only 2 ingredients, Type 0 has 3
    const recipeInputs = cauldronState.activeType === 1
        ? [i1, i2].filter(Boolean).sort()
        : [i1, i2, i3].filter(Boolean).sort();

    const idx = favs.findIndex(f => f.output === out && [...f.inputs].sort().join('|') === recipeInputs.join('|'));

    if (idx > -1) {
        favs.splice(idx, 1);
        btn.classList.remove('active');
        btn.innerText = '☆';
    } else {
        favs.push({ inputs: recipeInputs, output: out });
        btn.classList.add('active');
        btn.innerText = '★';
    }
    renderCauldronFavorites();
    saveCauldronSettings();
    syncCauldronToMainDB();
}

function checkUnattainableItems(producedSet) {
    // producedSet is a Set of every item that can be produced
    const unattainableList = [];

    for (let name in DB.items) {
        const item = DB.items[name];
        if (item.cauldronTarget !== undefined && !producedSet.has(name)) {
            unattainableList.push(name);
        }
    }

    unattainableList.sort((a, b) => DB.items[a].cauldronTarget - DB.items[b].cauldronTarget);

    const section = document.getElementById('unattainable-section');
    const container = document.getElementById('unattainable-list');
    
    if (unattainableList.length > 0) {
        section.style.display = 'block';
        container.innerHTML = unattainableList.map(name => `
            <div class="picker-item" style="border-color:#444; padding:5px; cursor:default;">
                <div style="font-size:1.0em; display: flex; align-items: center;"><img src="img/item${DB.items[name]?.id ?? 0}.png" alt="icon" width="24" height="24">${name}</div>
                <div style="font-size:0.9em; color:var(--warn);" title="${t('Cauldron Target')}">T: ${DB.items[name].cauldronTarget}</div>
            </div>
        `).join('');
    } else {
        section.style.display = 'none';
    }
}

/* ==========================================================================
   SECTION: Favorite List
   ========================================================================== */

// toggleFavorite: takes any number of ingredients; the last argument is always the product name
function toggleFavorite(...args) {
    const out = args[args.length - 1];
    const inputs = args.slice(0, -1);
    const favs = cauldronState.favorites;
    const recipe = { inputs: inputs, output: out };
    const sortedNew = [...inputs].sort().join('|');
    const idx = favs.findIndex(f => f.output === out && [...f.inputs].sort().join('|') === sortedNew);

    if (idx > -1) favs.splice(idx, 1);
    else favs.push(recipe);

    renderCauldronFavorites();
    saveCauldronSettings();
    syncCauldronToMainDB();
}

function renderCauldronFavorites() {
    const container = document.getElementById('cauldron-favorites');
    container.innerHTML = '';
    const favs = cauldronState.favorites || [];
    if (favs.length === 0) {
        container.innerHTML = `<div style="color:#666; padding:10px; font-size:0.85em; text-align:center;">${t('No saved recipes yet.')}</div>`;
        return;
    }

    // 1. Group by output item
    const grouped = {};
    favs.forEach(f => {
        if (!grouped[f.output]) grouped[f.output] = [];
        grouped[f.output].push(f);
    });

    // 2. Render the cards
    const sortedOutputs = Object.keys(grouped).sort((a, b) => {
        const targetA = DB.items[a]?.cauldronTarget ?? Infinity;
        const targetB = DB.items[b]?.cauldronTarget ?? Infinity;
        return targetA - targetB;
    });
    
    sortedOutputs.forEach(outName => {
        let itemPerMin = 0; let heatPerItem = 0;
        const targetItem = DB.items[outName];
        if (targetItem !== undefined && targetItem.cauldronTarget !== undefined) {
            const stat = getCauldronStats(targetItem.cauldronTarget);
            itemPerMin = 60 / stat.time;
            heatPerItem = stat.time * stat.heat;
        }
        
        const items = grouped[outName];
        const card = document.createElement('div');        
        card.className = 'node cauldron-card'; // Favorites are not collapsed by default
        card.innerHTML = `
            <div class="node-content compact-card" onclick="this.parentElement.classList.toggle('collapsed')">
                <span class="tree-arrow">▼</span>
                <img src="img/item${DB.items[outName]?.id ?? 0}.png" class="item-icon">
                <span class="item-link"><strong>${outName}</strong></span>
                <span class="qty">(${items.length})</span>
                <span class="info-tag help-tag" title="${t('Throughput')}">${itemPerMin > 0 ? itemPerMin.toFixed(2) + '/min' : ''}</span>
                <span class="heat-tag help-tag" title="${t('Heat')}">${heatPerItem > 0 ? heatPerItem.toFixed(1) + 'P' : ''}</span>
            </div>
            <div class="node-children compact-children">
                ${items.map(f => {
                    const { totalCost, string } = getRecipeEstCost(f.inputs);
                    const costTitle = totalCost ? `${t('Estimated Cost')} ${totalCost} : ${string}` : `${t('Estimated Cost')}: None`;

                    return `
                    <div class="cauldron-recipe-row" title="${costTitle}">
                        <span class="recipe-text">
                            ${f.inputs.map(name => 
                                DB.items[name] 
                                    ? `<img src="img/item${DB.items[name].id}.png" class="item-icon-small">${name}` 
                                    : `<span style="color:var(--warn);" title="Item name not found">! ${name}</span>`
                            ).join(' + ')}
                        </span>
                        <button class="swap-btn" style="color:var(--warn); border-color:var(--warn);" 
                                onclick="toggleFavorite(${f.inputs.map(n => `'${n}'`).join(',')}, '${outName}')">
                            ×
                        </button>
                    </div>`;
                }).join('')}
            </div>
        `;
        container.appendChild(card);
    });
}


function removeFavorite(idx) {
    cauldronState.favorites.splice(idx, 1);    
    renderCauldronFavorites();
    saveCauldronSettings();
    syncCauldronToMainDB();
}

/**
 * Export the current profile's favorites as text (.txt)
 * Format: Item1 + Item2 (+ Item3) = Product
 */
function exportCauldronFavorites() {
    const favs = cauldronState.favorites;
    if (favs.length === 0) return alert("No recipes to export.");
    
    // One recipe per line
    const lines = favs.map(f => {
        return `${f.inputs.join(' + ')} = ${f.output}`;
    });
    
    const dataStr = lines.join('\n');
    const blob = new Blob([dataStr], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `cauldron_recipes.txt`;
    a.click();
    URL.revokeObjectURL(url);
}

/**
 * Import recipes from a text file
 * Expected format: Item1 + Item2 (+ Item3) = Product
  */
function importCauldronFavorites() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.txt';
    input.onchange = e => {
        const file = e.target.files[0];
        const reader = new FileReader();
        reader.onload = readerEvent => {
            try {
                const content = readerEvent.target.result;
                const lines = content.split(/\r?\n/); // Works with both Windows and Unix line endings
                const currentFavs = cauldronState.favorites;
                let importCount = 0;

                lines.forEach(line => {
                    if (!line.trim()) return; // Skip empty lines

                    // Parse "inputs = output"
                    const parts = line.split('=');
                    if (parts.length !== 2) return;

                    const output = parts[1].trim();
                    const inputs = parts[0].split('+').map(i => i.trim());

                    // Validate: 2 or 3 inputs, and the product exists in the database
                    if ((inputs.length === 2 || inputs.length === 3) && DB.items[output]) {
                        const sortedNew = [...inputs].sort();
                        
                        // Skip duplicates
                        const isExist = currentFavs.some(f => 
                            f.output === output && 
                            JSON.stringify([...f.inputs].sort()) === JSON.stringify(sortedNew)
                        );

                        if (!isExist) {
                            currentFavs.push({ inputs: sortedNew, output: output });
                            importCount++;
                        }
                    }
                });
                
                if (importCount > 0) {
                    saveCauldronSettings();
                    renderCauldronFavorites();
                    syncCauldronToMainDB();
                    alert(`Successfully imported ${importCount} recipes!`);
                } else {
                    alert("No new or valid recipes found in the file.");
                }
            } catch (err) {
                alert("Failed to parse file: " + err.message);
            }
        };
        reader.readAsText(file);
    };
    input.click();
}

/**
 * Sync favorites into the main database (DB.recipes)
 */
function syncCauldronToMainDB(notify = false) {
    const favs = cauldronState.favorites;
    if (favs.length === 0) return;
    //if (favs.length === 0) return alert("No recipes to sync.");
    //if (!confirm(`This will sync ${favs.length} recipes to the main calculator. Continue?`)) return;

    // 1. Remove the old auto-generated recipes
    DB.recipes = DB.recipes.filter(r => !r.id.startsWith("AUTO_GENERATED_CAULDRON"));

    // 2. Convert and import
    let importedCount = 0;
    favs.forEach((fav, index) => {

        const outputName = DB.items[fav.output] ? fav.output : queryDualItemName(fav.output);
        const inputNames = fav.inputs.map(input => {
            return DB.items[input] ? input : queryDualItemName(input);
        });
        const outputDef = DB.items[outputName];
        // Check that the target item and every name in inputs exist in DB
        const isValid = outputDef !== undefined && 
                        inputNames.every(name => DB.items[name] !== undefined);
        if (!isValid) return;

        // Compute the interpolated data
        const stats = getCauldronStats(outputDef.cauldronTarget || 0);

        // Count the input items (e.g. [Plank, Plank, Stone] -> {Plank: 2, Stone: 1})
        const inputCounts = {};
        let itemIdString = "";
        inputNames.forEach(name => {
            // Raw materials and relics have negative maxStack; each use takes only a fraction
            const inputDef = DB.items[name];
            let inputCount = 1;
            if (inputDef?.maxStack && inputDef.maxStack < 0) inputCount = 1.0 / (-inputDef.maxStack);
            inputCounts[name] = (inputCounts[name] || 0) + inputCount;
            itemIdString += `_${inputDef?.id ?? 0}`;
        });

        const machineType = inputNames.length === 3 ? "Cauldron" : "Advanced Cauldron";
        const newRecipe = {
            id: `AUTO_GENERATED_CAULDRON` + itemIdString,
            machine: machineType,
            inputs: inputCounts,
            outputs: { [outputName]: 1 },
            baseTime: parseFloat(stats.time),
            // Note: main database recipes don't usually store heatCost,
            // but it's stored as a special property so the calculation logic can use it
            // if the calculation engine reads per-recipe heat cost
            heatCost: parseFloat(stats.heat) 
        };

        DB.recipes.push(newRecipe);
        importedCount++;
    });
    console.info(`Synced ${importedCount} recipes from cauldron`);
    if (notify) alert(`Synced ${importedCount} recipes to the Production Tab! You can now select them in the calculator.`);
}


/* ==========================================================================
   SECTION: CAULDRON RECIPE MODAL (from recipe-modal shortcut)
   ========================================================================== */

let _cauldronModalState = {
    targetItem: null,
    cauldronType: 0,    // 0 = normal (3 slots), 1 = advanced (2 slots)
    slots: [null, null, null],
};

function openCauldronRecipeModal(targetItem) {
    _cauldronModalState.targetItem = targetItem;
    _cauldronModalState.cauldronType = 0;
    _cauldronModalState.slots = [null, null, null];

    const favs = cauldronState.favorites || [];
    const existing = favs.find(f => f.output === targetItem && f.inputs.length === 3);
    if (existing) {
        existing.inputs.forEach((name, i) => { _cauldronModalState.slots[i] = name; });
    }

    document.getElementById('cauldron-recipe-modal-title').innerText = t('Cauldron') + ' → ' + targetItem;
    _renderCauldronRecipeModal();
    document.getElementById('cauldron-recipe-modal').style.display = 'flex';
}

function _switchCauldronModalType(type) {
    _cauldronModalState.cauldronType = type;
    _cauldronModalState.slots = [null, null, null];

    const slotCount = type === 1 ? 2 : 3;
    const favs = cauldronState.favorites || [];
    const existing = favs.find(f => f.output === _cauldronModalState.targetItem && f.inputs.length === slotCount);
    if (existing) {
        existing.inputs.forEach((name, i) => { _cauldronModalState.slots[i] = name; });
    }
    _renderCauldronRecipeModal();
}

/**
 * Lower and upper cauldronTarget bounds for the target item:
 * sort all validTargets by cauldronTarget and use the midpoints to the neighbors as bounds
 */
function _getCauldronTargetBounds(targetItem) {
    const sorted = Object.keys(DB.items)
        .filter(name => DB.items[name].cauldronTarget !== undefined)
        .map(name => ({ name, target: DB.items[name].cauldronTarget }))
        .sort((a, b) => a.target - b.target);

    const idx = sorted.findIndex(x => x.name === targetItem);
    if (idx === -1) return null;

    const self = sorted[idx].target;
    const lower = idx > 0
        ? (sorted[idx - 1].target + self) / 2
        : null; // No left neighbor
    const upper = idx < sorted.length - 1
        ? (self + sorted[idx + 1].target) / 2
        : null; // No right neighbor

    return { self, lower, upper };
}

// Reuses resolveCauldronOutput3 / resolveCauldronOutput2
function _calcCauldronModalResult(slots, cauldronType) {
    const slotCount = cauldronType === 1 ? 2 : 3;
    const filled = slots.slice(0, slotCount);
    if (filled.some(s => !s)) return null;

    const validTargets = _getCauldronValidTargets();
    const maxTargetItem = validTargets.length ? validTargets.reduce((p, c) => (p.target > c.target ? p : c)) : null;
    const minTargetItem = validTargets.length ? validTargets.reduce((p, c) => (p.target < c.target ? p : c)) : null;

    if (cauldronType === 0) {
        const [n0, n1, n2] = filled;
        return resolveCauldronOutput3(n0, n1, n2, validTargets); // { output, ratio, T }
    } else {
        const [nA, nB] = filled;
        return resolveCauldronOutput2(nA, nB, validTargets, maxTargetItem, minTargetItem); // { output, T }
    }
}

function _renderCauldronRecipeModal() {
    const { targetItem, cauldronType, slots } = _cauldronModalState;
    const slotCount = cauldronType === 1 ? 2 : 3;
    const body = document.getElementById('cauldron-recipe-modal-body');

    // ── T value and output ──
    const result = _calcCauldronModalResult(slots, cauldronType);
    const T = result ? result.T : null;
    const currentOutput = result ? result.output : null;
    const allFilled = T !== null;
    const isMatch = allFilled && currentOutput === targetItem;

    // ── Target bounds ──
    const bounds = _getCauldronTargetBounds(targetItem);

    // ── Favorite state ──
    const favs = cauldronState.favorites || [];
    const favCount = favs.filter(f => f.output === currentOutput && f.inputs.length === slotCount).length;
    const sortedCurrentKey = slots.slice(0, slotCount).filter(Boolean).sort().join(',');
    const isCurrentFav = allFilled && favs.some(f =>
        f.output === targetItem && [...f.inputs].sort().join(',') === sortedCurrentKey
    );

    // ── mini-tab ──
    const tabHtml = `
        <div style="display:flex; gap:4px; margin-bottom:2px;">
            <button class="tab-btn mini-tab ${cauldronType === 0 ? 'active' : ''}"
                onclick="_switchCauldronModalType(0)">${t('Cauldron')}</button>
            <button class="tab-btn mini-tab ${cauldronType === 1 ? 'active' : ''}"
                onclick="_switchCauldronModalType(1)">${t('Advanced Cauldron')}</button>
        </div>`;

    // ── Slots + ctrl row ──
    // Always render 3 slots; in advanced mode the 3rd is hidden (keeps its space)
    let slotsHtml = '<div style="display:flex; gap:8px; align-items:flex-start;">';
    for (let i = 0; i < 3; i++) {
        const hidden = i >= slotCount;
        const name = hidden ? null : slots[i];
        const def = name ? DB.items[name] : null;
        const cost = def ? Number(def.cauldronCost.toFixed(2)) : null;

        slotsHtml += `
            <div style="display:flex; flex-direction:column; align-items:center; gap:4px; ${hidden ? 'visibility:hidden;' : ''}">
                <!-- picker button -->
                <button class="cauldron-slot-btn ${name ? 'active' : ''}"
                    onclick="_pickCauldronModalSlot(${i})"
                    style="display:flex; align-items:center; gap:4px; padding:5px 8px;
                           background:#1a1a1a; border:1px solid ${name ? '#557' : '#444'};
                           border-radius:4px; cursor:pointer; min-width:100px; color:inherit; font-size:0.85em;">
                    ${def
                        ? `<img src="img/item${def.id ?? 0}.png" width="18" height="18">`
                        : '<span style="opacity:0.4; font-size:1.1em;">＋</span>'}
                    <span>${name ?? (t('Set Input') + (i + 1))}</span>
                </button>
                <!-- cost control row: takes space whether or not something is selected -->
                <div style="display:flex; align-items:center; gap:3px; height:24px;">
                    ${name ? `
                        <button class="swap-btn" onclick="_shiftCauldronModalSlot(${i}, -1)">-</button>
                        <span style="font-size:0.8em; min-width:40px; text-align:center;">${cost}</span>
                        <button class="swap-btn" onclick="_shiftCauldronModalSlot(${i}, 1)">+</button>
                    ` : `
                        <button class="swap-btn" style="opacity:0.3;" onclick="_shiftCauldronModalSlot(${i}, 1)">+</button>
                    `}
                </div>
            </div>`;
    }
    slotsHtml += '</div>';

    // ── Output row ──
    let resultHtml = '';
    if (allFilled && currentOutput) {
        const outDef = DB.items[currentOutput] || {};
        resultHtml = `
            <div style="padding:5px 8px; border-radius:4px; font-size:0.85em; display:flex; align-items:center; gap:6px;
                        background:${isMatch ? 'rgba(0,200,100,0.1)' : 'rgba(200,50,50,0.1)'};
                        border:1px solid ${isMatch ? 'var(--success,#4c4)' : 'var(--danger,#c44)'};">
                <img src="img/item${outDef.id ?? 0}.png" width="20" height="20">
                ${isMatch
                    ? `<span style="color:var(--success,#4c4);">✔ ${t('Current Product')}：${currentOutput}</span>`
                    : `<span style="color:var(--danger,#c44);">✘ ${t('Current Product')}：${currentOutput}</span>`}
            </div>`;
    }

    // ── Target cauldronTarget and bounds ──
    let boundsHtml = `
            <div style="font-size:0.8em; color:#aaa; display:flex; align-items:center; gap:8px;">
                <img src="img/item${DB.items[targetItem]?.id ?? 0}.png" width="20" height="20">
                <span><strong style="color:#ddd;">${targetItem}</strong></span>
                <span>${t('Target Value')} = <strong style="color:#ddd;">${bounds.self}</strong></span>`;
    if (bounds && slotCount === 3) {
        const lowerStr = bounds.lower !== null ? Number(bounds.lower.toFixed(2)) : '-∞';
        const upperStr = bounds.upper !== null ? Number(bounds.upper.toFixed(2)) : '+∞';
        boundsHtml += `<span style="color:#888;">${t('Valid Range')}：[${lowerStr}, ${upperStr}]</span>`;
    }
    boundsHtml += `</div>`;

    // ── T value and its distance from the interval ──
    let tInfoHtml = '';
    if (bounds) {
        if (!allFilled) {
            tInfoHtml = `---`;
        } else {
            const tDisplay = Number(T.toFixed(3));
            const inBounds =
                (bounds.lower === null || T >= bounds.lower) &&
                (bounds.upper === null || T <= bounds.upper);
            const color = inBounds ? 'var(--success,#4c4)' : 'var(--danger,#c44)';

            const dLower = bounds.lower !== null && slotCount === 3
                ? Number((T - bounds.lower).toFixed(3))
                : null;
            const dUpper = bounds.upper !== null && slotCount === 3
                ? Number((bounds.upper - T).toFixed(3))
                : null;

            const dLowerStr = dLower !== null
                ? `${t('Distance to lower bound')}：<span style="color:${dLower >= 0 ? '#4c4' : '#c44'};">${dLower >= 0 ? '+' : ''}${dLower}</span>`
                : '';
            const dUpperStr = dUpper !== null
                ? `${t('Distance to upper bound')}：<span style="color:${dUpper >= 0 ? '#4c4' : '#c44'};">${dUpper >= 0 ? '+' : ''}${dUpper}</span>`
                : '';

            tInfoHtml = `
                <div style="font-size:0.8em; display:flex; align-items:center; gap:12px;">
                    <span>${t('Current Value')} = <strong style="color:${color};">${tDisplay}</strong></span>
                    ${dLowerStr ? `<span>${dLowerStr}</span>` : ''}
                    ${dUpperStr ? `<span>${dUpperStr}</span>` : ''}
                </div>`;
        }
    }

    // ── Bottom button row ──
    const bottomHtml = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:2px;">            
            <span style="font-size:0.8em; color:#888;"><img src="img/item${DB.items[currentOutput]?.id ?? 0}.png" width="18" height="18"> ${t('Current Product')} ${t('Saved Recipes')} : ${favCount}</span>
            <div style="display:flex; gap:6px;">
                <button class="swap-btn"
                    title="${t('Toggle favorite')}"
                    style="width:auto; padding:3px 10px; border-radius:4px; font-size:1.1em; ${allFilled ? '' : 'opacity:0.4; cursor:not-allowed;'}"
                    onclick="_toggleCauldronModalFav()" ${allFilled ? '' : 'disabled'}>
                    ${isCurrentFav ? '★' : '☆'}
                </button>
                <button class="swap-btn"
                    style="width:auto; padding:3px 12px; border-radius:4px;
                           background:${isMatch ? 'rgba(0,160,80,0.3)' : '#222'};
                           border-color:${isMatch ? 'var(--success,#4c4)' : '#555'};
                           ${isMatch ? '' : 'opacity:0.4; cursor:not-allowed;'}"
                    onclick="_applyCauldronModalRecipe()" ${isMatch ? '' : 'disabled'}>
                    ${t('Apply')}
                </button>
            </div>
        </div>`;

    body.innerHTML = `
        <div style="padding:12px; display:flex; flex-direction:column; gap:8px;">
            ${tabHtml}
            ${slotsHtml}
            ${resultHtml}
            ${boundsHtml}
            ${tInfoHtml}
            ${bottomHtml}
        </div>`;
}

/**
 * Same logic as shiftFilterItem on the cauldron page, but for the modal slots
 */
function _shiftCauldronModalSlot(slotIdx, delta) {
    const list = Object.keys(DB.items)
        .filter(isVaildCandidate)
        .sort((a, b) => DB.items[a].cauldronCost - DB.items[b].cauldronCost);
    if (list.length === 0) return;

    const current = _cauldronModalState.slots[slotIdx];
    let nextIdx = 0;
    if (current) {
        const idx = list.indexOf(current);
        nextIdx = (idx + delta + list.length) % list.length;
    } else {
        nextIdx = delta > 0 ? 0 : list.length - 1;
    }
    _cauldronModalState.slots[slotIdx] = list[nextIdx];
    _renderCauldronRecipeModal();
}

function _pickCauldronModalSlot(slotIdx) {
    const originalSelectItem = window.selectItem;
    window.selectItem = (name) => {
        if (!isVaildCandidate(name)) {
            alert(`"${name}" is not a valid cauldron ingredient (no cauldronCost)`);
            window.selectItem = originalSelectItem;
            return;
        }
        _cauldronModalState.slots[slotIdx] = name;
        window.selectItem = originalSelectItem;
        closeModal('picker-modal');
        _renderCauldronRecipeModal();
    };
    openItemPicker();
}

function _toggleCauldronModalFav() {
    const { targetItem, cauldronType, slots } = _cauldronModalState;
    const slotCount = cauldronType === 1 ? 2 : 3;
    const inputs = slots.slice(0, slotCount).filter(Boolean).sort();
    if (inputs.length < slotCount) return;

    const favs = cauldronState.favorites;
    const key = inputs.join('|');
    const idx = favs.findIndex(f => f.output === targetItem && [...f.inputs].sort().join('|') === key);
    if (idx > -1) favs.splice(idx, 1);
    else favs.push({ inputs, output: targetItem });

    saveCauldronSettings();
    renderCauldronFavorites();
    _renderCauldronRecipeModal();
}

function _applyCauldronModalRecipe() {
    const { targetItem, cauldronType, slots } = _cauldronModalState;
    const slotCount = cauldronType === 1 ? 2 : 3;
    const inputs = slots.slice(0, slotCount).filter(Boolean).sort();
    if (inputs.length < slotCount) return;

    // 1. Make sure it's a favorite
    const favs = cauldronState.favorites;
    const key = inputs.join('|');
    if (!favs.some(f => f.output === targetItem && [...f.inputs].sort().join('|') === key)) {
        favs.push({ inputs, output: targetItem });
    }
    saveCauldronSettings();
    renderCauldronFavorites();

    // 2. Sync to the main DB and apply the matching recipe
    syncCauldronToMainDB();

    const matchedRecipe = (DB.recipes || []).find(r => {
        if (!r.id?.startsWith('AUTO_GENERATED_CAULDRON')) return false;
        if (!r.outputs?.[targetItem]) return false;
        return Object.keys(r.inputs).sort().join(',') === [...inputs].sort().join(',');
    });
    if (matchedRecipe) {
        DB.settings.preferredRecipes[targetItem] = matchedRecipe.id;
        persist();
    }

    // 3. Close both modals and recalculate
    closeModal('cauldron-recipe-modal');
    closeModal('recipe-modal');
    calculate();
}