/* ==========================================================================
   ALCHEMY CALCULATOR CORE ENGINE
   Handles recursion, math, and tree node generation.
   ========================================================================== */

/* --- Pipeline Overview ---

   runCalculation({db, params, state})
            │
            ▼
    solveEquilibrium()
        │
        │  Iteratively computes a stable joint equilibrium of:
        │    - byproduct pool (available for recycling)
        │    - internal fuel-module production rate (if selfFuel)
        │    - internal fert-module production rate (if selfFert)
        │  using ghost (dry-run) tree construction that includes the
        │  fuel/fert module trees on every iteration (not just target trees).
        ▼
    buildProductionModel()
        │
        ├── recursively builds one production tree per target
        ├── recursively builds the internal fuel/fert module trees
        │   (using the rates supplied via internalFuelRate/internalFertRate)
        ├── collects global aggregates
        └── returns the final calculation model
        ▼
    buildResultSections()
        │
        ▼
    tree/UI

   This engine builds a "calculation tree" per target item, and fuel/fert internal modules.
   Each tree node represents one recipe step and is produced inside buildNode() within buildProductionModel().
   The model returned by runCalculation() is consumed by the calculation UI;
   changes to its shape should therefore be treated as an API change.
*/

(function (global) {
    const YIELD_MULTIPLIER_MACHINES = ["Extractor", "Thermal Extractor", "Alembic", "Advanced Alembic"];
    const CATALYST_CHARGES_MAP = { 180: 'unstable', 240: 'fertile', 1500: 'resonant', 99999: 'eternal' };

    function getCatalystTypeByCharges(charges) {
        return CATALYST_CHARGES_MAP[charges] || null;
    }

    function getBeltSpeed(lvl) {
        let speed = 60;
        if (lvl > 0) speed += Math.min(lvl, 12) * 15;
        if (lvl > 12) speed += (lvl - 12) * 3;
        return speed;
    }

    function getSpeedMult(lvl) {
        let mult = 1.0;
        mult += Math.min(lvl, 12) * 0.25;
        if (lvl > 12) mult += (lvl - 12) * 0.05;
        return mult;
    }

    function getAlchemyMult(lvl) {
        if (lvl <= 0) return 1.0;
        let percent = 0;
        for (let i = 1; i <= lvl; i++) {
            if (i <= 2) percent += 6;
            else if (i <= 8) percent += 8;
            else percent += 10;
        }
        return 1.0 + (percent / 100);
    }

    function getSellMult(lvl) {
        if (lvl <= 0) return 1.0;
        return 1.0 + lvl * 0.01;
    }

    function getRecipesFor(db, item) {
        if (!db.recipes) return [];
        return db.recipes.filter(recipe => recipe.outputs[item]);
    }

    function getPreferredRecipe(db, state, item) {
        const candidates = getRecipesFor(db, item);
        if (candidates.length === 0) return null;
        if (candidates.length === 1) return candidates[0];

        const prefId = state?.preferredRecipes?.[item];
        if (prefId) {
            const found = candidates.find(recipe => recipe.id === prefId);
            if (found) return found;
        }
        return candidates[0];        
    }

    function applyRecipeModifiers(db, modifiers, recipe) {
        if (!recipe) return null;

        if (recipe.machine === 'Advanced Athanor') {
            const cats = modifiers?.catalysts;
            let recipeInputs = { ...recipe.inputs };
            let recipeOutputs = { ...recipe.outputs };

            if (Array.isArray(cats)) {
                if (cats.includes('eternal')) {
                    recipeInputs = {};
                    const [itemKey] = Object.entries(DB.items).find(([, item]) => item.charges === 99999);
                    recipeInputs[itemKey] = recipe.ChargeCost / 99999;
                }
                if (cats.includes('unstable')) {
                    recipeOutputs = { ...recipe.unstableOutputs };
                    const [itemKey] = Object.entries(DB.items).find(([, item]) => item.charges === 180);
                    recipeInputs[itemKey] = recipe.ChargeCost / 180;
                }
                if (cats.includes('resonant')) {
                    recipeOutputs = { ...recipe.resonantOutputs };
                    const [itemKey] = Object.entries(DB.items).find(([, item]) => item.charges === 1500);
                    recipeInputs[itemKey] = recipe.ChargeCost / 1500;
                }
                if (cats.includes('fertile')) {
                    for (const k in recipeOutputs) recipeOutputs[k] *= 2;
                    const [itemKey] = Object.entries(DB.items).find(([, item]) => item.charges === 240);
                    recipeInputs[itemKey] = recipe.ChargeCost / 240;
                }
            }
            return { ...recipe, outputs: recipeOutputs, inputs: recipeInputs };
        }
        else if (recipe.machine === 'Paradox Crucible') {
            if (recipe.customInputSlot) {
                const inputName = modifiers?.customInput;
                if (!inputName || !db.items[inputName]) return null;
                const baseTime = computeParadoxTime(db, inputName);
                if (baseTime === null) return null;
                return { ...recipe, inputs: { [inputName]: 1 }, baseTime };
            }
        }
        return recipe;
    }

    function getActiveRecipe(db, state, item, pathKey = "") {
        let recipe = null;
        if (pathKey !== "" && state?.nodeRecipeOverrides?.[pathKey]) {
            const overrideId = state.nodeRecipeOverrides[pathKey];
            const candidates = getRecipesFor(db, item);
            recipe = candidates.find(r => r.id === overrideId) || null;
        }
        if (!recipe) {
            recipe = getPreferredRecipe(db, state, item);
        }
        if (!recipe) return null;
        return applyRecipeModifiers(db, state?.recipeModifiers?.[recipe.id], recipe);
    }

    // Look the recipe up directly by recipe.id and apply modifiers, independent of item/preferred
    function getRecipeById(db, modifiers, recipeId) {
        const recipe = (db.recipes || []).find(r => r.id === recipeId);
        if (!recipe) return null;
        return applyRecipeModifiers(db, modifiers, recipe);
    }

    function getThermalExtractorRatio(height) {
        const h = Math.max(0, Math.min(255, height ?? 255));
        return 1.0 + (h / 255) * 2.0; // 0 -> 1.0x, 255 -> 3.0x
    }

    function applyAlchemyMult(machineName, batchYield, alchemyMult) {
        if (YIELD_MULTIPLIER_MACHINES.includes(machineName)) {
            batchYield *= alchemyMult;
            if (machineName === "Thermal Extractor") {
                batchYield *= getThermalExtractorRatio(DB?.settings?.thermalExtractorHeight);
            }
        }
        return batchYield;
    }

    function computeParadoxTime(db, itemName) {
        const itemDef = db.items[itemName];
        if (!itemDef) return null;
        let { baseCost, cauldronCost, cauldronTarget, maxStack, paradoxTime } = itemDef;
        if (paradoxTime) return paradoxTime;
        if (!(baseCost > 0) || !(cauldronCost > 0) || !(cauldronTarget > 0)) return null;
        if (maxStack < 0) baseCost *= -maxStack;
        const efficiency = cauldronCost / cauldronTarget;
        const baseTime = 1500 / (baseCost * efficiency);
        return (baseTime > 0 && isFinite(baseTime)) ? baseTime : null;
    }

    function computeDecomposeTime(db, itemName) {
        const itemDef = db.items[itemName];
        if (!itemDef || !itemDef.baseCost) return null;
        return Math.pow(itemDef.baseCost, 0.518) * 0.1676;
    }
    
    function computeDecomposeExp(db, itemName) {
        const itemDef = db.items[itemName];
        if (!itemDef || !itemDef.baseCost) return null;
        return itemDef.baseCost * 0.0002;
    }

    function getCustomCost(state, item) {
        const val = state?.customCosts?.[item];
        return (typeof val === 'number' && val > 0) ? val : null;
    }

    function getHeatingDevice(db, selectedHeatingDevice) {
        const selected = (db.machines || {})[selectedHeatingDevice];
        if (selected?.isGenerator) return selected;
        const fallback = (db.machines || {})["Stone Furnace"];
        if (fallback?.isGenerator) return fallback;
        return Object.values(db.machines || {}).find(machine => machine.isGenerator) || { heatSelf: 0, slots: 3 };
    }

    function getProductionHeatCost(db, state, item, speedMult, alchemyMult, selectedHeatingDevice = "Stone Furnace") {
        let cost = 0;
        const recipe = getActiveRecipe(db, state, item);
        if (recipe && recipe.outputs[item]) {
            let batchYield = recipe.outputs[item];
            batchYield = applyAlchemyMult(recipe.machine, batchYield, alchemyMult);
            if (db.machines[recipe.machine] && db.machines[recipe.machine].heatCost) {
                const machine = db.machines[recipe.machine];
                const heatingDevice = getHeatingDevice(db, selectedHeatingDevice);
                const slotsRequired = machine.slotsRequired || 1;
                const heatingSlots = heatingDevice.slots || 3;
                const heatPerSec = (machine.heatCost * speedMult) + ((heatingDevice.heatSelf || 0) / (heatingSlots / slotsRequired));
                cost += heatPerSec * ((recipe.baseTime / speedMult) / batchYield);
            }

            Object.keys(recipe.inputs).forEach(inputName => {
                cost += getProductionHeatCost(db, state, inputName, speedMult, alchemyMult, selectedHeatingDevice) * (recipe.inputs[inputName] / batchYield);
            });
        }
        return cost;
    }

    function getProductionFertCost(db, state, item, fertVal, fertSpeed, speedMult, alchemyMult) {
        let cost = 0;
        const itemDef = db.items[item] || {};
        if (itemDef.category === "Herbs" && itemDef.nutrientCost) cost += itemDef.nutrientCost;
        const recipe = getActiveRecipe(db, state, item);
        if (recipe && recipe.outputs[item]) {
            let batchYield = recipe.outputs[item];
            batchYield = applyAlchemyMult(recipe.machine, batchYield, alchemyMult);
            Object.keys(recipe.inputs).forEach(inputName => {
                cost += getProductionFertCost(db, state, inputName, fertVal, fertSpeed, speedMult, alchemyMult) * (recipe.inputs[inputName] / batchYield);
            });
        }
        return cost;
    }

    function cloneRecord(record) {
        return { ...record };
    }

    /*
        maintains machine statistics, shared-node totals, byproduct producers, and external/raw/fuel/fert sources.
    */
    function createAggregates() {
        return {
            fuelDemandItems: 0,
            fertDemandItems: 0,
            heatLoad: 0,
            bioLoad: 0,
            goldPerMin: 0,
            forcedItems: {},
            rawItems: {},
            extraBuildCosts: {},
            machineStats: {},
            furnaceSlotDemand: {},
            commonNodesMap: {},
            byproductProducersMap: {},
            rawMaterialSourceMap: [],
            fuelSourceMap: [],
            fertSourceMap: [],
            externalSourceMap: {},
            totalByproducts: {}
        };
    }

    function ensureRecord(map, key, factory) {
        if (!map[key]) map[key] = factory();
        return map[key];
    }

    function addMachineCount(aggregates, machineName, outputItem, countMax, countRaw) {
        const machineEntry = ensureRecord(aggregates.machineStats, machineName, () => ({}));
        const outputEntry = ensureRecord(machineEntry, outputItem, () => ({ rawFloat: 0, nodeSumInt: 0 }));
        outputEntry.rawFloat += countRaw;
        outputEntry.nodeSumInt += countMax;
    }

    function pushExternalSource(aggregates, item, source) {
        const sources = ensureRecord(aggregates.externalSourceMap, item, () => []);
        sources.push(source);
    }

    function getRecipeTiming(db, params, recipe) {
        let recipeTime = recipe.baseTime || 1;
        const nutrientCost = recipe.nutrientCost || 0;
        if (nutrientCost > 0 && recipe.machine === "Nursery") {
            const fertilitySpeed = db.items[params.selectedFert]?.maxFertility || 1;
            recipeTime = nutrientCost / fertilitySpeed;
        }
        return recipeTime;
    }

    function getRecipeInfo(db, params, recipe, item) {
        const itemDef = db.items[item] || {};
        let batchYield = recipe.outputs[item] || 1;
        batchYield = applyAlchemyMult(recipe.machine, batchYield, params.alchemyMult);

        const recipeTime = getRecipeTiming(db, params, recipe);
        const machineOutputRate = (60 / (recipeTime || 1)) * (recipe.machine !== 'Seed Plot' ? params.speedMult : 1);
        let effectiveBatchesPerMin = machineOutputRate;

        if (!itemDef.liquid) {
            const maxItemsPerMinPerMachine = machineOutputRate * batchYield;
            let effectiveBeltSpeed = params.beltSpeed;
            if (itemDef.category === "Currency") effectiveBeltSpeed *= 50;
            else if (recipe.sharedOutputs) effectiveBeltSpeed /= recipe.sharedOutputs;
            if (maxItemsPerMinPerMachine > effectiveBeltSpeed) {
                effectiveBatchesPerMin = effectiveBeltSpeed / batchYield;
            }
        }

        return {
            batchYield,
            recipeTime,
            machineOutputRate,
            effectiveBatchesPerMin
        };
    }

    function buildTooltipData(recipe, recipeTime, speedMult, throughput) {
        return {
            inputs: Object.entries(recipe.inputs || {}).map(([item, qty]) => ({ item, qty })),
            outputs: Object.entries(recipe.outputs || {}).map(([item, qty]) => ({ item, qty })),
            baseTime: recipeTime,
            speedMult,
            throughput
        };
    }

    /**
     * Builds the production model for the requested targets.
     *
     * @param {boolean} [options.isGhost=false]
     *   When true, builds a dry-run model for equilibrium estimation without
     *   committing final UI-facing node data.
     *
     * @returns {Object}
     *   Production model containing the calculated target trees, internal
     *   fuel/fert trees, and aggregated machine/resource statistics.
     */
    function buildProductionModel(options) {
        const {
            db, params, state, isGhost,
            initialAvailableByproducts, initialTotalByproducts,
            internalFuelRate = 0, internalFertRate = 0
        } = options;
        const aggregates = createAggregates();
        const availableByproducts = cloneRecord(initialAvailableByproducts || {});
        if (initialTotalByproducts) aggregates.totalByproducts = initialTotalByproducts;

        const fuelDef = db.items[params.selectedFuel] || {};
        const grossFuelEnergy = (fuelDef.heat || 1) * (params.fuelMult || 1.0);
        const heatingDevice = getHeatingDevice(db, params.selectedHeatingDevice);
        const fertDef = db.items[params.selectedFert] || { nutrientValue: 144, maxFertility: 12 };
        const grossFertVal = (fertDef.nutrientValue || 144) * (params.fertMult || 1.0);

        /* ==========================================================================
            Node invariants
            ---------------
            - requestedRate is the rate demanded by the parent.
            - deductionRate is the portion supplied by recycling.
            - netRate = requestedRate - deductionRate.
            - recipe is the active recipe after modifiers, not the raw DB recipe.
            - isExternal / isRaw are not interchangeable with tags.detailsType.

            detailsType is used for final-pass UI output, while isExternal/isRaw are
            also consumed by planner import.
        ========================================================================== */
        function buildNode(item, rate, ancestors = [], forceGhost = false, depth = 0, shouldExpand = true) {
            const effectiveGhost = isGhost || forceGhost;
            const pathKey = `${ancestors.join(">")}>${item}`;
            const currentPath = [...ancestors, item];
            const itemDef = db.items[item] || {};
            const recycleAvailable = availableByproducts[item] || 0;
            let deduction = 0;
            let canRecycle = false;
            const isExternalInput = (state?.forcedExternals instanceof Set)
                ? state.forcedExternals.has(pathKey)
                : (typeof state?.forcedExternals?.has === 'function'
                    ? state.forcedExternals.has(pathKey)
                    : !!state?.forcedExternals?.[pathKey]);

            if (recycleAvailable > 0.001) {
                canRecycle = true;
                const isRecycleActive = (state?.activeRecyclers instanceof Set)
                    ? state.activeRecyclers.has(pathKey)
                    : (typeof state?.activeRecyclers?.has === 'function'
                        ? state.activeRecyclers.has(pathKey)
                        : !!state?.activeRecyclers?.[pathKey]);
                if (isRecycleActive) {
                    deduction = Math.min(rate, recycleAvailable);
                    availableByproducts[item] -= deduction;
                }
            }

            const netRate = Math.max(0, rate - deduction);
            const node = {
                item,
                pathKey,
                ancestors,
                depth,
                requestedRate: rate,
                deductionRate: deduction,
                netRate,
                machine: null,
                machineCount: 0,
                recipe: null,
                recipeInfo: null,
                recipeTooltipData: null,
                yieldMultiplier: null,
                maxOutput: null,
                children: [],
                tags: {
                    detailsType: null,
                    costEntries: [],
                    byproducts: [],
                    heat: null,
                    bio: null,
                    output: null,
                    beltRatio: null
                },
                canRecycle,
                recycleAvailable,
                recycleActive: (state?.activeRecyclers instanceof Set)
                    ? state.activeRecyclers.has(pathKey)
                    : (typeof state?.activeRecyclers?.has === 'function'
                        ? state.activeRecyclers.has(pathKey)
                        : !!state?.activeRecyclers?.[pathKey]),
                isExternal: !!isExternalInput,
                isRaw: false
            };

            if (!effectiveGhost) {
                node.tags.catalystType = getCatalystTypeByCharges(itemDef.charges);
            }

            const recipe = getActiveRecipe(db, state, item, pathKey);

            if (recipe) {
                const hasSameRecipeAncestor = ancestors.some((ancestorItem, idx) => {
                    if (ancestorItem !== item) return false;
                    const ancestorPathKey = `${ancestors.slice(0, idx).join(">")}>${ancestorItem}`;
                    const ancestorRecipe = getActiveRecipe(db, state, ancestorItem, ancestorPathKey);
                    return ancestorRecipe === recipe;
                });
                if (hasSameRecipeAncestor) {
                    shouldExpand = false;
                    //console.info("Loop detected: " + pathKey);
                }
            }

            if (isExternalInput || depth >= 40 || !shouldExpand) {
                if (!effectiveGhost && netRate > 0) {
                    aggregates.forcedItems[item] = (aggregates.forcedItems[item] || 0) + netRate;
                    pushExternalSource(aggregates, item, { rate: netRate, pathKey });
                    node.tags.detailsType = "external";

                    const customCost = getCustomCost(state, item);
                    if (customCost !== null) {
                        const costPerMin = netRate * customCost;
                        aggregates.goldPerMin += costPerMin;
                        aggregates.rawMaterialSourceMap.push({ item, gold: costPerMin, pathKey });
                        node.tags.costEntries.push({ type: "gold", amount: costPerMin, custom: true });
                    }
                }
                return effectiveGhost ? null : node;
            }
            
            if (!recipe) {
                if (!effectiveGhost) {
                    const customCost = getCustomCost(state, item);
                    const effectivePrice = customCost !== null ? customCost : itemDef.buyPrice;
                    if (effectivePrice) {
                        const costPerMin = netRate * effectivePrice;
                        aggregates.rawItems[item] = (aggregates.rawItems[item] || 0) + netRate;
                        aggregates.goldPerMin += costPerMin;
                        aggregates.rawMaterialSourceMap.push({ item, gold: costPerMin, pathKey });
                        node.tags.detailsType = "raw";
                        node.tags.costEntries.push({ type: "gold", amount: costPerMin, custom: customCost !== null });
                        node.isRaw = true;
                    } else {
                        aggregates.forcedItems[item] = (aggregates.forcedItems[item] || 0) + netRate;
                        pushExternalSource(aggregates, item, { rate: netRate, pathKey });
                        node.tags.detailsType = "external";
                        node.isExternal = true;
                    }
                }
                return effectiveGhost ? null : node;
            }

            node.recipe = recipe;
            node.machine = recipe.machine;

            if (!effectiveGhost) {
                if (recipe.machine === "Bank Portal") {
                    if (Object.keys(recipe.inputs || {}).length === 0) { // Not a conversion recipe
                        const costPerMin = netRate * (itemDef.sellPrice || 0);
                        aggregates.rawItems[item] = (aggregates.rawItems[item] || 0) + netRate;
                        aggregates.goldPerMin += costPerMin;
                        aggregates.rawMaterialSourceMap.push({ item, gold: costPerMin, pathKey });
                        node.tags.detailsType = "raw";
                        node.tags.costEntries.push({ type: "gold", amount: costPerMin });
                    }
                }
                else if (recipe.machine === "Purchasing Portal") {
                    const customCost = getCustomCost(state, item);
                    const effectivePrice = customCost !== null ? customCost : itemDef.buyPrice;
                    if (effectivePrice) {
                        const costPerMin = netRate * effectivePrice;
                        aggregates.rawItems[item] = (aggregates.rawItems[item] || 0) + netRate;
                        aggregates.goldPerMin += costPerMin;
                        aggregates.rawMaterialSourceMap.push({ item, gold: costPerMin, pathKey });
                        node.tags.detailsType = "raw";
                        node.tags.costEntries.push({ type: "gold", amount: costPerMin, custom: customCost !== null });
                        node.isRaw = true; // Not expanded when sent to the planner
                    }
                }
            }

            const recipeInfo = getRecipeInfo(db, params, recipe, item);
            const batchesPerMin = recipeInfo.batchYield > 0 ? netRate / recipeInfo.batchYield : 0;
            let machinesNeeded = recipeInfo.effectiveBatchesPerMin > 0 ? batchesPerMin / recipeInfo.effectiveBatchesPerMin : 0;
            if (Math.abs(Math.round(machinesNeeded) - machinesNeeded) < 0.0001) {
                machinesNeeded = Math.round(machinesNeeded);
            }

            node.machineCount = machinesNeeded;
            node.recipeInfo = recipeInfo;
            node.recipeTooltipData = buildTooltipData(recipe, recipeInfo.recipeTime, params.speedMult, recipeInfo.effectiveBatchesPerMin * recipeInfo.batchYield);

            if (YIELD_MULTIPLIER_MACHINES.includes(recipe.machine)) {
                const yieldMultiplier = recipe.machine === "Thermal Extractor" ? params.alchemyMult * getThermalExtractorRatio(DB?.settings?.thermalExtractorHeight) : params.alchemyMult;
                node.yieldMultiplier = yieldMultiplier;
                if (!effectiveGhost) node.tags.output = { multiplier: yieldMultiplier };
            }

            Object.keys(recipe.outputs).forEach(outputItem => {
                if (outputItem === item) return;
                const yieldPerBatch = recipe.outputs[outputItem];
                const totalByproduct = batchesPerMin * yieldPerBatch;
                aggregates.totalByproducts[outputItem] = (aggregates.totalByproducts[outputItem] || 0) + totalByproduct;

                if (!effectiveGhost) {
                    node.tags.byproducts.push({ item: outputItem, rate: totalByproduct });
                    const producers = ensureRecord(aggregates.byproductProducersMap, outputItem, () => []);
                    producers.push({
                        rate: totalByproduct,
                        recipe,
                        machineCount: machinesNeeded,
                        pathKey,
                        tooltipData: node.recipeTooltipData
                    });
                }
            });

            if (!effectiveGhost && deduction > 0.0001) {
                const producers = ensureRecord(aggregates.byproductProducersMap, item, () => []);
                producers.push({
                    rate: -deduction,
                    recipe,
                    machineCount: machinesNeeded,
                    pathKey,
                    tooltipData: node.recipeTooltipData
                });
            }

            if (!effectiveGhost) {
                addMachineCount(aggregates, recipe.machine, item, Math.ceil(machinesNeeded - 0.0001), machinesNeeded);
                if (recipe.buildCost) {
                    aggregates.extraBuildCosts[recipe.buildCost] = (aggregates.extraBuildCosts[recipe.buildCost] || 0) + Math.ceil(machinesNeeded - 0.0001);
                }
            }

            let fuelRate = 0;
            if (db.machines[recipe.machine] && db.machines[recipe.machine].heatCost) {
                const machine = db.machines[recipe.machine];
                const slotsRequired = machine.slotsRequired || 1;
                const heatingSlots = heatingDevice.slots || 3;
                let activeHeat = machine.heatCost * params.speedMult;
                if (machine.heatCost < 0) activeHeat = (recipe.heatCost ?? 0) * params.speedMult;

                const heatingDevicesNeeded = Math.ceil((machinesNeeded / (heatingSlots / slotsRequired)) - 0.0001);
                const totalHeatPerSec = (heatingDevicesNeeded * (heatingDevice.heatSelf || 0) * params.speedMult) + (machinesNeeded * activeHeat);

                aggregates.heatLoad += totalHeatPerSec;
                aggregates.fuelDemandItems += (totalHeatPerSec * 60) / grossFuelEnergy;

                if (!effectiveGhost) {
                    aggregates.furnaceSlotDemand[params.selectedHeatingDevice] =
                     (aggregates.furnaceSlotDemand[params.selectedHeatingDevice] || 0) + (Math.ceil(machinesNeeded - 0.0001) * slotsRequired);
                    fuelRate = (totalHeatPerSec * 60) / grossFuelEnergy;
                    node.tags.heat = {
                        item: params.selectedFuel,
                        rate: fuelRate,
                        heatPerSec: totalHeatPerSec,
                        costPerMin: params.showFuelCost && params.fuelCost > Number.EPSILON ? Math.ceil(fuelRate * params.fuelCost - Number.EPSILON) : 0
                    };
                    if (node.tags.heat.costPerMin > 0) {
                        node.tags.costEntries.push({ type: "fuel", amount: node.tags.heat.costPerMin });
                    }
                }
            }

            let fertRate = 0;
            if (recipe.nutrientCost) {
                const totalNutrientsNeeded =
                    netRate * (recipe.nutrientCost || 0) / recipeInfo.batchYield;
                const itemsNeeded = totalNutrientsNeeded / grossFertVal;
                aggregates.bioLoad += totalNutrientsNeeded / 60;
                aggregates.fertDemandItems += itemsNeeded;                
                
                if (!effectiveGhost) {
                    fertRate = itemsNeeded;
                    node.tags.bio = {
                        item: params.selectedFert,
                        rate: itemsNeeded,
                        nutrientPerSec: totalNutrientsNeeded / 60,
                        costPerMin:
                            params.showFertCost && params.fertCost > Number.EPSILON
                                ? Math.ceil(itemsNeeded * params.fertCost - Number.EPSILON)
                                : 0
                    };

                    if (node.tags.bio.costPerMin > 0) {
                        node.tags.costEntries.push({
                            type: "fert",
                            amount: node.tags.bio.costPerMin
                        });

                        aggregates.goldPerMin += node.tags.bio.costPerMin;
                    }
                }
            }

            if (!effectiveGhost) {
                const commonKey = `${item}_${recipe.machine}`;
                const commonEntry = ensureRecord(aggregates.commonNodesMap, commonKey, () => ({
                    item,
                    machine: recipe.machine,
                    totalRate: 0,
                    totalMachines: 0,
                    tooltipData: node.recipeTooltipData,
                    totalFuelRate: 0,
                    totalFertRate: 0,
                    instances: []
                }));
                commonEntry.totalRate += netRate;
                commonEntry.totalMachines += machinesNeeded;
                commonEntry.totalFuelRate += fuelRate;
                commonEntry.totalFertRate += fertRate;
                commonEntry.instances.push({
                    rate: netRate,
                    machines: machinesNeeded,
                    pathKey
                });

                if (fuelRate > 0.0001) {
                    aggregates.fuelSourceMap.push({ rate: fuelRate, item, machine: recipe.machine, count: machinesNeeded, pathKey });
                }
                if (fertRate > 0.0001) {
                    aggregates.fertSourceMap.push({ rate: fertRate, item, machine: recipe.machine, count: machinesNeeded, pathKey });
                }

                if (params.showMaxCap) {
                    const maxOutput = Math.ceil(machinesNeeded) * node.recipeTooltipData.throughput;
                    node.maxOutput = maxOutput;
                }

                if (params.showBeltCount && itemDef && itemDef.category !== "Liquid") {
                    node.tags.beltRatio = itemDef.category === "Currency" ? rate / (50 * params.beltSpeed) : rate / params.beltSpeed;
                }
            }

            if (netRate > 0.0001) {
                const netBatches = netRate / recipeInfo.batchYield;
                Object.keys(recipe.inputs).forEach(inputName => {
                    const qtyPerBatch = recipe.inputs[inputName];
                    const requiredInputRate = netBatches * qtyPerBatch;
                    // Catalysts for advanced machines: whether to expand the subtree is set per catalyst by state.expandCatalystInputs
                    let shouldExpandChild = true;
                    if (recipe.machine === 'Advanced Athanor') {
                        const catalystType = getCatalystTypeByCharges(db.items[inputName]?.charges);
                        if (catalystType) {
                            shouldExpandChild = !!(state.expandCatalystInputs && state.expandCatalystInputs[catalystType]);
                        }
                    }
                    const childNode = buildNode(inputName, requiredInputRate, currentPath, effectiveGhost, depth + 1, shouldExpandChild);
                    if (!effectiveGhost && childNode) node.children.push(childNode);
                });
            }

            return effectiveGhost ? null : node;
        }

        const treeRoots = [];
        params.targets.forEach(target => {
            if (!db.items[target.item]) return;
            const rootNode = buildNode(target.item, target.rate, [], false, 0);
            if (!isGhost && rootNode) {
                treeRoots.push({ target, root: rootNode });
            }
        });

        // Internal fuel/fert module trees use the same aggregates as target trees
        // on every pass, including ghost passes, so their resource footprint is
        // included in the equilibrium calculation.

        if (params.selectedFuel === params.selectedFert) {            
            const totalRate = internalFuelRate + internalFertRate;
            if (totalRate > 0) {
                const totalItem = params.selectedFuel;
                const totalRoot = buildNode(totalItem, totalRate, [], isGhost, 0);
                if (!isGhost && totalRoot) {
                    const target = { item: totalItem, rate: totalRate };
                    treeRoots.push({ target, root: totalRoot });
                }
            }
        }
        else {
            if (internalFuelRate > 0) {
                const fuelRoot = buildNode(params.selectedFuel, internalFuelRate, [], isGhost, 0);
                if (!isGhost && fuelRoot) {
                    const target = { item: params.selectedFuel, rate: internalFuelRate };
                    treeRoots.push({ target, root: fuelRoot });
                }
            }
            if (internalFertRate > 0) {
                const fertRoot = buildNode(params.selectedFert, internalFertRate, [], isGhost, 0);
                if (!isGhost && fertRoot) {
                    const target = { item: params.selectedFert, rate: internalFertRate };
                    treeRoots.push({ target, root: fertRoot });
                }
            }
        }

        return {
            treeRoots,
            availableByproducts,
            aggregates
        };
    }


    // Fit the linear map newFuel/newFert = A * [fuelGuess, fertGuess] + b from 3 sampled ghost passes,
    // then solve the fixed point (I - A)x = b for an initial guess; no solution or an unreasonable one counts as divergent
    function estimateFuelFertLinearGuess(db, params, state, shouldFuel, shouldFert) {
        if (!shouldFuel && !shouldFert) return { fuelGuess: 0, fertGuess: 0, divergent: false };

        // First run once with fuelGuess = fertGuess = 0 to get the byproduct pool of the tree itself (internal modules are 0 here),
        // and use it as the fixed recycle pool for the three samples (first-order: ignores how the pool changes with fuel/fert)
        const basePool = {};
        buildProductionModel({
            db, params, state, isGhost: true,
            initialAvailableByproducts: {},
            initialTotalByproducts: basePool,
            internalFuelRate: 0,
            internalFertRate: 0
        });

        function sample(fuelRate, fertRate) {
            const totalByproducts = {};
            const model = buildProductionModel({
                db, params, state, isGhost: true,
                initialAvailableByproducts: cloneRecord(basePool),
                initialTotalByproducts: totalByproducts,
                internalFuelRate: fuelRate,
                internalFertRate: fertRate
            });
            return {
                fuel: shouldFuel ? model.aggregates.fuelDemandItems : 0,
                fert: shouldFert ? model.aggregates.fertDemandItems : 0
            };
        }

        const base = sample(0, 0);
        const b1 = base.fuel, b2 = base.fert;

        let a11 = 0, a21 = 0, a12 = 0, a22 = 0;
        if (shouldFuel) {
            const s1 = sample(1, 0);
            a11 = s1.fuel - b1;
            a21 = s1.fert - b2;
        }
        if (shouldFert) {
            const s2 = sample(0, 1);
            a12 = s2.fuel - b1;
            a22 = s2.fert - b2;
        }

        const det = (1 - a11) * (1 - a22) - a12 * a21;

        if (Math.abs(det) < 1e-9) {
            // (I - A) is singular: there is no unique fixed point (self-consuming amplifying loop)
            return { fuelGuess: 0, fertGuess: 0, divergent: true };
        }

        const fuelGuess = ((1 - a22) * b1 + a12 * b2) / det;
        const fertGuess = (a21 * b1 + (1 - a11) * b2) / det;

        if (!isFinite(fuelGuess) || !isFinite(fertGuess) || fuelGuess < -1e-6 || fertGuess < -1e-6) {
            // A negative or infinite solution is not physical, so it also counts as unbalanceable
            return { fuelGuess: 0, fertGuess: 0, divergent: true };
        }

        return { fuelGuess: Math.max(0, fuelGuess), fertGuess: Math.max(0, fertGuess), divergent: false };
    }

    /**
     * Jointly solves for a stable equilibrium of:
     *   - the byproduct recycling pool (availableByproducts / totalByproducts)
     *   - the internal fuel-module production rate (if self-fuel is enabled
     *     and fuel is not already one of the user's targets)
     *   - the internal fert-module production rate (if self-fert is enabled
     *     and fert is not already one of the user's targets)
     * All three quantities are updated together each iteration.
     *
     * Returns { stableByproducts, stableFuelRate, stableFertRate, equilibriumWarning }.
     */
    function solveEquilibrium(db, params, state) {
        let shouldFuel = params.selfFuel && !params.targets.some(target => target.item === params.selectedFuel);
        let shouldFert = params.selfFert && !params.targets.some(target => target.item === params.selectedFert);
        
        let byproductGuess = {};
        let fuelGuess = 0;
        let fertGuess = 0;        
        let fuelWindow = [];
        let fertWindow = [];
        let equilibriumWarning = null; // null | 'LowFuel' | 'LowFert' | 'Divergence'

        // Seed the solver with a ghost pass, then use the linear estimate as the
        // initial fuel/fert guess when self-production is enabled.
        for(;;)
        {
            const totalByproducts = {};
            let model = buildProductionModel({
                db, params, state, isGhost: true,
                initialAvailableByproducts: byproductGuess,
                initialTotalByproducts: totalByproducts,
                internalFuelRate: fuelGuess,
                internalFertRate: fertGuess
            });
            byproductGuess = cloneRecord(totalByproducts);

           // Reject an invalid fixed-point estimate early and otherwise use it as the initial guess.
            if (shouldFuel || shouldFert) {
                const linearEstimate = estimateFuelFertLinearGuess(db, params, state, shouldFuel, shouldFert);
                if (linearEstimate.divergent) {
                    console.warn("Solve Equilibrium Diverged (linear pre-check): internal fuel/fert module demand exceeds its own supply.");
                    params.selfFert = false;
                    shouldFert = false;
                    fertGuess = 0;
                    params.selfFuel = false;
                    shouldFuel = false;
                    fuelGuess = 0;
                    equilibriumWarning = 'LowSupply';
                    continue;
                }
                // Start iterating from the linear solution instead of 0 to cut the warm-up/main loop rounds
                fuelGuess = linearEstimate.fuelGuess;
                fertGuess = linearEstimate.fertGuess;
            }
            break;
        }

        const maxTimes = 60;
        for (let i = 0; i <= maxTimes; i++) {
            const availableByproducts = cloneRecord(byproductGuess);
            const totalByproducts = {};

            const model = buildProductionModel({
                db, params, state, isGhost: true,
                initialAvailableByproducts: availableByproducts,
                initialTotalByproducts: totalByproducts,
                internalFuelRate: fuelGuess,
                internalFertRate: fertGuess
            });

            const newFuel = shouldFuel ? model.aggregates.fuelDemandItems : 0;
            const newFert = shouldFert ? model.aggregates.fertDemandItems : 0;

            let maxDiff = 0;
            const allKeys = [...new Set([...Object.keys(byproductGuess), ...Object.keys(totalByproducts)])];
            allKeys.forEach(key => {
                const valA = byproductGuess[key] || 0;
                const valB = totalByproducts[key] || 0;
                if (Math.abs(valA - valB) > maxDiff && valA > 0.001) maxDiff = Math.abs(valA - valB) / valA;
            });
            //console.log(`[${i}] fuel:${fuelGuess} fert:${fertGuess} byproduct%:${maxDiff}`);
            if (fuelGuess > 0) maxDiff = Math.max(maxDiff, Math.abs(fuelGuess - newFuel) / fuelGuess / 10);
            if (fertGuess > 0) maxDiff = Math.max(maxDiff, Math.abs(fertGuess - newFert) / fertGuess / 10);

            if (maxDiff < 0.00001) {
                if (i > 0) console.log("Solve Equilibrium Completed. Oscillation Times = " + i);
                byproductGuess = cloneRecord(totalByproducts);
                fuelGuess = newFuel;
                fertGuess = newFert;
                break;
            }
            else if (i >= maxTimes) {
                console.log(`Solve Equilibrium Unfinished. Oscillation Times > ${maxTimes}. Max Diff = ${maxDiff.toFixed(6)}`);
                byproductGuess = cloneRecord(totalByproducts);
                fuelGuess = newFuel;
                fertGuess = newFert;
                // Only warn when the error is large (>1%)
                if(maxDiff > 0.01) equilibriumWarning = 'Divergence';
                break;
            }

            const dampingRatio = i < 40 ? (i < 20 ? (i < 10 ? 0.5 : 0.25) : 0.125) : 0.0625;

            allKeys.forEach(key => {
                const valA = byproductGuess[key] || 0;
                const valB = totalByproducts[key] || 0;
                byproductGuess[key] = valA + ((valB - valA) * dampingRatio * 1.75);
                //console.log(`[${i}] ${key}: ${valA} -> ${valB} => ${byproductGuess[key]}`);
            });

            if (shouldFuel || shouldFert) {
                if (i <= 20) {
                    // --- Aitken's delta-squared extrapolation ---
                    // Try to extrapolate once every 3 history values; on success jump to the estimated limit and reset the window,
                    // instead of every round, which would be numerically unstable
                    fuelGuess = newFuel;
                    fertGuess = newFert;
                    if (shouldFuel) {
                        fuelWindow.push(fuelGuess);
                        if (fuelWindow.length > 3) fuelWindow.shift();
                        if (fuelWindow.length === 3) {
                            const extrapolated = aitkenExtrapolate(fuelWindow);
                            if (extrapolated !== null) {
                                fuelGuess = extrapolated;
                                fuelWindow = [fuelGuess];
                            }
                        }
                    }
                    if (shouldFert) {
                        fertWindow.push(fertGuess);
                        if (fertWindow.length > 3) fertWindow.shift();
                        if (fertWindow.length === 3) {
                            const extrapolated = aitkenExtrapolate(fertWindow);
                            if (extrapolated !== null) {
                                fertGuess = extrapolated;
                                fertWindow = [fertGuess];
                            }
                        }
                    }
                }
                else {
                    // Internal fuel/fert rates use a stronger update to converge faster.
                    fuelGuess = newFuel + (newFuel - fuelGuess) * dampingRatio * 1.45;
                    fertGuess = newFert + (newFert - fertGuess) * dampingRatio * 1.45;
                }
            }
        }

        return {
            stableByproducts: byproductGuess,
            stableFuelRate: fuelGuess,
            stableFertRate: fertGuess,
            equilibriumWarning
        };
    }

    // Aitken's delta-squared: estimate the limit of a linearly converging sequence from its last 3 values
    function aitkenExtrapolate(window) {
        if (window.length < 3) return null;
        const [x0, x1, x2] = window;
        const denom = x2 - 2 * x1 + x0;
        if (Math.abs(denom) < 1e-9) return null; // Denominator near 0: already converged or unstable, skip extrapolation
        const extrapolated = x0 - ((x1 - x0) * (x1 - x0)) / denom;
        if (!isFinite(extrapolated) || extrapolated < 0) return null; // Unreasonable extrapolation, skip it
        return extrapolated;
    }

    function aggregateMachineStats(machineStats, db) {
        const flatMax = {};
        const flatMin = {};

        Object.entries(machineStats).forEach(([machineName, outputs]) => {
            let totalIntMax = 0;
            let totalCeiledMin = 0;
            Object.values(outputs).forEach(data => {
                totalIntMax += data.nodeSumInt;
                totalCeiledMin += Math.ceil(data.rawFloat - 0.0001);
            });
            flatMax[machineName] = totalIntMax;
            flatMin[machineName] = totalCeiledMin;
        });

        const totalFurnaces = Object.entries(machineStats).reduce((sum, [machineName]) => {
            if (!db.machines[machineName]?.isGenerator) return sum;
            return sum;
        }, 0);

        return { flatMax, flatMin, totalFurnaces };
    }

    function calculateTotalFurnaces(furnaceSlotDemand, db, selectedHeatingDevice) {
        const heatingDevice = getHeatingDevice(db, selectedHeatingDevice);
        const slots = heatingDevice.slots || 3;
        const totalSlots = Object.values(furnaceSlotDemand).reduce((sum, qty) => sum + qty, 0);
        return Math.ceil((totalSlots - 0.0001) / slots);
    }

    function buildResultSections(db, params, model) {
        const { aggregates, availableByproducts } = model;
        const commonNodes = Object.values(aggregates.commonNodesMap).filter(entry => entry.instances.length > 1);

        const externalForced = Object.entries(aggregates.externalSourceMap).map(([itemName, sources]) => ({
            item: itemName,
            totalRate: sources.reduce((sum, source) => sum + source.rate, 0),
            sources
        }));

        const byproducts = Object.keys(aggregates.totalByproducts).sort().map(itemName => ({
            item: itemName,
            remaining: availableByproducts[itemName] || 0,
            totalGenerated: aggregates.totalByproducts[itemName],
            producers: aggregates.byproductProducersMap[itemName] || []
        }));

        const machineCounts = aggregateMachineStats(aggregates.machineStats, db);

        return {
            commonNodes,
            externalInputs: {
                rawMaterialCost: {
                    totalGoldPerMin: aggregates.goldPerMin,
                    sources: aggregates.rawMaterialSourceMap
                },
                fuel: !params.selfFuel ? {
                    item: params.selectedFuel,
                    totalRate: aggregates.fuelDemandItems,
                    sources: aggregates.fuelSourceMap
                } : null,
                fert: !params.selfFert ? {
                    item: params.selectedFert,
                    totalRate: aggregates.fertDemandItems,
                    sources: aggregates.fertSourceMap
                } : null,
                forced: externalForced
            },
            byproducts,
            construction: {
                maxCounts: machineCounts.flatMax,
                minCounts: machineCounts.flatMin,
                furnaces: calculateTotalFurnaces(aggregates.furnaceSlotDemand, db, params.selectedHeatingDevice),
                extraBuildCosts: aggregates.extraBuildCosts
            }
        };
    }

    function runCalculation({ db, params, state }) {
        const eq = solveEquilibrium(db, params, state);

        const finalModel = buildProductionModel({
            db,
            params,
            state,
            isGhost: false,
            initialAvailableByproducts: cloneRecord(eq.stableByproducts),
            initialTotalByproducts: {},
            internalFuelRate: eq.stableFuelRate,
            internalFertRate: eq.stableFertRate
        });

        const sections = buildResultSections(db, params, finalModel);
        return {
            targets: params.targets,
            treeRoots: finalModel.treeRoots,            
            equilibriumWarning: eq.equilibriumWarning,
            summary: {
                heatLoad: finalModel.aggregates.heatLoad,
                bioLoad: finalModel.aggregates.bioLoad,
                goldPerMin: finalModel.aggregates.goldPerMin,
                fuelDemandItems: finalModel.aggregates.fuelDemandItems,
                fertDemandItems: finalModel.aggregates.fertDemandItems,
                rawItems: finalModel.aggregates.rawItems,
                forcedItems: finalModel.aggregates.forcedItems
            },
            externalInputs: sections.externalInputs,
            byproducts: sections.byproducts,
            commonNodes: sections.commonNodes,
            machineStats: finalModel.aggregates.machineStats,
            construction: sections.construction,
            formulaLineData: {
                rawItems: finalModel.aggregates.rawItems,
                forcedItems: finalModel.aggregates.forcedItems,
                fuelDemandItems: finalModel.aggregates.fuelDemandItems,
                fertDemandItems: finalModel.aggregates.fertDemandItems,
                availableByproducts: finalModel.availableByproducts
            }
        };
    }

    function findChainAlternativeRecipes(db, state, targetItem) {
        if (!db || !targetItem) return [];
        const visited = new Set();
        const alternatives = [];

        function getPrimaryRawInputs(recipe, depth = 0) {
            if (depth > 25 || !recipe || !recipe.inputs || Object.keys(recipe.inputs).length === 0) {
                return Object.keys(recipe?.outputs || {});
            }
            const raws = [];
            for (const inputItem of Object.keys(recipe.inputs)) {
                const subRecipes = getRecipesFor(db, inputItem);
                const subActive = subRecipes.length > 0
                    ? (state?.preferredRecipes?.[inputItem] ? subRecipes.find(r => r.id === state.preferredRecipes[inputItem]) || subRecipes[0] : subRecipes[0])
                    : null;
                if (!subActive || !subActive.inputs || Object.keys(subActive.inputs).length === 0 || subActive.machine === 'Purchasing Portal') {
                    raws.push(inputItem);
                } else {
                    raws.push(...getPrimaryRawInputs(subActive, depth + 1));
                }
            }
            return Array.from(new Set(raws));
        }

        function walk(item, depth = 0) {
            if (depth > 40 || visited.has(item)) return;
            visited.add(item);

            const candidates = getRecipesFor(db, item);
            if (candidates.length > 1) {
                const active = getActiveRecipe(db, state, item);
                const options = candidates.map(r => ({
                    id: r.id,
                    machine: r.machine,
                    inputs: r.inputs,
                    outputs: r.outputs,
                    baseTime: r.baseTime,
                    primaryRaw: getPrimaryRawInputs(r),
                    isActive: active?.id === r.id
                }));
                alternatives.push({
                    item,
                    activeRecipeId: active?.id || candidates[0].id,
                    candidates: options
                });
            }

            const currentRecipe = getActiveRecipe(db, state, item);
            if (currentRecipe && currentRecipe.inputs) {
                for (const inputItem of Object.keys(currentRecipe.inputs)) {
                    walk(inputItem, depth + 1);
                }
            }
        }

        walk(targetItem);
        return alternatives;
    }

    function computeUnitMaterialBreakdown(db, state, targetItem, params = {}) {
        if (!db || !db.items || !targetItem || !db.items[targetItem]) return null;

        const engineState = {
            activeRecyclers: (state?.activeRecyclers instanceof Set)
                ? state.activeRecyclers
                : new Set(Object.keys(state?.activeRecyclers || {})),
            forcedExternals: (state?.forcedExternals instanceof Set)
                ? state.forcedExternals
                : new Set(Object.keys(state?.forcedExternals || {})),
            preferredRecipes: state?.preferredRecipes || db?.settings?.preferredRecipes || {},
            nodeRecipeOverrides: state?.nodeRecipeOverrides || db?.settings?.nodeRecipeOverrides || {},
            recipeModifiers: state?.recipeModifiers || db?.settings?.recipeModifiers || {},
            customCosts: state?.customCosts || db?.settings?.customCosts || {},
            expandCatalystInputs: state?.expandCatalystInputs || db?.settings?.expandCatalystInputs || {}
        };

        const calcParams = {
            targetItem,
            targetRate: 1,
            targets: [{ item: targetItem, rate: 1 }],
            isMulti: false,
            speedMult: params.speedMult ?? 1.0,
            alchemyMult: params.alchemyMult ?? 1.0,
            beltSpeed: params.beltSpeed ?? 60,
            selectedFuel: params.selectedFuel || "Logs",
            selectedFert: params.selectedFert || "Rotten Log",
            selectedHeatingDevice: params.selectedHeatingDevice || "Stone Furnace",
            selfFuel: params.selfFuel ?? false,
            selfFert: params.selfFert ?? false,
            showFuelFert: true,
            showHeatFert: true,
            fuelMult: params.fuelMult ?? 1.0,
            fertMult: params.fertMult ?? 1.0,
            fuelCost: params.fuelCost ?? 0,
            fertCost: params.fertCost ?? 0,
            showFuelCost: false,
            showFertCost: false,
            sellMult: params.sellMult ?? 1.0,
            wholesaleMult: params.wholesaleMult ?? 1.0
        };

        const result = runCalculation({ db, params: calcParams, state: engineState });
        const targetDef = db.items[targetItem] || {};

        const rawMaterials = [];
        let totalRawCost = 0;
        for (const [rawName, qty] of Object.entries(result.summary.rawItems || {})) {
            const itemDef = db.items[rawName] || {};
            const customCost = getCustomCost(state, rawName);
            const unitPrice = customCost !== null ? customCost : (itemDef.buyPrice || 0);
            const cost = qty * unitPrice;
            totalRawCost += cost;
            rawMaterials.push({
                item: rawName,
                qty,
                unitPrice,
                totalCost: cost,
                id: itemDef.id ?? 0
            });
        }

        for (const [extName, qty] of Object.entries(result.summary.forcedItems || {})) {
            const itemDef = db.items[extName] || {};
            const customCost = getCustomCost(state, extName);
            const unitPrice = customCost !== null ? customCost : (itemDef.buyPrice || 0);
            const cost = qty * unitPrice;
            totalRawCost += cost;
            rawMaterials.push({
                item: extName,
                qty,
                unitPrice,
                totalCost: cost,
                id: itemDef.id ?? 0,
                isExternal: true
            });
        }

        const intermediatesMap = {};
        function collectIntermediates(node) {
            if (!node) return;
            if (node.item !== targetItem && !node.isRaw && !node.isExternal) {
                intermediatesMap[node.item] = (intermediatesMap[node.item] || 0) + (node.netRate || node.requestedRate);
            }
            if (node.children) {
                node.children.forEach(collectIntermediates);
            }
        }
        if (result.treeRoots && result.treeRoots[0]) {
            collectIntermediates(result.treeRoots[0].root);
        }

        const intermediates = Object.entries(intermediatesMap).map(([item, qty]) => ({
            item,
            qty,
            id: db.items[item]?.id ?? 0
        })).sort((a, b) => b.qty - a.qty);

        const chainAlternatives = findChainAlternativeRecipes(db, state, targetItem);

        const fuelDef = db.items[calcParams.selectedFuel] || {};
        const fuelCustomCost = getCustomCost(state, calcParams.selectedFuel);
        const fuelUnitPrice = fuelCustomCost !== null
            ? fuelCustomCost
            : (params.fuelCost > 0
                ? params.fuelCost
                : (fuelDef.buyPrice || fuelDef.baseCost || 0));
        const fuelQty = result.summary.fuelDemandItems || 0;
        const heatingCost = fuelQty * fuelUnitPrice;

        const fertDef = db.items[calcParams.selectedFert] || {};
        const fertCustomCost = getCustomCost(state, calcParams.selectedFert);
        const fertUnitPrice = fertCustomCost !== null
            ? fertCustomCost
            : (params.fertCost > 0
                ? params.fertCost
                : (fertDef.buyPrice || fertDef.baseCost || 0));
        const fertQty = result.summary.fertDemandItems || 0;
        const fertCost = fertQty * fertUnitPrice;

        const totalUnitCost = totalRawCost + heatingCost + fertCost;
        const sellPrice = targetDef.sellPrice ? Math.round(targetDef.sellPrice * calcParams.sellMult) : null;
        const profit = sellPrice !== null && totalUnitCost > 0 ? (sellPrice - totalUnitCost) : null;
        const margin = sellPrice !== null && totalUnitCost > 0 ? ((sellPrice / totalUnitCost) - 1) : null;

        return {
            targetItem,
            rawMaterials,
            intermediates,
            totalRawCost,
            totalHeat: result.summary.heatLoad * 60,
            selectedFuel: calcParams.selectedFuel,
            fuelQty,
            fuelUnitPrice,
            heatingCost,
            fuelId: fuelDef.id ?? 0,
            selectedFert: calcParams.selectedFert,
            fertQty,
            fertUnitPrice,
            fertCost,
            totalUnitCost,
            sellPrice,
            profit,
            margin,
            chainAlternatives
        };
    }

    global.AlchemyCalcEngine = {
        runCalculation,
        getBeltSpeed,
        getSpeedMult,
        getAlchemyMult,
        getSellMult,
        getRecipesFor,
        getActiveRecipe,
        getRecipeById,
        applyAlchemyMult,
        getThermalExtractorRatio,
        getProductionHeatCost,
        getProductionFertCost,
        computeParadoxTime,
        computeDecomposeTime,
        computeDecomposeExp,
        findChainAlternativeRecipes,
        computeUnitMaterialBreakdown
    };
})(window);