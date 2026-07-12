'use strict';

import {
    pageCount, suggestTier, calculatePrice, validateForm,
    PRICES, PACKAGE_FROM, SUPPORT_PRICES, LOADING_STEPS,
} from './logic.js';
import {
    pickLanguage, lookup, format, loadDictionary, applyTranslations,
    FALLBACK, STORAGE_KEY,
} from './i18n.js';

// ─── Language ──────────────────────────────────────────────────────────────
// All visible copy flows through lang/<code>.json (see i18n.js): the system
// language picks the startup language, the header dropdown and localStorage
// override it. Ported from views/nebo/script.js's setLanguage wiring.

const i18n = { lang: null, dict: null };

const t = (key, params) => (params ? format(lookup(i18n.dict, key), params) : lookup(i18n.dict, key));

function formatCurrency(n) {
    const locale = i18n.dict?.locale === 'sl-SI' ? 'sl-SI' : 'en-GB';
    return format(t('currency'), { n: n.toLocaleString(locale) });
}

// The package cards' data-amount starts as plain HTML text (so the page
// still reads fine with JS disabled); PACKAGE_FROM in logic.js is the real
// source of truth, so stamp it over the markup once before anything renders.
function applyPackagePrices() {
    document.querySelectorAll('.package-card[data-package]').forEach(card => {
        const tier    = card.dataset.package;
        const priceEl = card.querySelector('.price-cell');
        if (priceEl && tier in PACKAGE_FROM) priceEl.dataset.amount = String(PACKAGE_FROM[tier]);
    });
}

// Any element with a flat data-amount is a statically-priced cell (package
// card price, à-la-carte table row); a price-chip is the small "(+€N)" /
// "(from €N)" note next to a question option. Both need re-filling on every
// language switch since the currency symbol moves sides.
function formatPriceElements() {
    document.querySelectorAll('.price-cell[data-amount]').forEach(el => {
        const amount = Number(el.dataset.amount);
        const money  = formatCurrency(amount);
        if (el.dataset.prefix === 'from') el.textContent = `${t('table.fromPrefix')} ${money}`;
        else if (el.dataset.suffix === 'perPage') el.textContent = `${money}${t('table.perPage')}`;
        else if (el.dataset.suffix === 'each') el.textContent = `${money}${t('table.each')}`;
        else el.textContent = money;
    });

    document.querySelectorAll('.price-chip[data-amount]').forEach(el => {
        const money = formatCurrency(Number(el.dataset.amount));
        el.textContent = el.dataset.format === 'from'    ? `(${t('table.fromPrefix')} ${money})`
                        : el.dataset.format === 'perPage' ? `(+${money}${t('table.perPage')})`
                        : `(+${money})`;
    });

    // Hints/labels that interpolate a price mid-sentence rather than showing
    // a standalone chip (e.g. "extras billed at €40 each").
    document.querySelectorAll('[data-i18n-template]').forEach(el => {
        const price = formatCurrency(Number(el.dataset.price));
        el.textContent = format(t(el.dataset.i18nTemplate), { price });
    });
}

// Toggle-button labels are JS-owned state (open/closed), not a static
// data-i18n hook, so a language switch can't just re-run applyTranslations
// on them without first knowing which of the two words currently applies.
let refreshPackagesToggle = () => {};
let refreshAlacToggle = () => {};

// The results screen renders receipt/context copy from the last computed
// quote; re-run it on a language switch so it doesn't stay stuck in the
// previous language while every static label around it updates.
let lastPriceData = null;

async function setLanguage(lang, { save = false } = {}) {
    i18n.dict = await loadDictionary(lang);
    i18n.lang = lang;
    if (save) {
        try { localStorage.setItem(STORAGE_KEY, lang); } catch { /* private mode: the choice just won't stick */ }
    }
    document.documentElement.lang = lang;
    document.title = t('meta.title');
    document.querySelector('meta[name="description"]')?.setAttribute('content', t('meta.description'));

    applyTranslations(i18n.dict);
    formatPriceElements();
    refreshPackagesToggle();
    refreshAlacToggle();
    document.getElementById('langSelect').value = lang;

    if (lastPriceData && !document.getElementById('state-results').classList.contains('hidden')) {
        renderResults(lastPriceData.tier, lastPriceData.total, lastPriceData.lineItems, lastPriceData.hasCustom);
    }
}

