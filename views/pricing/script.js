'use strict';

// ─── Price map (source of truth from plan.md) ────────────────────────────────

const PRICES = {
    // Base packages (minimum cost depending on tier)
    baseMini:    300,
    baseBasic:   490,

    // Design upgrades (delta over template)
    designSemi:  180,
    designFull:  350,
    logo:        120,

    // Pages (extra beyond what's included in the package)
    extraPage:   40,

    // Content writing
    copywriting: 40, // per page

    // Languages (extra beyond first)
    language:    120,

    // CMS
    cms:         180,

    // Features
    map:         30,
    gallery:     60,
    blog:        150,
    newsletter:  60,
    chat:        50,
    booking:     400,  // minimum
    accounts:    500,  // minimum
    api:         250,  // minimum

    // Shop
    shopSetup:   600,
    payments:    150,
    orders:      200,
    extraProduct: 3,

    // Marketing
    seo:         180,
    analytics:   60,
    speed:       100,
    security:    80,
};

// Features that need a custom quote (shown as "contact" in receipt)
const CUSTOM_FEATURES = new Set(['booking', 'accounts', 'api']);

// Pages included per tier
const PAGES_INCLUDED = { MINI: 1, BASIC: 3, PLUS: 6, PREMIUM: 12, CUSTOM: 999 };

// Package data for result display
const PACKAGE_INFO = {
    MINI: {
        label:       'MINI',
        from:        300,
        description: 'A single-page online presence — clean, fast, and done.',
        items:       ['1-page site', 'Template design', 'Mobile-friendly', 'SSL certificate', 'Contact form'],
    },
    BASIC: {
        label:       'BASIC',
        from:        490,
        description: 'The foundation every small business needs.',
        items:       ['Up to 3 pages', 'Template design', 'Basic SEO + search registration', 'Mobile-friendly', 'Domain + hosting 1yr', 'Contact form'],
    },
    PLUS: {
        label:       'PLUS',
        from:        890,
        description: 'Everything a business presentation site genuinely needs.',
        items:       ['Up to 6 pages', 'Semi-custom design', 'Logo included', 'Blog / news', 'Advanced SEO', 'Analytics', 'Interactive map', 'Multiple contact forms', 'Domain + hosting 1yr'],
    },
    PREMIUM: {
        label:       'PREMIUM',
        from:        1600,
        description: 'Serious presence, multilingual, and independently manageable.',
        items:       ['Up to 12 pages', 'Fully custom design', 'Advanced SEO', 'Multilingual (1 extra language)', 'CMS for self-editing', 'Speed optimisation', 'Security hardening', 'Everything in PLUS'],
    },
    CUSTOM: {
        label:       'CUSTOM',
        from:        2500,
        description: 'No ceiling. Built exactly to your requirements.',
        items:       ['Unlimited pages', 'Web shop + user accounts', 'Booking / reservation system', 'Dynamic content + dashboards', 'API integrations', 'Price by agreement'],
    },
};

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

// ─── Tier calculation ─────────────────────────────────────────────────────────

function suggestTier(s) {
    const features = s.features || [];
    const shop     = s.shop     || [];
    const purpose  = s.purpose  || [];

    // CUSTOM triggers
    if (purpose.includes('app')) return 'CUSTOM';
    if (features.includes('accounts') || features.includes('api') || features.includes('booking')) return 'CUSTOM';
    if (shop.length > 0) return 'CUSTOM';

    // PREMIUM triggers
    if (s.design === 'full')      return 'PREMIUM';
    if (s.languages && s.languages !== '1') return 'PREMIUM';
    if (s.cms === 'yes')          return 'PREMIUM';

    // PLUS triggers
    if (features.includes('blog')) return 'PLUS';
    if (s.logo)                    return 'PLUS';
    if (s.design === 'semi')       return 'PLUS';
    if (s.pages === '4-6' || s.pages === '7-12' || s.pages === '13+') return 'PLUS';

    // MINI trigger: only if 1 page, no domain/hosting
    if (s.pages === '1' && s.hosting === 'own') return 'MINI';

    return 'BASIC';
}

