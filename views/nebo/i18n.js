// Language system for Nebo. Dictionaries live in lang/<code>.json, named by
// the ISO 639-1 code the browser reports (navigator.language gives "sl" or
// "sl-SI" on a Slovenian system), so the code doubles as the file name.
// The helpers up top (pickLanguage, lookup, format) are DOM-free and tested
// in tests/nebo-i18n.test.mjs; only applyTranslations touches the document.

export const SUPPORTED = ['en', 'sl'];
export const FALLBACK = 'en';
export const STORAGE_KEY = 'nebo-lang';

// A saved dropdown choice wins; otherwise the first system language we have a
// dictionary for; otherwise English.
export function pickLanguage(saved, systemLanguages, supported = SUPPORTED) {
    if (supported.includes(saved)) return saved;
    for (const tag of systemLanguages || []) {
        const base = String(tag).toLowerCase().split('-')[0];
        if (supported.includes(base)) return base;
    }
    return FALLBACK;
}

// Dotted-path lookup ('ledger.phase'). A dead end returns the key itself, so
// a missing translation shows up on the page instead of leaving it blank.
export function lookup(dict, key) {
    let node = dict;
    for (const part of key.split('.')) {
        node = (node !== null && typeof node === 'object') ? node[part] : undefined;
    }
    return node ?? key;
}

// Fill '{name}' slots. Unknown slots stay verbatim, again to stay debuggable.
export function format(template, params = {}) {
    return String(template).replace(/\{(\w+)\}/g, (whole, name) => (name in params ? String(params[name]) : whole));
}

export async function loadDictionary(lang) {
    const res = await fetch(`lang/${lang}.json`);
    if (!res.ok) throw new Error(`dictionary ${lang}: HTTP ${res.status}`);
    return res.json();
}

// data-i18n="key" fills textContent; data-i18n-attr="attr:key; attr2:key2"
// sets attributes (aria-labels). Works on SVG elements too (the stamp ring).
export function applyTranslations(dict, root = document) {
    for (const el of root.querySelectorAll('[data-i18n]')) {
        el.textContent = lookup(dict, el.dataset.i18n);
    }
    for (const el of root.querySelectorAll('[data-i18n-attr]')) {
        for (const pair of el.dataset.i18nAttr.split(';')) {
            const [attr, key] = pair.split(':').map((part) => part.trim());
            if (attr && key) el.setAttribute(attr, lookup(dict, key));
        }
    }
}