// ─── State ───────────────────────────────────────────────────────────────────

let currentQuoteId = null; // DB id of the last saved quote (for PUT)

function getFormState() {
    const f = document.getElementById('quoteForm');
    const checkedValues = (name) =>
        [...f.querySelectorAll(`input[name="${name}"]:checked`)].map(el => el.value);
    const radioValue = (name) => {
        const el = f.querySelector(`input[name="${name}"]:checked`);
        return el ? el.value : null;
    };

    return {
        purpose:         checkedValues('purpose'),
        pages:           radioValue('pages'),
        content:         radioValue('content'),
        design:          radioValue('design'),
        logo:            f.querySelector('input[name="logo"]').checked,
        languages:       radioValue('languages'),
        cms:             radioValue('cms'),
        features:        checkedValues('features'),
        shop:            checkedValues('shop'),
        extra_products:  parseInt(f.querySelector('#extraProducts').value) || 0,
        marketing:       checkedValues('marketing'),
        hosting:         radioValue('hosting'),
        special_requests: document.getElementById('specialRequests').value.trim(),
    };
}

function restoreFormState(s) {
    if (!s) return;
    const f = document.getElementById('quoteForm');

    const setChecked = (name, values) => {
        f.querySelectorAll(`input[name="${name}"]`).forEach(el => {
            el.checked = values.includes(el.value);
        });
    };
    const setRadio = (name, value) => {
        if (!value) return;
        const el = f.querySelector(`input[name="${name}"][value="${value}"]`);
        if (el) el.checked = true;
    };

    setChecked('purpose',   s.purpose   || []);
    setRadio('pages',       s.pages);
    setRadio('content',     s.content);
    setRadio('design',      s.design);
    if (s.logo) f.querySelector('input[name="logo"]').checked = true;
    setRadio('languages',   s.languages);
    setRadio('cms',         s.cms);
    setChecked('features',  s.features  || []);
    setChecked('shop',      s.shop      || []);
    f.querySelector('#extraProducts').value = s.extra_products || 0;
    setChecked('marketing', s.marketing || []);
    setRadio('hosting',     s.hosting);
    document.getElementById('specialRequests').value = s.special_requests || '';
}

// ─── Results rendering ────────────────────────────────────────────────────────

function lineItemLabel(item) {
    const base = item.params ? format(t(`items.${item.key}`), item.params) : t(`items.${item.key}`);
    return item.isCustom ? format(t('items.minimumSuffix'), { name: base }) : base;
}