function pageCount(pagesValue) {
    const map = { '1': 1, '2-3': 3, '4-6': 6, '7-12': 12, '13+': 13 };
    return map[pagesValue] || 1;
}

function calculatePrice(s) {
    const tier      = suggestTier(s);
    const features  = s.features || [];
    const shop      = s.shop     || [];
    const marketing = s.marketing || [];
    let total    = 0;
    let hasCustom = false;
    const lineItems = [];

    // Base
    const base = tier === 'MINI' ? PRICES.baseMini : PRICES.baseBasic;
    total += base;
    lineItems.push({ name: `Base (${tier === 'MINI' ? 'MINI' : 'BASIC'} package)`, price: base, isBase: true });

    // Design upgrade
    if (s.design === 'semi') {
        total += PRICES.designSemi;
        lineItems.push({ name: 'Semi-custom design', price: PRICES.designSemi });
    } else if (s.design === 'full') {
        total += PRICES.designFull;
        lineItems.push({ name: 'Fully custom design', price: PRICES.designFull });
    }

    // Logo
    if (s.logo) {
        total += PRICES.logo;
        lineItems.push({ name: 'Logo design', price: PRICES.logo });
    }

    // Extra pages
    const pages       = pageCount(s.pages);
    const included    = PAGES_INCLUDED[tier] ?? 3;
    const extraPages  = Math.max(0, pages - included);
    if (extraPages > 0) {
        const cost = extraPages * PRICES.extraPage;
        total += cost;
        lineItems.push({ name: `Extra pages (${extraPages} × €40)`, price: cost });
    }

    // Copywriting
    if (s.content === 'written') {
        const cost = pages * PRICES.copywriting;
        total += cost;
        lineItems.push({ name: `Copywriting (${pages} pages × €40)`, price: cost });
    }

    // Languages
    if (s.languages === '2') {
        total += PRICES.language;
        lineItems.push({ name: 'Multilingual (1 extra language)', price: PRICES.language });
    } else if (s.languages === '3+') {
        total += PRICES.language * 2;
        lineItems.push({ name: 'Multilingual (2+ extra languages)', price: PRICES.language * 2 });
    }

    // CMS
    if (s.cms === 'yes') {
        total += PRICES.cms;
        lineItems.push({ name: 'CMS for self-editing', price: PRICES.cms });
    }

    // Features
    const featureNames = {
        map:       ['Interactive map',       PRICES.map],
        gallery:   ['Image gallery',         PRICES.gallery],
        blog:      ['Blog / news section',   PRICES.blog],
        newsletter:['Newsletter signup',     PRICES.newsletter],
        chat:      ['Live chat',             PRICES.chat],
        booking:   ['Booking system',        PRICES.booking],
        accounts:  ['User accounts / dashboard', PRICES.accounts],
        api:       ['API / third-party integration', PRICES.api],
    };
    features.forEach(f => {
        if (!featureNames[f]) return;
        const [name, price] = featureNames[f];
        if (CUSTOM_FEATURES.has(f)) {
            hasCustom = true;
            lineItems.push({ name: `${name} (minimum)`, price, isCustom: true });
        } else {
            total += price;
            lineItems.push({ name, price });
        }
    });
    // Add custom feature minimums to total
    features.forEach(f => {
        if (CUSTOM_FEATURES.has(f)) total += featureNames[f][1];
    });

    // Shop
    const shopNames = {
        setup:    ['Shop setup (up to 20 products)', PRICES.shopSetup],
        payments: ['Payment integration',            PRICES.payments],
        orders:   ['Order / inventory management',   PRICES.orders],
    };
    shop.forEach(item => {
        if (!shopNames[item]) return;
        const [name, price] = shopNames[item];
        hasCustom = true;
        total += price;
        lineItems.push({ name, price, isCustom: true });
    });

    // Extra products
    if (s.extra_products > 0) {
        const cost = s.extra_products * PRICES.extraProduct;
        total += cost;
        lineItems.push({ name: `Extra products (${s.extra_products} × €3)`, price: cost });
    }

    // Marketing
    const marketingNames = {
        seo:      ['Advanced SEO optimisation', PRICES.seo],
        analytics:['Analytics & tracking',      PRICES.analytics],
        speed:    ['Speed optimisation',         PRICES.speed],
        security: ['Security hardening',         PRICES.security],
    };
    marketing.forEach(m => {
        if (!marketingNames[m]) return;
        const [name, price] = marketingNames[m];
        total += price;
        lineItems.push({ name, price });
    });

    return { tier, total, lineItems, hasCustom };
}

