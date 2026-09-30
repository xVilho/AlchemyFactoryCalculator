import sys
with open('js/alchemy_cauldron.js', 'r', encoding='utf-8') as f:
    text = f.read()

old_code_1 = '''function removeFavorite(idx) {
    cauldronState.favorites.splice(idx, 1);    
    renderCauldronFavorites();
    saveCauldronSettings();
}'''

new_code_1 = '''function removeFavorite(idx) {
    cauldronState.favorites.splice(idx, 1);    
    renderCauldronFavorites();
    saveCauldronSettings();
    syncCauldronToMainDB();
}'''

if old_code_1 in text:
    text = text.replace(old_code_1, new_code_1)
    print("Replaced removeFavorite")

old_code_2 = '''                if (importCount > 0) {
                    saveCauldronSettings();
                    renderCauldronFavorites();
                    alert(Successfully imported  recipes!);
                }'''

new_code_2 = '''                if (importCount > 0) {
                    saveCauldronSettings();
                    renderCauldronFavorites();
                    syncCauldronToMainDB();
                    alert(Successfully imported  recipes!);
                }'''

if old_code_2 in text:
    text = text.replace(old_code_2, new_code_2)
    print("Replaced import")

with open('js/alchemy_cauldron.js', 'w', encoding='utf-8') as f:
    f.write(text)
