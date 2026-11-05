// alchemy_main.js: Application entry point, initialization, URL state, module coordination

let isHandlingPopstate = false;

function init() {
    const localData = localStorage.getItem(STORAGE_KEY);
    const urlParams = new URLSearchParams(window.location.search);
    const urlTab = urlParams.get('tab');    
    const urlItem = urlParams.get('item');
    const urlRate = urlParams.get('rate');
    const urlFuel = urlParams.get('fuel');
    const urlFert = urlParams.get('fert');
    const urlSetupgrades = urlParams.get('setupgrades');
    

    if (!window.ALCHEMY_DB) { alert("Error: alchemy_db.js not found!"); }
    if (!window.ALCHEMY_I18N) { alert("Error: alchemy_i18n.js not found!"); }

    const localTranslation = localStorage.getItem(I18N_DATA_KEY);
    if (localTranslation) {
        try {
            console.log("Loading local translation data...");
            window.ALCHEMY_I18N = JSON.parse(localTranslation);
        } catch (e) {
            console.error("Local translation data corrupt, resetting...");
            window.ALCHEMY_I18N = JSON.parse(JSON.stringify(window.ALCHEMY_I18N));
        }
    } else {
        console.log("Loading remote translation data...");
        window.ALCHEMY_I18N = JSON.parse(JSON.stringify(window.ALCHEMY_I18N));
    }
    // English only: the Chinese mode is discontinued. Convert any data saved while it was on.
    window.ALCHEMY_I18N.enabled = false;
    migrateChineseSavedData();

    const fileDB = window.ALCHEMY_DB;
    if (localData) {
        try {
            console.log("Loading local database...");
            DB = JSON.parse(localData);
            const localVersion = DB.version || 0;
            const fileVersion = fileDB.version || 0;

            if (fileVersion != localVersion) {
                console.log(fileVersion);
                showUpdateBanner(localVersion, fileVersion);
            }
        } catch (e) {
            console.error("Local data corrupt, resetting...");
            DB = JSON.parse(JSON.stringify(fileDB));
        }
    } else {
        console.log("Loading remote database...");
        DB = JSON.parse(JSON.stringify(fileDB));
    }

    const baseSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    const savedSettings = localStorage.getItem(SETTINGS_KEY);
    if (savedSettings) {
        try {
            console.log("Loading user settings...");
            const parsed = JSON.parse(savedSettings);
            DB.settings = Object.assign(baseSettings, parsed);
        } catch (e) {
            console.error("Settings corrupt, using defaults");
            DB.settings = baseSettings;
        }
    } else {
        console.log("Loading default settings...");
        DB.settings = baseSettings;
    }
    
    if(!DB.items) DB.items = {};
    if(!DB.settings.preferredRecipes) DB.settings.preferredRecipes = {};
    if(!DB.settings.nodeRecipeOverrides) DB.settings.nodeRecipeOverrides = {};
    if(!DB.settings.recipeModifiers)  DB.settings.recipeModifiers = {};
    if(!DB.settings.activeRecyclers) DB.settings.activeRecyclers = {};
    if(!DB.settings.customCosts) DB.settings.customCosts = {};
    if(!DB.settings.expandCatalystInputs) DB.settings.expandCatalystInputs = { unstable: false, fertile: false, resonant: false, eternal: false };
    if(DB.settings.thermalExtractorHeight === undefined) DB.settings.thermalExtractorHeight = 255;

    translateDatabase(DB, true); // Translate DB item key

    prepareComboboxData();
    populateSelects(); 
    loadSettingsToUI();
    renderSlider(); // Initialize the slider logic
    
    if (urlItem) {
        document.getElementById('targetItemInput').value = englishItemName(decodeURIComponent(urlItem));
        updateComboIcon();
    }    
    if (urlRate) {
        document.getElementById('targetRate').disabled = false;
        document.getElementById('targetRate').value = urlRate;
    } else if (!DB.settings.targetItem) {
        // 沒有指定 rate、也沒有已儲存設定時，默認啟用 "Set by Machine Count" 模式，machine count = 1
        const machineModeToggle = document.getElementById('machineModeToggle');
        machineModeToggle.checked = true;
        toggleControlMode(false); // 切換 UI 狀態（禁用 rate 輸入、啟用 machine 輸入）
    }
    
    if (urlFuel && document.querySelector(`#fuelSelect option[value="${urlFuel}"]`)) {
        document.getElementById('fuelSelect').value = urlFuel;
    }
    if (urlFert && document.querySelector(`#fertSelect option[value="${urlFert}"]`)) {
        document.getElementById('fertSelect').value = urlFert;
    }
    if (urlSetupgrades) {
        /*
        [0]Logistics Efficiency
        [1]Throwing Efficiency
        [2]Factory Efficiency
        [3]Alchemy Skill
        [4]Fuel Efficiency
        [5]Fertilizer Efficiency
        [6]Sales Ability
        [7]Negotiation Skill
        [8]Customer Management
        [9]Relic Knowledge
        */
        const upgrades = urlSetupgrades.split(',').map(Number) || [];
        if (upgrades.length > 5) {
            console.log(urlSetupgrades);
            DB.settings.lvlBelt = upgrades[0];
            DB.settings.lvlSpeed = upgrades[2];
            DB.settings.lvlAlchemy = upgrades[3];
            DB.settings.lvlFuel = upgrades[4];
            DB.settings.lvlFert = upgrades[5];
            loadSettingsToUI();
            persist();
        }
    }

    // Import caldron recipes (if exist)
    try {
        loadCauldronSettings();
        syncCauldronToMainDB();
    } catch (e) {
        console.error(e);
    }

    calculate();
    
    if (urlTab) switchTab(urlTab, false);

    document.getElementById('db-gameversion-text').innerText = t("Game version : ") + DB.gameVersion ?? 0;
    
    const metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc) {
        metaDesc.content = "A production planning tool for the game Alchemy Factory. Supports cauldron recipes, multi-target production trees, node graph planner, wiki, and database editing";
    }
}