// ─── Results rendering ────────────────────────────────────────────────────────

function renderResults(tier, total, lineItems, hasCustom) {
    // Package badge
    const badge = document.getElementById('resultPackageBadge');
    badge.textContent  = tier;
    badge.className    = `package-result-badge font-display text-sm tracking-widest px-3 py-1 border-2 shadow-stamp-sm badge-${tier}`;

    // Receipt date
    document.getElementById('receiptDate').textContent =
        new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

    // Line items
    const container = document.getElementById('receiptLineItems');
    container.innerHTML = lineItems.map(item => `
        <div class="receipt-line-item${item.isBase ? ' item-base' : ''}${item.isCustom ? ' item-contact' : ''}">
            <span class="item-name">${item.isCustom ? '⚡ ' : ''}${item.name}</span>
            <span class="item-price">€${item.price.toLocaleString('de-DE')}</span>
        </div>
    `).join('');

    // Custom note
    document.getElementById('customNote').classList.toggle('hidden', !hasCustom);

    // Total
    document.getElementById('resultTotal').textContent = `€${total.toLocaleString('de-DE')}`;

    // Rental
    const monthly = Math.ceil(total / 18);
    document.getElementById('rentalPrice').textContent = `~€${monthly}/mo for 18 months`;

    // Package context card
    const info = PACKAGE_INFO[tier];
    document.getElementById('packageContextName').textContent = info.label;
    document.getElementById('packageContextDesc').textContent = info.description;
    document.getElementById('packageContextItems').innerHTML = info.items
        .map(i => `<div class="flex gap-1.5 text-parchment/75"><span class="text-gold mt-0.5">✓</span>${i}</div>`)
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

const LOADING_MESSAGES = [
    { delay: 0,    text: '$ analysing your requirements...',          type: 'prompt' },
    { delay: 1200, text: '  reading scope...',                        type: 'line'   },
    { delay: 2400, text: '  checking feature dependencies...',        type: 'line'   },
    { delay: 3800, text: '$ selecting optimal package...',            type: 'prompt' },
    { delay: 5200, text: '  comparing 5 packages...',                 type: 'line'   },
    { delay: 6800, text: '  applying tier escalation rules...',       type: 'line'   },
    { delay: 8200, text: '$ calculating price breakdown...',          type: 'prompt' },
    { delay: 9600, text: '  summing à-la-carte items...',             type: 'line'   },
    { delay: 11000, text: '  applying package minimums...',           type: 'line'   },
    { delay: 12500, text: '$ finalising your quote...',               type: 'prompt' },
    { delay: 14000, text: '  generating receipt...',                  type: 'line'   },
];

function runLoadingSequence(duration, onComplete) {
    const output   = document.getElementById('terminalOutput');
    const bar      = document.getElementById('loadingBar');
    const pct      = document.getElementById('loadingPct');
    const start    = Date.now();
    const timeouts = [];

    output.innerHTML = '';

    // Type messages
    LOADING_MESSAGES.forEach(msg => {
        if (msg.delay >= duration) return;
        const t = setTimeout(() => {
            const line = document.createElement('div');
            line.className = msg.type === 'prompt' ? 'terminal-prompt' : 'terminal-line';
            line.textContent = msg.text;
            output.appendChild(line);
            output.scrollTop = output.scrollHeight;
        }, msg.delay);
        timeouts.push(t);
    });

    // Progress bar
    const barInterval = setInterval(() => {
        const elapsed  = Date.now() - start;
        const progress = Math.min(95, (elapsed / duration) * 100);
        bar.style.width  = `${progress}%`;
        pct.textContent  = `${Math.round(progress)}%`;
    }, 80);

    // Done line + complete
    const doneTimeout = setTimeout(() => {
        clearInterval(barInterval);
        bar.style.width = '100%';
        pct.textContent = '100%';

        const done = document.createElement('div');
        done.className   = 'terminal-prompt success';
        done.textContent = '✓ quote ready.';
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

// ─── Form validation ──────────────────────────────────────────────────────────

function validateForm(s) {
    const errors = [];
    if (!s.pages)    errors.push('Please select how many pages you need (question 2).');
    if (!s.content)  errors.push('Please choose who writes the content (question 3).');
    if (!s.design)   errors.push('Please choose a design style (question 4).');
    if (!s.languages) errors.push('Please select the number of languages (question 5).');
    if (!s.cms)      errors.push('Please choose whether you want a CMS (question 6).');
    if (!s.hosting)  errors.push('Please choose a hosting option (question 10).');
    return errors;
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

        // Build mailto body
        const state     = getFormState();
        const priceData = calculatePrice(state);
        const tier      = priceData.tier;
        const total     = priceData.total;

        const itemLines = priceData.lineItems
            .map(i => `  • ${i.name}: €${i.price.toLocaleString('de-DE')}`)
            .join('\n');

        const supportText = support === 'none'    ? 'None'
                           : support === 'basic'   ? 'Basic support (+€25/mo)'
                           : 'Advanced support (+€60/mo)';

        const body = [
            `Hi Domen,`,
            ``,
            `I used your pricing calculator and I'd like to discuss a project.`,
            ``,
            `─── QUOTE SUMMARY ───`,
            `Suggested package : ${tier}`,
            `Estimated total   : €${total.toLocaleString('de-DE')} (excl. VAT)`,
            `Ongoing support   : ${supportText}`,
            ``,
            `─── BREAKDOWN ───`,
            itemLines,
            ``,
            state.special_requests
                ? `─── SPECIAL REQUESTS ───\n${state.special_requests}\n`
                : '',
            name    ? `Name   : ${name}`    : '',
            email   ? `E-mail : ${email}`   : '',
            message ? `\nMessage:\n${message}` : '',
            ``,
            `─────────────────────`,
            `Quote #${currentQuoteId || '—'} · generated on ${new Date().toLocaleDateString('en-GB')}`,
        ].filter(l => l !== '').join('\n');

        const subject = encodeURIComponent(`Web development quote — ${tier} package`);
        const bodyEnc = encodeURIComponent(body);
        window.location.href = `mailto:contact@domenhribernik.com?subject=${subject}&body=${bodyEnc}`;

    } catch (err) {
        errEl.textContent = 'Something went wrong saving the quote. You can still email me directly at contact@domenhribernik.com';
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

    btn.addEventListener('click', () => {
        open = !open;
        grid.classList.toggle('hidden', !open);
        label.textContent = open ? 'collapse' : 'expand';
        chevron.style.transform = open ? '' : 'rotate(180deg)';
        btn.setAttribute('aria-expanded', String(open));
    });

    // Collapse by default on mobile
    if (window.innerWidth < 640) {
        open = false;
        grid.classList.add('hidden');
        label.textContent = 'expand';
        chevron.style.transform = 'rotate(180deg)';
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

    btn.addEventListener('click', () => {
        open = !open;
        content.classList.toggle('hidden', !open);
        label.textContent = open ? 'hide' : 'show';
        chevron.style.transform = open ? 'rotate(180deg)' : '';
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
            errEl.textContent = errors[0];
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
});
