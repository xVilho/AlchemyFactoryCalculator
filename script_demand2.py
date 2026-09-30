import sys
import re

with open('js/alchemy_planner_overlays.js', 'r', encoding='utf-8') as f:
    text = f.read()

old_block = '''            if (rates) {
                let requiredCount = 0;
                rates.outputsPerMachine.forEach(p => {
                    const demand = nodeDemand[curr][p.item] || 0;
                    if (p.rate > 0) requiredCount = Math.max(requiredCount, demand / p.rate);
                });
                
                currNode.machineCount = requiredCount;

                // Propagate upstream'''

new_block = '''            if (rates) {
                let requiredCount = 0;
                if (currNode.kind === 'portal') {
                    // Do NOT auto-balance portals! Keep their user-defined machine count.
                    requiredCount = currNode.machineCount;
                } else {
                    rates.outputsPerMachine.forEach(p => {
                        const demand = nodeDemand[curr][p.item] || 0;
                        if (p.rate > 0) requiredCount = Math.max(requiredCount, demand / p.rate);
                    });
                    currNode.machineCount = requiredCount;
                }

                // Propagate upstream'''

if old_block in text:
    text = text.replace(old_block, new_block)
    print("Replaced!")
else:
    print("Not found!")

with open('js/alchemy_planner_overlays.js', 'w', encoding='utf-8') as f:
    f.write(text)