function loadSettingsToUI() {
    if (DB.settings) {
        ['lvlBelt','lvlSpeed','lvlAlchemy','lvlFuel','lvlFert', 'lvlSell', 'lvlContract'].forEach(k => { if(DB.settings[k] !== undefined) document.getElementById(k).value = DB.settings[k]; });
        if(DB.settings.defaultFuel) document.getElementById('fuelSelect').value = DB.settings.defaultFuel; 
        if(DB.settings.defaultFert) document.getElementById('fertSelect').value = DB.settings.defaultFert;
        const heatingSel = document.getElementById('heatingDeviceSelect');
        if(DB.settings.selectedHeatingDevice) heatingSel.value = DB.settings.selectedHeatingDevice;
        if(!heatingSel.value) {
            heatingSel.value = heatingSel.querySelector('option[value="Stone Furnace"]') ? "Stone Furnace" : (heatingSel.options[0]?.value || "");
            DB.settings.selectedHeatingDevice = heatingSel.value;
        }
        if(DB.settings.nodeSize) {
            document.getElementById('nodeScaleSlider').value = DB.settings.nodeSize;
            setNodeScale(DB.settings.nodeSize);
        }
        if(DB.settings.showMaxCap) document.getElementById('showMaxCap').checked = DB.settings.showMaxCap;
        if(DB.settings.showFuelFert) document.getElementById('showFuelFert').checked = DB.settings.showFuelFert;
        if(DB.settings.showRawMachineCount) document.getElementById('showRawMachineCount').checked = DB.settings.showRawMachineCount;
        if(DB.settings.showHeatFert) document.getElementById('showHeatFert').checked = DB.settings.showHeatFert;
        if(DB.settings.showBeltCount) document.getElementById('showBeltCount').checked = DB.settings.showBeltCount;

        // --- Restore Calculator target/mode state ---
        if (DB.settings.targetItem) {
            document.getElementById('targetItemInput').value = DB.settings.targetItem;
            updateComboIcon();
        }
        if (DB.settings.targetRate !== undefined) {
            document.getElementById('targetRate').value = DB.settings.targetRate;
        }
        if (DB.settings.targetMachineCount !== undefined) {
            document.getElementById('targetMachine').value = DB.settings.targetMachineCount;
        }
        if (DB.settings.machineModeToggle) {
            document.getElementById('machineModeToggle').checked = true;
            toggleControlMode(false); // 套用禁用/啟用對應輸入框的 UI 效果
        }
        if (DB.settings.selfFuel) {
            const btn = document.getElementById('btnSelfFuel');
            btn.classList.remove('btn-inactive-red');
            btn.classList.add('btn-active-green');
        }
        if (DB.settings.selfFert) {
            const btn = document.getElementById('btnSelfFert');
            btn.classList.remove('btn-inactive-red');
            btn.classList.add('btn-active-green');
        }
    }
}

