// alchemy_text.js: Text helpers. The site is English-only; these are pass-throughs so the
// existing t(...) calls throughout the code keep working.

/** Returns the UI text unchanged (formerly the translation lookup). */
function t(text) { return text || ""; }

/** Returns the item name unchanged (formerly mapped to the translated name). */
function getCurrentItemName(name) { return name; }

/** Alternate-language name of an item; none exist any more. */
function queryDualItemName() { return ""; }
