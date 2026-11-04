/* ==========================================================================
   SECTION: JS - EXP PLANNER TAB
   ==========================================================================
   Ranks every way of getting EXP at the Knowledge Altar:
     - Relics give their fixed `exp` value (optionally boosted by a user-set
       Relic Knowledge bonus %).
     - Any other (non-liquid, non-virtual) item can be decomposed for
       baseCost * 0.0002 EXP per unit (x |maxStack| for stack-type items,
       same convention as the Wiki's "Decompose Exp").

   Cost per unit comes from AlchemyCalcEngine.computeUnitMaterialBreakdown,
   so it follows the current skill levels (Factory Efficiency, Alchemy Skill,
   Fuel/Fert Efficiency...), selected fuel/fert/heating device, preferred
   recipes, recipe modifiers and custom costs -- exactly like the
   Calculator's 1-unit breakdown modal.

   Leftovers: the user can list items they already have (byproducts / spare
   output of other lines). Those are valued at 0 (free) or at their forgone
   sell value, and compared against the cheapest purchasable EXP source.

   Persisted in DB.settings.expPage.
   ========================================================================== */

const EXP_DECOMPOSE_RATE = 0.0002;
const EXP_TABLE_PAGE = 60;

let EXP_STATE = {
    rows: null,        // computed rows
    cacheKey: null,    // settings snapshot the rows were computed for
    computing: false,
    runId: 0,
    sortKey: 'expPerKCoin',
    sortDir: -1,
    showAll: false,
};

function getExpSettings() {
    if (!DB.settings.expPage) DB.settings.expPage = {};
    const s = DB.settings.expPage;
    if (typeof s.relicBonus !== 'number') s.relicBonus = 0;
    if (!s.leftoverValue) s.leftoverValue = 'free';
    if (!Array.isArray(s.leftovers)) s.leftovers = [];
    if (typeof s.search !== 'string') s.search = '';
    if (typeof s.category !== 'string') s.category = '';
    if (typeof s.hideNoCost !== 'boolean') s.hideNoCost = true;
    return s;
}

