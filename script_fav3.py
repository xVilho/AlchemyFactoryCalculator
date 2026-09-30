import sys
with open('js/alchemy_cauldron.js', 'r', encoding='utf-8') as f:
    text = f.read()

old_code = '''                if (importCount > 0) {
                    saveCauldronSettings();
                    renderCauldronFavorites();
                    alert(`Successfully imported ${importCount} recipes!`);
                }'''

new_code = '''                if (importCount > 0) {
                    saveCauldronSettings();
                    renderCauldronFavorites();
                    syncCauldronToMainDB();
                    alert(`Successfully imported ${importCount} recipes!`);
                }'''

if old_code in text:
    text = text.replace(old_code, new_code)
    print("Replaced import")
else:
    print("Not found")

with open('js/alchemy_cauldron.js', 'w', encoding='utf-8') as f:
    f.write(text)