function populateSelects() {
    const fuelSel = document.getElementById('fuelSelect'); const fertSel = document.getElementById('fertSelect'); const heatingSel = document.getElementById('heatingDeviceSelect');
    fuelSel.innerHTML = ''; fertSel.innerHTML = ''; heatingSel.innerHTML = '';
    const fuels = []; const ferts = [];
    const allItems = new Set(Object.keys(DB.items || {}));
    if(DB.recipes) DB.recipes.forEach(r => Object.keys(r.outputs).forEach(k => allItems.add(k)));

    allItems.forEach(itemName => {
        const itemDef = DB.items[itemName] || {};
        if(itemDef.heat) fuels.push({ name: itemName, heat: itemDef.heat });
        if(itemDef.nutrientValue) ferts.push({ name: itemName, val: itemDef.nutrientValue });
    });

    fuels.sort((a,b) => b.heat - a.heat).forEach(f => { fuelSel.appendChild(new Option(`${f.name} (${f.heat} P)`, f.name)); });
    ferts.sort((a,b) => b.val - a.val).forEach(f => { fertSel.appendChild(new Option(`${f.name} (${f.val} V)`, f.name)); });
    Object.entries(DB.machines || {})
        .filter(([, machine]) => machine.isGenerator)
        .sort(([nameA], [nameB]) => nameA.localeCompare(nameB))
        .forEach(([machineName, machine]) => {
            heatingSel.appendChild(new Option(`${t(machineName, 'machines')} (${machine.slots || 0} ${t('slots')})`, machineName));
        });
    heatingSel.value = DB.settings.selectedHeatingDevice || "Stone Furnace";
    if(!heatingSel.value) heatingSel.value = heatingSel.options[0]?.value || "";
}

/* ==========================================================================
   SECTION: Update Banner
   ========================================================================== */

function showUpdateBanner(oldV, newV) {
    const banner = document.getElementById('update-banner');
    banner.style.display = 'flex';
    document.getElementById('old-version-id').innerText = 'v' + oldV;
    document.getElementById('new-version-id').innerText = 'v' + newV;
    document.getElementById('ui-update-msg').innerText = t('New database version available', 'ui');
    document.getElementById('ui-update-local-msg').innerText = t('Current local version:', 'ui');
    document.getElementById('ui-btn-update').innerText = t('Update Now', 'ui');
    document.getElementById('ui-btn-later').innerText = t('Skip Update', 'ui');   
}

function closeUpdateBanner() {
    document.getElementById('update-banner').style.display = 'none';
    console.log("Bump local data version to " + window.ALCHEMY_DB.version);
    DB.version = window.ALCHEMY_DB.version;
    persist();
}

function performUpdate() {
    console.log("Updating database v" + window.ALCHEMY_DB.version);    
    const newData = JSON.parse(JSON.stringify(window.ALCHEMY_DB));
    if (DB && DB.settings) {
        newData.settings = DB.settings;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(newData));
    const localSourceData = localStorage.getItem(SOURCE_KEY);
    if (localSourceData) {
        localStorage.setItem(BACKUP_KEY, localSourceData);
    }
    localStorage.removeItem(SOURCE_KEY);
    location.reload();
}


/* ==========================================================================
   SECTION: Translation
   ========================================================================== */

function translateText() {
    const selectors = [
        'h1', '.panel h3', '.section-header', 
        'label', '.checkbox-row span', '.stat-label', '.scale-row-label',
        '.tab-btn', '.split-btn', '.save-btn', '.reset-btn', '.soild-btn', '.info'
    ].join(',');

    document.querySelectorAll(selectors).forEach(el => {
        const key = el.textContent.trim();
        el.textContent = t(key, 'ui');
    });

    const input = document.getElementById('targetItemInput');
    if (input) input.placeholder = t("Select or Type...", "ui");
    document.title = t("Alchemy Factory Calculator", "ui");
}

/* ==========================================================================
   SECTION: URL
   ========================================================================== */