function renderResults(tier, total, lineItems, hasCustom) {
    lastPriceData = { tier, total, lineItems, hasCustom };

    // Package badge
    const badge = document.getElementById('resultPackageBadge');
    badge.textContent = tier;
    badge.className   = `package-result-badge font-mono text-sm tracking-widest px-3 py-1 rounded-[3px] border badge-${tier}`;

    // Receipt date
    document.getElementById('receiptDate').textContent =
        new Date().toLocaleDateString(i18n.dict.locale, { day: 'numeric', month: 'long', year: 'numeric' });

    // Line items
    const container = document.getElementById('receiptLineItems');
    container.innerHTML = lineItems.map(item => `
        <div class="receipt-line-item${item.isBase ? ' item-base' : ''}${item.isCustom ? ' item-contact' : ''}">
            <span class="item-name">${item.isCustom ? '⚡ ' : ''}${lineItemLabel(item)}</span>
            <span class="item-price">${formatCurrency(item.price)}</span>
        </div>
    `).join('');

    // Custom note
    document.getElementById('customNote').classList.toggle('hidden', !hasCustom);

    // Total
    document.getElementById('resultTotal').textContent = formatCurrency(total);

    // Rental
    const months  = 18;
    const monthly = Math.ceil(total / months);
    document.getElementById('rentalPrice').textContent = `~${formatCurrency(monthly)}${t('results.rentalFor', { months })}`;
    document.getElementById('maintenanceNote').textContent = format(t('results.maintenanceNote'), { price: formatCurrency(SUPPORT_PRICES.basic) });

    // Package context card
    document.getElementById('packageContextName').textContent = tier;
    document.getElementById('packageContextDesc').textContent = t(`packages.${tier}.description`);
    document.getElementById('packageContextItems').innerHTML = lookup(i18n.dict, `packages.${tier}.items`)
        .map(item => `<div class="flex gap-1.5 text-parchment/75"><span class="text-gold mt-0.5">✓</span>${item}</div>`)
        .join('');

    // Highlight the matching package card in the packages grid
    document.querySelectorAll('.package-card').forEach(card => {
        const pkg = card.dataset.package;
        if (pkg === tier) {
            card.classList.remove('dimmed');
            card.classList.add('highlighted');
        } else {
            card.classList.add('dimmed');
            card.classList.remove('highlighted');
        }
    });
}

// ─── Loading sequence ─────────────────────────────────────────────────────────

function runLoadingSequence(duration, onComplete) {
    const output   = document.getElementById('terminalOutput');
    const bar      = document.getElementById('loadingBar');
    const pct      = document.getElementById('loadingPct');
    const start    = Date.now();
    const timeouts = [];

    output.innerHTML = '';

    LOADING_STEPS.forEach(step => {
        if (step.delay >= duration) return;
        const timeout = setTimeout(() => {
            const line = document.createElement('div');
            line.className   = step.type === 'prompt' ? 'terminal-prompt' : 'terminal-line';
            line.textContent = t(`loading.steps.${step.key}`);
            output.appendChild(line);
            output.scrollTop = output.scrollHeight;
        }, step.delay);
        timeouts.push(timeout);
    });

    const barInterval = setInterval(() => {
        const elapsed  = Date.now() - start;
        const progress = Math.min(95, (elapsed / duration) * 100);
        bar.style.width  = `${progress}%`;
        pct.textContent  = `${Math.round(progress)}%`;
    }, 80);

    const doneTimeout = setTimeout(() => {
        clearInterval(barInterval);
        bar.style.width = '100%';
        pct.textContent = '100%';

        const done = document.createElement('div');
        done.className   = 'terminal-prompt success';
        done.textContent = t('loading.steps.done');
        output.appendChild(done);
        output.scrollTop = output.scrollHeight;

        setTimeout(onComplete, 600);
    }, duration);
    timeouts.push(doneTimeout);
}

// ─── State transitions ────────────────────────────────────────────────────────