function escExp(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtExpNum(v, digits = 2) {
    if (v == null || !isFinite(v)) return '—';
    const a = Math.abs(v);
    if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (a >= 1e4) return (v / 1e3).toFixed(1) + 'k';
    if (a >= 100) return v.toFixed(0);
    if (a >= 1) return v.toFixed(digits);
    if (a === 0) return '0';
    return v.toPrecision(3);
}

function fmtExpTime(sec) {
    if (sec == null || !isFinite(sec)) return '—';
    if (sec < 60) return sec.toFixed(1) + ' s';
    if (sec < 3600) return (sec / 60).toFixed(1) + ' min';
    return (sec / 3600).toFixed(1) + ' h';
}

function expItemIcon(item, size = 22) {
    const id = DB.items[item]?.id ?? 0;
    return `<img src="img/item${id}.png" width="${size}" height="${size}" class="exp-icon" alt="">`;
}

/** Params for the engine, taken from the Calculator tab (levels, fuel, fert, heating). */
function getExpCalcParams() {
    let p = null;
    try {
        p = (typeof gatherInputs === 'function') ? gatherInputs() : null;
    } catch (e) {
        console.warn('[EXP] gatherInputs failed, falling back to saved settings', e);
    }
    if (!p) {
        const s = DB.settings;
        p = {
            lvlSpeed: s.lvlSpeed || 0, lvlBelt: s.lvlBelt || 0, lvlAlchemy: s.lvlAlchemy || 0,
            lvlFuel: s.lvlFuel || 0, lvlFert: s.lvlFert || 0, lvlSell: s.lvlSell || 0,
            selectedFuel: s.defaultFuel, selectedFert: s.defaultFert,
            selectedHeatingDevice: s.selectedHeatingDevice,
            selfFuel: !!s.selfFuel, selfFert: !!s.selfFert,
            fuelCost: s.customCosts?.[s.defaultFuel] || 0,
            fertCost: s.customCosts?.[s.defaultFert] || 0,
            beltSpeed: AlchemyCalcEngine.getBeltSpeed(s.lvlBelt || 0),
            speedMult: AlchemyCalcEngine.getSpeedMult(s.lvlSpeed || 0),
            alchemyMult: AlchemyCalcEngine.getAlchemyMult(s.lvlAlchemy || 0),
            sellMult: AlchemyCalcEngine.getSellMult(s.lvlSell || 0),
            wholesaleMult: AlchemyCalcEngine.getSellMult(s.lvlContract || 0),
            fuelMult: 1 + (s.lvlFuel || 0) * 0.10,
            fertMult: 1 + (s.lvlFert || 0) * 0.10,
        };
    }
    return p;
}

function getExpEngineState() {
    return {
        activeRecyclers: (typeof GLOBAL_CALC_STATE !== 'undefined' && GLOBAL_CALC_STATE.activeRecyclers) ? GLOBAL_CALC_STATE.activeRecyclers : new Set(),
        forcedExternals: new Set(),
        preferredRecipes: DB.settings.preferredRecipes || {},
        nodeRecipeOverrides: {},
        recipeModifiers: DB.settings.recipeModifiers || {},
        customCosts: DB.settings.customCosts || {},
        expandCatalystInputs: DB.settings.expandCatalystInputs || {}
    };
}

function isExpCandidate(def) {
    if (!def || def.virtual || def.liquid) return false;
    if (def.category === 'Liquid') return false;
    return !!(def.exp || def.baseCost > 0);
}

/** EXP gained at the Knowledge Altar from 1 unit (calculator unit) of the item. */
function getItemExp(item, relicBonusPct) {
    const def = DB.items[item];
    if (!def) return 0;
    if (def.exp) return def.exp * (1 + (relicBonusPct || 0) / 100);
    let exp = AlchemyCalcEngine.computeDecomposeExp(DB, item) || 0;
    if (def.maxStack < 0) exp *= -def.maxStack;
    return exp;
}

/** Knowledge Altar processing time (seconds) for 1 unit, with Factory Efficiency. */
function getItemAltarTime(item, speedMult) {
    const def = DB.items[item];
    let time = AlchemyCalcEngine.computeDecomposeTime(DB, item);
    if (!time) return null;
    if (def.maxStack < 0) time *= -def.maxStack;
    return time / (speedMult || 1);
}

function getItemSellValue(item, sellMult) {
    const def = DB.items[item];
    if (!def || !def.sellPrice) return null;
    return def.category === 'Currency' ? def.sellPrice : Math.round(def.sellPrice * (sellMult || 1));
}

function getExpCacheKey(p, s) {
    return JSON.stringify([
        p.lvlSpeed, p.lvlAlchemy, p.lvlFuel, p.lvlFert, p.lvlSell, p.lvlBelt,
        p.selectedFuel, p.selectedFert, p.selectedHeatingDevice, p.selfFuel, p.selfFert,
        p.fuelCost, p.fertCost, s.relicBonus,
        DB.settings.preferredRecipes, DB.settings.recipeModifiers, DB.settings.customCosts,
        DB.settings.thermalExtractorHeight,
        [...((typeof GLOBAL_CALC_STATE !== 'undefined' && GLOBAL_CALC_STATE.activeRecyclers) || [])]
    ]);
}

/* ---------------- Page shell ---------------- */

function initExpPage() {
    const view = document.getElementById('view-exp');
    if (!view) return;
    if (!view.dataset.ready) {
        view.innerHTML = buildExpShell();
        view.dataset.ready = '1';
    }
    const s = getExpSettings();
    document.getElementById('exp-relic-bonus').value = s.relicBonus;
    document.getElementById('exp-leftover-value').value = s.leftoverValue;
    document.getElementById('exp-search').value = s.search;
    document.getElementById('exp-hide-nocost').checked = s.hideNoCost;
    fillExpItemDatalist();
    renderExpSkillSummary();
    renderExpLeftoverRows();

    const p = getExpCalcParams();
    if (!EXP_STATE.rows || EXP_STATE.cacheKey !== getExpCacheKey(p, s)) {
        computeExpRows();
    } else {
        renderExpAll();
    }
}

function buildExpShell() {
    return `
    <div class="exp-page">
        <div class="exp-top-grid">
            <div class="panel">
                <h3>${t('EXP Planner')}</h3>
                <div id="exp-skill-summary" class="exp-skill-summary"></div>
                <div class="exp-hint">${t('Skill levels, fuel, fertilizer, heating device and preferred recipes are taken from the Calculator tab settings.')}</div>
                <div class="exp-field-row">
                    <label for="exp-relic-bonus" title="${t('Extra EXP % applied to relics (Relic Knowledge). Enter the bonus shown in-game.')}">${t('Relic EXP bonus')} (%)</label>
                    <input type="number" id="exp-relic-bonus" min="0" step="1" value="0" onchange="onExpSettingChange()">
                </div>
                <div class="exp-field-row">
                    <button class="save-btn exp-btn" onclick="computeExpRows(true)">⟳ ${t('Recalculate')}</button>
                    <span id="exp-progress" class="exp-hint"></span>
                </div>
            </div>
            <div class="panel">
                <h3>${t('Best Options')}</h3>
                <div id="exp-best-cards" class="exp-best-cards"></div>
            </div>
        </div>

        <div class="panel">
            <div class="panel-header-row">
                <h3>${t('Leftover Items')}</h3>
                <div class="exp-field-row" style="margin:0;">
                    <label for="exp-leftover-value">${t('Value leftovers as')}</label>
                    <select id="exp-leftover-value" onchange="onExpSettingChange()">
                        <option value="free">${t('Free (0 cost)')}</option>
                        <option value="sell">${t('Forgone sell price')}</option>
                    </select>
                </div>
            </div>
            <div class="exp-hint">${t('Add spare output or byproducts from your other production lines to see how much EXP they are worth, and whether to decompose or sell them.')}</div>
            <datalist id="exp-item-datalist"></datalist>
            <div id="exp-leftover-rows"></div>
            <button class="split-btn" onclick="addExpLeftover()">+ ${t('Add Item')}</button>
            <div id="exp-leftover-result"></div>
        </div>

        <div class="panel">
            <div class="panel-header-row">
                <h3>${t('All EXP Sources')}</h3>
                <div class="exp-filters">
                    <input type="text" id="exp-search" placeholder="${t('Search')}..." oninput="onExpFilterChange()">
                    <select id="exp-category" onchange="onExpFilterChange()"></select>
                    <label class="exp-check"><input type="checkbox" id="exp-hide-nocost" onchange="onExpFilterChange()"> ${t('Hide items without cost')}</label>
                </div>
            </div>
            <div class="exp-table-wrap">
                <table class="exp-table">
                    <thead><tr id="exp-table-head"></tr></thead>
                    <tbody id="exp-table-body"></tbody>
                </table>
            </div>
            <div id="exp-table-footer" class="exp-hint"></div>
        </div>
    </div>`;
}

function renderExpSkillSummary() {
    const el = document.getElementById('exp-skill-summary');
    if (!el) return;
    const p = getExpCalcParams();
    const chips = [
        [t('Factory Efficiency'), `Lv ${p.lvlSpeed} (${Math.round(p.speedMult * 100)}%)`],
        [t('Alchemy Skill'), `Lv ${p.lvlAlchemy} (${Math.round(p.alchemyMult * 100)}%)`],
        [t('Fuel Efficiency'), `Lv ${p.lvlFuel} (${Math.round(p.fuelMult * 100)}%)`],
        [t('Fert Efficiency'), `Lv ${p.lvlFert} (${Math.round(p.fertMult * 100)}%)`],
        [t('Retail Price'), `Lv ${p.lvlSell} (${Math.round(p.sellMult * 100)}%)`],
        [t('Fuel'), `${expItemIcon(p.selectedFuel, 18)} ${escExp(p.selectedFuel)}${p.selfFuel ? ' (self)' : ''}`],
        [t('Fertilizer'), `${expItemIcon(p.selectedFert, 18)} ${escExp(p.selectedFert)}${p.selfFert ? ' (self)' : ''}`],
        [t('Heating'), escExp(t(p.selectedHeatingDevice || 'Stone Furnace', 'machines'))],
    ];
    el.innerHTML = chips.map(([k, v]) => `<span class="exp-chip"><span class="exp-chip-k">${k}</span> ${v}</span>`).join('')
        + ` <button class="split-btn exp-small-btn" onclick="switchTab('calc')">${t('Edit')}</button>`;
}

function fillExpItemDatalist() {
    const dl = document.getElementById('exp-item-datalist');
    if (!dl || dl.dataset.filled) return;
    dl.innerHTML = Object.keys(DB.items)
        .filter(k => isExpCandidate(DB.items[k]))
        .sort()
        .map(k => `<option value="${escExp(k)}"></option>`).join('');
    dl.dataset.filled = '1';
}

function onExpSettingChange() {
    const s = getExpSettings();
    s.relicBonus = parseFloat(document.getElementById('exp-relic-bonus').value) || 0;
    s.leftoverValue = document.getElementById('exp-leftover-value').value;
    persist();
    const p = getExpCalcParams();
    if (EXP_STATE.cacheKey !== getExpCacheKey(p, s)) computeExpRows();
    else renderExpAll();
}

function onExpFilterChange() {
    const s = getExpSettings();
    s.search = document.getElementById('exp-search').value;
    s.category = document.getElementById('exp-category').value;
    s.hideNoCost = document.getElementById('exp-hide-nocost').checked;
    EXP_STATE.showAll = false;
    persist();
    renderExpTable();
}

/* ---------------- Computation ---------------- */

function computeExpRows(force = false) {
    const s = getExpSettings();
    const p = getExpCalcParams();
    const key = getExpCacheKey(p, s);
    if (!force && EXP_STATE.rows && EXP_STATE.cacheKey === key) { renderExpAll(); return; }

    const runId = ++EXP_STATE.runId;
    EXP_STATE.computing = true;
    renderExpSkillSummary();

    const engineState = getExpEngineState();
    const items = Object.keys(DB.items).filter(k => isExpCandidate(DB.items[k]));
    const rows = [];
    const progress = document.getElementById('exp-progress');
    let i = 0;

    const step = () => {
        if (runId !== EXP_STATE.runId) return; // superseded
        const end = Math.min(i + 12, items.length);
        for (; i < end; i++) {
            rows.push(buildExpRow(items[i], p, s, engineState));
        }
        if (progress) progress.textContent = `${t('Calculating')}... ${i}/${items.length}`;
        if (i < items.length) {
            setTimeout(step, 0);
        } else {
            EXP_STATE.rows = rows;
            EXP_STATE.cacheKey = key;
            EXP_STATE.computing = false;
            if (progress) progress.textContent = `${items.length} ${t('items evaluated')}`;
            renderExpAll();
        }
    };
    step();
}

function buildExpRow(item, p, s, engineState) {
    const def = DB.items[item];
    const exp = getItemExp(item, s.relicBonus);
    const altarSec = getItemAltarTime(item, p.speedMult);
    const sellValue = getItemSellValue(item, p.sellMult);

    let unitCost = null, rawCost = 0, heatCost = 0, fertCost = 0;
    try {
        const d = AlchemyCalcEngine.computeUnitMaterialBreakdown(DB, engineState, item, p);
        if (d && d.totalUnitCost > 0 && isFinite(d.totalUnitCost)) {
            unitCost = d.totalUnitCost;
            rawCost = d.totalRawCost;
            heatCost = d.heatingCost;
            fertCost = d.fertCost;
        }
    } catch (e) {
        console.warn('[EXP] breakdown failed for', item, e);
    }

    return {
        item,
        id: def.id ?? 0,
        category: def.category || '',
        tier: def.tier ?? 0,
        isRelic: !!def.exp,
        exp,
        unitCost, rawCost, heatCost, fertCost,
        coinsPerExp: (unitCost && exp > 0) ? unitCost / exp : null,
        expPerKCoin: (unitCost && exp > 0) ? exp / unitCost * 1000 : null,
        sellValue,
        sellPerExp: (sellValue && exp > 0) ? sellValue / exp : null,
        altarSec,
        expPerAltarMin: (altarSec && exp > 0) ? exp * 60 / altarSec : null,
    };
}

/* ---------------- Rendering ---------------- */

function renderExpAll() {
    renderExpCategoryOptions();
    renderExpBestCards();
    renderExpLeftoverResult();
    renderExpTable();
}

function renderExpCategoryOptions() {
    const sel = document.getElementById('exp-category');
    if (!sel || !EXP_STATE.rows) return;
    const s = getExpSettings();
    const cats = [...new Set(EXP_STATE.rows.map(r => r.category))].sort();
    sel.innerHTML = `<option value="">${t('All Categories')}</option>`
        + `<option value="__relic">★ ${t('Relics only')}</option>`
        + cats.map(c => `<option value="${escExp(c)}">${escExp(t(c))}</option>`).join('');
    sel.value = s.category;
    if (sel.value !== s.category) sel.value = '';
}

function getBestPurchasable() {
    if (!EXP_STATE.rows) return null;
    return EXP_STATE.rows.filter(r => r.expPerKCoin).sort((a, b) => b.expPerKCoin - a.expPerKCoin)[0] || null;
}

function renderExpBestCards() {
    const el = document.getElementById('exp-best-cards');
    if (!el || !EXP_STATE.rows) return;
    const rows = EXP_STATE.rows;
    const byCoin = rows.filter(r => r.expPerKCoin).sort((a, b) => b.expPerKCoin - a.expPerKCoin);
    const relicByCoin = byCoin.filter(r => r.isRelic);
    const byAltar = rows.filter(r => r.expPerAltarMin && r.expPerKCoin).sort((a, b) => b.expPerAltarMin - a.expPerAltarMin);
    const bySell = rows.filter(r => r.sellPerExp).sort((a, b) => a.sellPerExp - b.sellPerExp);

    const card = (title, r, main, sub) => r ? `
        <div class="exp-card">
            <div class="exp-card-title">${title}</div>
            <div class="exp-card-item">${expItemIcon(r.item, 28)} <strong>${escExp(r.item)}</strong></div>
            <div class="exp-card-main">${main}</div>
            <div class="exp-card-sub">${sub}</div>
        </div>` : '';

    el.innerHTML =
        card(t('Most EXP per coin'), byCoin[0],
            `${fmtExpNum(byCoin[0]?.expPerKCoin)} EXP / 1k ${t('Coin')}`,
            `${fmtExpNum(byCoin[0]?.coinsPerExp)} ${t('coins per EXP')}`) +
        card(t('Best relic per coin'), relicByCoin[0],
            `${fmtExpNum(relicByCoin[0]?.expPerKCoin)} EXP / 1k ${t('Coin')}`,
            `${fmtExpNum(relicByCoin[0]?.exp)} EXP ${t('each')} · ${fmtExpNum(relicByCoin[0]?.coinsPerExp)} ${t('coins per EXP')}`) +
        card(t('Fastest per Knowledge Altar'), byAltar[0],
            `${fmtExpNum(byAltar[0]?.expPerAltarMin)} EXP / min`,
            `${fmtExpNum(byAltar[0]?.coinsPerExp)} ${t('coins per EXP')}`) +
        card(t('Cheapest to give up (vs selling)'), bySell[0],
            `${fmtExpNum(bySell[0]?.sellPerExp)} ${t('sell coins lost per EXP')}`,
            t('Best if you already hold sellable stock'));
}

const EXP_COLUMNS = [
    { key: 'item', label: 'Item', num: false },
    { key: 'category', label: 'Category', num: false },
    { key: 'exp', label: 'EXP / unit', num: true },
    { key: 'unitCost', label: 'Cost / unit', num: true },
    { key: 'expPerKCoin', label: 'EXP / 1k coins', num: true },
    { key: 'coinsPerExp', label: 'Coins / EXP', num: true },
    { key: 'sellPerExp', label: 'Sell value / EXP', num: true },
    { key: 'altarSec', label: 'Altar time / unit', num: true },
    { key: 'expPerAltarMin', label: 'EXP / min / altar', num: true },
    { key: 'actions', label: '', num: false, nosort: true },
];

function sortExpBy(key) {
    if (EXP_STATE.sortKey === key) EXP_STATE.sortDir *= -1;
    else {
        EXP_STATE.sortKey = key;
        // "lower is better" columns default ascending
        EXP_STATE.sortDir = ['coinsPerExp', 'sellPerExp', 'altarSec', 'unitCost', 'item', 'category'].includes(key) ? 1 : -1;
    }
    renderExpTable();
}

function renderExpTable() {
    const head = document.getElementById('exp-table-head');
    const body = document.getElementById('exp-table-body');
    const footer = document.getElementById('exp-table-footer');
    if (!head || !body) return;

    head.innerHTML = EXP_COLUMNS.map(c => {
        const arrow = EXP_STATE.sortKey === c.key ? (EXP_STATE.sortDir > 0 ? ' ▲' : ' ▼') : '';
        return c.nosort
            ? `<th></th>`
            : `<th class="${c.num ? 'num' : ''}" onclick="sortExpBy('${c.key}')">${t(c.label)}${arrow}</th>`;
    }).join('');

    if (!EXP_STATE.rows) {
        body.innerHTML = `<tr><td colspan="${EXP_COLUMNS.length}" class="exp-hint">${t('Calculating')}...</td></tr>`;
        return;
    }

    const s = getExpSettings();
    const q = s.search.trim().toLowerCase();
    let rows = EXP_STATE.rows.filter(r => {
        if (s.hideNoCost && !r.unitCost) return false;
        if (s.category === '__relic' && !r.isRelic) return false;
        if (s.category && s.category !== '__relic' && r.category !== s.category) return false;
        if (q && !r.item.toLowerCase().includes(q)) return false;
        return true;
    });

    const k = EXP_STATE.sortKey, dir = EXP_STATE.sortDir;
    rows.sort((a, b) => {
        const va = a[k], vb = b[k];
        if (va == null && vb == null) return 0;
        if (va == null) return 1;   // missing values always last
        if (vb == null) return -1;
        if (typeof va === 'string') return va.localeCompare(vb) * dir;
        return (va - vb) * dir;
    });

    const best = getBestPurchasable();
    const total = rows.length;
    if (!EXP_STATE.showAll) rows = rows.slice(0, EXP_TABLE_PAGE);

    body.innerHTML = rows.map(r => {
        const costTitle = r.unitCost
            ? `${t('Raw')}: ${fmtExpNum(r.rawCost)} · ${t('Heat')}: ${fmtExpNum(r.heatCost)} · ${t('Fert')}: ${fmtExpNum(r.fertCost)}`
            : t('No cost data (no recipe or purchase price)');
        return `
        <tr class="${r.isRelic ? 'exp-relic-row' : ''} ${best && r.item === best.item ? 'exp-best-row' : ''}">
            <td class="exp-item-cell">${expItemIcon(r.item)} ${escExp(r.item)}${r.isRelic ? ' <span class="exp-tag">★ ' + t('Relic') + '</span>' : ''}</td>
            <td>${escExp(t(r.category))}</td>
            <td class="num">${fmtExpNum(r.exp, 3)}</td>
            <td class="num" title="${escExp(costTitle)}">${fmtExpNum(r.unitCost)}</td>
            <td class="num exp-strong">${fmtExpNum(r.expPerKCoin, 3)}</td>
            <td class="num">${fmtExpNum(r.coinsPerExp)}</td>
            <td class="num">${fmtExpNum(r.sellPerExp)}</td>
            <td class="num">${fmtExpTime(r.altarSec)}</td>
            <td class="num">${fmtExpNum(r.expPerAltarMin)}</td>
            <td>
                <button class="split-btn exp-small-btn" data-item="${escExp(r.item)}" onclick="openExpItemInCalc(this.dataset.item)" title="${t('Open in Calculator')}">📊</button>
                <button class="split-btn exp-small-btn" data-item="${escExp(r.item)}" onclick="addExpLeftover(this.dataset.item)" title="${t('Add to leftovers')}">＋</button>
            </td>
        </tr>`;
    }).join('') || `<tr><td colspan="${EXP_COLUMNS.length}" class="exp-hint">${t('None')}</td></tr>`;

    if (footer) {
        footer.innerHTML = (total > EXP_TABLE_PAGE)
            ? `${EXP_STATE.showAll ? total : Math.min(EXP_TABLE_PAGE, total)} / ${total} · <a href="#" onclick="EXP_STATE.showAll=!EXP_STATE.showAll; renderExpTable(); return false;">${EXP_STATE.showAll ? t('Show less') : t('Show all')}</a>`
            : `${total} ${t('items')}`;
        footer.innerHTML += ` · ${t('Cost includes raw materials, heating fuel and fertilizer at current settings. Hover a cost for the split.')}`;
    }
}

function openExpItemInCalc(item) {
    switchTab('calc');
    if (typeof recalculate === 'function') recalculate(item, 60);
}

/* ---------------- Leftovers ---------------- */

function addExpLeftover(item = '') {
    const s = getExpSettings();
    s.leftovers.push({ item, qty: 1, per: 'total' });
    persist();
    renderExpLeftoverRows();
    renderExpLeftoverResult();
}

function removeExpLeftover(idx) {
    const s = getExpSettings();
    s.leftovers.splice(idx, 1);
    persist();
    renderExpLeftoverRows();
    renderExpLeftoverResult();
}

function updateExpLeftover(idx, field, value) {
    const s = getExpSettings();
    const row = s.leftovers[idx];
    if (!row) return;
    if (field === 'item') {
        const match = Object.keys(DB.items).find(k => k.toLowerCase() === value.trim().toLowerCase());
        row.item = match || value.trim();
    } else if (field === 'qty') {
        row.qty = Math.max(0, parseFloat(value) || 0);
    } else if (field === 'per') {
        row.per = value;
    }
    persist();
    renderExpLeftoverResult();
}

function renderExpLeftoverRows() {
    const el = document.getElementById('exp-leftover-rows');
    if (!el) return;
    const s = getExpSettings();
    el.innerHTML = s.leftovers.map((l, idx) => `
        <div class="exp-leftover-row">
            ${expItemIcon(l.item, 24)}
            <input type="text" list="exp-item-datalist" value="${escExp(l.item)}" placeholder="${t('Item name')}"
                onchange="updateExpLeftover(${idx}, 'item', this.value); renderExpLeftoverRows();">
            <input type="number" min="0" step="any" value="${l.qty}" class="exp-qty" oninput="updateExpLeftover(${idx}, 'qty', this.value)">
            <select onchange="updateExpLeftover(${idx}, 'per', this.value)">
                <option value="total" ${l.per !== 'min' ? 'selected' : ''}>${t('units total')}</option>
                <option value="min" ${l.per === 'min' ? 'selected' : ''}>${t('per min')}</option>
            </select>
            <button class="split-btn exp-small-btn" onclick="removeExpLeftover(${idx})" title="${t('Remove')}">✕</button>
        </div>`).join('');
}

function renderExpLeftoverResult() {
    const el = document.getElementById('exp-leftover-result');
    if (!el) return;
    const s = getExpSettings();
    const p = getExpCalcParams();
    const valid = s.leftovers.filter(l => DB.items[l.item] && l.qty > 0);
    if (valid.length === 0) {
        el.innerHTML = s.leftovers.length ? `<div class="exp-hint">${t('Enter a valid item and quantity.')}</div>` : '';
        return;
    }

    const best = getBestPurchasable();
    let totExp = 0, totExpMin = 0, totSell = 0, totSellMin = 0, totAltarSec = 0, totAltars = 0;

    const lines = valid.map(l => {
        const def = DB.items[l.item];
        const canDecompose = isExpCandidate(def);
        const expUnit = canDecompose ? getItemExp(l.item, s.relicBonus) : 0;
        const altarSec = canDecompose ? getItemAltarTime(l.item, p.speedMult) : null;
        const sellUnit = getItemSellValue(l.item, p.sellMult);
        const exp = expUnit * l.qty;
        const sell = (sellUnit || 0) * l.qty;
        const perMin = l.per === 'min';

        if (perMin) {
            totExpMin += exp; totSellMin += sell;
            if (altarSec) totAltars += l.qty * altarSec / 60;
        } else {
            totExp += exp; totSell += sell;
            if (altarSec) totAltarSec += l.qty * altarSec;
        }

        // Verdict: is selling it and buying the best EXP source better than decomposing?
        let verdict = '';
        if (!canDecompose) {
            verdict = `<span class="exp-bad">${t('Cannot be decomposed')}</span>`;
        } else if (s.leftoverValue === 'free' || !sellUnit) {
            verdict = `<span class="exp-good">${t('Decompose (free EXP)')}</span>`;
        } else if (best) {
            const expIfSold = sellUnit / best.coinsPerExp; // EXP you could buy with the sell money
            verdict = expIfSold > expUnit
                ? `<span class="exp-warn">${t('Sell, then make')} ${escExp(best.item)} (${fmtExpNum(expIfSold / expUnit)}× EXP)</span>`
                : `<span class="exp-good">${t('Decompose')} (${fmtExpNum(expUnit / expIfSold)}× ${t('better than selling')})</span>`;
        }

        const unit = perMin ? '/min' : '';
        return `
            <tr>
                <td class="exp-item-cell">${expItemIcon(l.item)} ${escExp(l.item)}</td>
                <td class="num">${fmtExpNum(l.qty)}${unit}</td>
                <td class="num exp-strong">${fmtExpNum(exp)}${unit}</td>
                <td class="num">${sellUnit ? fmtExpNum(sell) + unit : '—'}</td>
                <td class="num">${altarSec ? (perMin ? fmtExpNum(l.qty * altarSec / 60) + ' ' + t('altars') : fmtExpTime(l.qty * altarSec)) : '—'}</td>
                <td>${verdict}</td>
            </tr>`;
    }).join('');

    const summary = [];
    if (totExp > 0) summary.push(`<strong>${fmtExpNum(totExp)} EXP</strong> ${t('one-off')} (${fmtExpTime(totAltarSec)} ${t('on 1 altar')}${totSell ? `, ${t('sell value')} ${fmtExpNum(totSell)}` : ''})`);
    if (totExpMin > 0) summary.push(`<strong>${fmtExpNum(totExpMin)} EXP/min</strong> ${t('ongoing')} (${fmtExpNum(totAltars)} ${t('altars needed')}${totSellMin ? `, ${t('sell value')} ${fmtExpNum(totSellMin)}/min` : ''})`);
    if (best && (totExp > 0 || totExpMin > 0)) {
        const eq = [];
        if (totExp > 0) eq.push(fmtExpNum(totExp * best.coinsPerExp));
        if (totExpMin > 0) eq.push(fmtExpNum(totExpMin * best.coinsPerExp) + '/min');
        summary.push(`${t('Worth')} ${eq.join(' + ')} ${t('coins of')} ${escExp(best.item)}`);
    }

    el.innerHTML = `
        <div class="exp-table-wrap">
            <table class="exp-table">
                <thead><tr>
                    <th>${t('Item')}</th><th class="num">${t('Qty')}</th><th class="num">EXP</th>
                    <th class="num">${t('Sell value')}</th><th class="num">${t('Altar')}</th><th>${t('Verdict')}</th>
                </tr></thead>
                <tbody>${lines}</tbody>
            </table>
        </div>
        <div class="exp-leftover-summary">${summary.join(' · ')}</div>`;
}