function switchTab(tabName, updateUrl = true) {
    let btnIndex = 0;
    switch (tabName) {
        case 'calc': btnIndex = 0; break;
        case 'cauldron': btnIndex = 1; break;
        case 'planner': btnIndex = 2; break;
        case 'exp': btnIndex = 3; break;
        case 'help': btnIndex = 4; break;
        case 'db': btnIndex = 5; break;
        default: return;
    }
    document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
    document.getElementById('view-' + tabName).classList.add('active');

    const container = document.getElementById('page-tab-container');
    const tabBtns = container.querySelectorAll('.tab-btn');
    tabBtns.forEach(el => el.classList.remove('active'));
    if (tabBtns[btnIndex]) tabBtns[btnIndex].classList.add('active');

    if (updateUrl) {
        updateURL(tabName);
    }
    if (tabName === 'cauldron' && typeof initCauldron === 'function') {
        initCauldron();
    }
    if (tabName === 'help' && typeof initHelpPage === 'function') {
        initHelpPage();
    }
    if (tabName === 'planner' && typeof initPlannerPage === 'function') {
        initPlannerPage();
    }
    if (tabName === 'exp' && typeof initExpPage === 'function') {
        initExpPage();
    }
    if (tabName === 'calc') {
        syncCauldronToMainDB(); // 回到計算器頁面時, 嘗試同步煉金鍋配方
    }
}

function updateURL(tabName = '') {
    const params = new URLSearchParams();

    if (tabName !== '' && tabName !== 'calc') {
        params.set('tab', tabName);        
    }

    const newUrl = window.location.pathname + '?' + params.toString();
    if (isHandlingPopstate) {        
        window.history.replaceState(null, '', newUrl);
    }
    else {
        window.history.pushState(null, '', newUrl);
    }
}

window.addEventListener('popstate', function(event) {
    isHandlingPopstate = true;
    const urlParams = new URLSearchParams(window.location.search);

    // 處理 tab（若無 tab 參數則切回預設 calc）
    if (urlParams.has('tab')) {
        switchTab(urlParams.get('tab'), false);
    } else {
        switchTab('calc', false);   // 預設頁籤
    }

    if (urlParams.has('item')) {
        document.getElementById('targetItemInput').value = urlParams.get('item');
        if (urlParams.has('rate')) document.getElementById('targetRate').value = urlParams.get('rate');
        if (urlParams.has('fuel')) document.getElementById('fuelSelect').value = urlParams.get('fuel');
        if (urlParams.has('fert')) document.getElementById('fertSelect').value = urlParams.get('fert');
        calculate(); 
    }
    isHandlingPopstate = false;
});

window.onload = init;

/* ==========================================================================
   SECTION: Chinese-mode migration
   The site used to default to Chinese, which stored translated item names in
   settings, planner plans and cauldron data. Convert them back to English.
   ========================================================================== */

let _zhToEnMap = null;
function _getZhToEnMap() {
    if (_zhToEnMap) return _zhToEnMap;
    _zhToEnMap = new Map();
    const items = window.ALCHEMY_I18N?.items || {};
    for (const en in items) {
        const zh = items[en];
        if (typeof zh === 'string' && zh && zh !== en) _zhToEnMap.set(zh, en);
    }
    return _zhToEnMap;
}

/** English item name for a possibly-Chinese name (unchanged if not a known Chinese name). */
function englishItemName(name) {
    return _getZhToEnMap().get(name) ?? name;
}

/** Recursively replace string values and object keys that exactly match a Chinese item name. */
function _convertZhNames(value, map, stats) {
    if (typeof value === 'string') {
        const en = map.get(value);
        if (en !== undefined) { stats.n++; return en; }
        return value;
    }
    if (Array.isArray(value)) return value.map(v => _convertZhNames(v, map, stats));
    if (value && typeof value === 'object') {
        const out = {};
        for (const k in value) {
            const en = map.get(k);
            if (en !== undefined) stats.n++;
            out[en ?? k] = _convertZhNames(value[k], map, stats);
        }
        return out;
    }
    return value;
}

function migrateChineseSavedData() {
    const map = _getZhToEnMap();
    if (!map.size) return;
    const keys = [SETTINGS_KEY, 'alchemy_planner_library_v1', 'alchemy_planner_settings_v1', 'alchemy_cauldron_v1'];
    for (const key of keys) {
        try {
            const raw = localStorage.getItem(key);
            if (!raw || !/[㐀-鿿]/.test(raw)) continue; // nothing Chinese in it
            const stats = { n: 0 };
            const converted = _convertZhNames(JSON.parse(raw), map, stats);
            if (stats.n > 0) {
                localStorage.setItem(key, JSON.stringify(converted));
                console.log(`Converted ${stats.n} Chinese item names to English in ${key}`);
            }
        } catch (e) {
            console.error('Chinese-name migration failed for ' + key, e);
        }
    }
}
