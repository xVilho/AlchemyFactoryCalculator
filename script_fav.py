import sys
with open('js/alchemy_cauldron.js', 'r', encoding='utf-8') as f:
    text = f.read()

old_code_1 = '''    }
    renderCauldronFavorites();
    saveCauldronSettings();
}'''

new_code_1 = '''    }
    renderCauldronFavorites();
    saveCauldronSettings();
    syncCauldronToMainDB();
}'''

if old_code_1 in text:
    text = text.replace(old_code_1, new_code_1)
    print("Replaced 1")

old_code_2 = '''    if (idx > -1) favs.splice(idx, 1);
    else favs.push(recipe);

    renderCauldronFavorites();
    saveCauldronSettings();
}'''

new_code_2 = '''    if (idx > -1) favs.splice(idx, 1);
    else favs.push(recipe);

    renderCauldronFavorites();
    saveCauldronSettings();
    syncCauldronToMainDB();
}'''

if old_code_2 in text:
    text = text.replace(old_code_2, new_code_2)
    print("Replaced 2")

with open('js/alchemy_cauldron.js', 'w', encoding='utf-8') as f:
    f.write(text)