function showState(name) {
    ['state-form', 'state-loading', 'state-results'].forEach(id => {
        const el = document.getElementById(id);
        if (id === name) {
            el.classList.remove('hidden');
        } else {
            el.classList.add('hidden');
        }
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ─── Quote submission (POST / PUT) ───────────────────────────────────────────

async function saveQuote(state, priceData, isUpdate) {
    const payload = {
        selections:        state,
        suggested_package: priceData.tier,
        total_price:       priceData.total,
        special_requests:  state.special_requests || '',
    };

    const url    = isUpdate
        ? `../../app/controllers/pricing-controller.php?id=${currentQuoteId}`
        : '../../app/controllers/pricing-controller.php';
    const method = isUpdate ? 'PUT' : 'POST';

    const res  = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Server error');
    if (!isUpdate) currentQuoteId = data.id;
    return data;
}

// ─── "Send quote" — updates DB with contact info then opens mailto ────────────

async function sendQuote() {
    const sendBtn  = document.getElementById('sendQuoteBtn');
    const errEl    = document.getElementById('sendError');
    const btnText  = sendBtn.querySelector('.btn-send-text');
    const btnSpin  = sendBtn.querySelector('.btn-send-loading');

    const name    = document.getElementById('contactName').value.trim();
    const email   = document.getElementById('contactEmail').value.trim();
    const message = document.getElementById('contactMessage').value.trim();
    const support = document.querySelector('input[name="support"]:checked')?.value || 'none';

    errEl.classList.add('hidden');
    sendBtn.disabled = true;
    btnText.classList.add('hidden');
    btnSpin.classList.remove('hidden');

    try {
        // Persist contact details to existing quote row
        if (currentQuoteId) {
            const state      = getFormState();
            const priceData  = calculatePrice(state);
            const payload    = {
                selections:        state,
                suggested_package: priceData.tier,
                total_price:       priceData.total,
                special_requests:  state.special_requests || '',
                contact_name:      name,
                contact_email:     email,
                message:           message,
            };
            await fetch(
                `../../app/controllers/pricing-controller.php?id=${currentQuoteId}`,
                {
                    method:  'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body:    JSON.stringify(payload),
                }
            );
        }

        // Build mailto body, in whichever language the visitor is reading
        const state     = getFormState();
        const priceData = calculatePrice(state);
        const tier      = priceData.tier;
        const total     = priceData.total;

        const itemLines = priceData.lineItems
            .map(item => `  • ${lineItemLabel(item)}: ${formatCurrency(item.price)}`)
            .join('\n');

        const supportText = support === 'none'    ? t('mailto.supportNone')
                           : support === 'basic'   ? format(t('mailto.supportBasic'), { price: formatCurrency(SUPPORT_PRICES.basic) })
                           : format(t('mailto.supportAdvanced'), { price: formatCurrency(SUPPORT_PRICES.advanced) });

        const body = [
            t('mailto.greeting'),
            ``,
            t('mailto.intro'),
            ``,
            `─── ${t('mailto.quoteSummary')} ───`,
            `${t('mailto.suggestedPackageLabel')} : ${tier}`,
            `${t('mailto.estimatedTotalLabel')}   : ${formatCurrency(total)} ${t('mailto.exclVatParen')}`,
            `${t('mailto.ongoingSupportLabel')}   : ${supportText}`,
            ``,
            `─── ${t('mailto.breakdown')} ───`,
            itemLines,
            ``,
            state.special_requests
                ? `─── ${t('mailto.specialRequests')} ───\n${state.special_requests}\n`
                : '',
            name    ? `${t('mailto.nameLabel')} : ${name}`    : '',
            email   ? `${t('mailto.emailLabel')} : ${email}`   : '',
            message ? `\n${t('mailto.messageLabel')}:\n${message}` : '',
            ``,
            `─────────────────────`,
            format(t('mailto.footer'), { id: currentQuoteId || '—', date: new Date().toLocaleDateString(i18n.dict.locale) }),
        ].filter(l => l !== '').join('\n');

        const subject = encodeURIComponent(format(t('mailto.subject'), { tier }));
        const bodyEnc = encodeURIComponent(body);
        window.location.href = `mailto:contact@domenhribernik.com?subject=${subject}&body=${bodyEnc}`;

    } catch (err) {
        errEl.textContent = t('results.sendError');
        errEl.classList.remove('hidden');
    } finally {
        sendBtn.disabled = false;
        btnText.classList.remove('hidden');
        btnSpin.classList.add('hidden');
    }
}

// ─── Packages toggle ──────────────────────────────────────────────────────────

function initPackagesToggle() {
    const btn     = document.getElementById('packagesToggle');
    const grid    = document.getElementById('packagesGrid');
    const label   = btn.querySelector('.packages-toggle-label');
    const chevron = btn.querySelector('.packages-chevron');
    let open      = true;

    refreshPackagesToggle = () => {
        label.textContent = open ? t('packagesSection.collapse') : t('packagesSection.expand');
        chevron.style.transform = open ? '' : 'rotate(180deg)';
        btn.setAttribute('aria-expanded', String(open));
    };

    btn.addEventListener('click', () => {
        open = !open;
        grid.classList.toggle('hidden', !open);
        refreshPackagesToggle();
    });

    // Collapse by default on mobile
    if (window.innerWidth < 640) {
        open = false;
        grid.classList.add('hidden');
        btn.setAttribute('aria-expanded', 'false');
    }
}

// ─── À-la-carte toggle ────────────────────────────────────────────────────────

function initAlacToggle() {
    const btn     = document.getElementById('alacToggle');
    const content = document.getElementById('alacContent');
    const label   = btn.querySelector('.alac-label');
    const chevron = btn.querySelector('.alac-chevron');
    let open      = false;

    refreshAlacToggle = () => {
        label.textContent = open ? t('table.hide') : t('table.show');
        chevron.style.transform = open ? 'rotate(180deg)' : '';
    };

    btn.addEventListener('click', () => {
        open = !open;
        content.classList.toggle('hidden', !open);
        refreshAlacToggle();
    });
}

// ─── LocalStorage persistence ─────────────────────────────────────────────────

function saveToStorage(state) {
    try { localStorage.setItem('pricing_form_v1', JSON.stringify(state)); } catch (_) {}
}

function loadFromStorage() {
    try {
        const raw = localStorage.getItem('pricing_form_v1');
        return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    applyPackagePrices();

    // Restore saved state
    const saved = loadFromStorage();
    if (saved) restoreFormState(saved);

    initPackagesToggle();
    initAlacToggle();

    // Save on every change
    document.getElementById('quoteForm').addEventListener('change', () => {
        saveToStorage(getFormState());
    });
    document.getElementById('specialRequests').addEventListener('input', () => {
        saveToStorage(getFormState());
    });

    // ── Form submit ──
    document.getElementById('quoteForm').addEventListener('submit', async (e) => {
        e.preventDefault();

        const state  = getFormState();
        const errors = validateForm(state);
        const errEl  = document.getElementById('formError');

        if (errors.length) {
            errEl.textContent = t(errors[0]);
            errEl.classList.remove('hidden');
            errEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return;
        }
        errEl.classList.add('hidden');

        const priceData  = calculatePrice(state);
        const isUpdate   = currentQuoteId !== null;
        const loadDur    = 10000 + Math.random() * 10000; // 10–20 s

        showState('state-loading');

        // Save to DB in background while loading plays
        let dbPromise;
        try {
            dbPromise = saveQuote(state, priceData, isUpdate);
        } catch (_) {
            dbPromise = Promise.resolve(null);
        }

        runLoadingSequence(loadDur, async () => {
            try { await dbPromise; } catch (_) {}
            renderResults(priceData.tier, priceData.total, priceData.lineItems, priceData.hasCustom);
            showState('state-results');
        });
    });

    // ── Edit selections ──
    document.getElementById('editSelectionsBtn').addEventListener('click', () => {
        showState('state-form');
        // Reset package card dimming so the grid looks neutral again
        document.querySelectorAll('.package-card').forEach(card => {
            card.classList.remove('dimmed', 'highlighted');
        });
        setTimeout(() => {
            document.getElementById('quoteForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 100);
    });

    // ── Send quote ──
    document.getElementById('sendQuoteBtn').addEventListener('click', sendQuote);

    // ── Language ──
    document.getElementById('langSelect').addEventListener('change', (event) => {
        setLanguage(event.target.value, { save: true })
            .catch(() => { document.getElementById('langSelect').value = i18n.lang; }); // dictionary fetch failed: stay put
    });

    let savedLang = null;
    try { savedLang = localStorage.getItem(STORAGE_KEY); } catch { /* private mode */ }
    const systemLanguages = navigator.languages || [navigator.language];
    setLanguage(pickLanguage(savedLang, systemLanguages)).catch(() => {
        setLanguage(FALLBACK).catch(() => {});
    });
});
