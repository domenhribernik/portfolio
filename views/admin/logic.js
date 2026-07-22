// Decision logic for the admin dashboard, kept DOM-free so it can be
// unit-tested with `node --test tests/` (no dependencies, no build step).
// script.js imports this as an ES module.

const TABS = ['users', 'projects', 'dashboard', 'leads', 'marketing'];

export function resolveTab(hash) {
    const id = (hash || '').replace(/^#/, '');
    return TABS.includes(id) ? id : 'users';
}

export function filterProjects(projects, query) {
    const q = (query || '').trim().toLowerCase();
    if (!q) return projects;
    return projects.filter(p =>
        p.project_key.toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
}

// Matches name, email, package, or message/special-requests text, so a
// half-remembered detail from a quote is enough to find it again.
export function filterLeads(quotes, query) {
    const q = (query || '').trim().toLowerCase();
    if (!q) return quotes;
    return quotes.filter(quote =>
        (quote.contact_name || '').toLowerCase().includes(q)
        || (quote.contact_email || '').toLowerCase().includes(q)
        || quote.suggested_package.toLowerCase().includes(q)
        || (quote.message || '').toLowerCase().includes(q)
        || (quote.special_requests || '').toLowerCase().includes(q));
}

export function filterDashboardApps(apps, query) {
    const q = (query || '').trim().toLowerCase();
    if (!q) return apps;
    return apps.filter(a =>
        a.name.toLowerCase().includes(q)
        || a.url.toLowerCase().includes(q)
        || (a.project_key || 'everyone').toLowerCase().includes(q));
}

// Returns the sort_order updates that move tile `a` past its neighbor `b`.
// Equal values would swap into a no-op, so `a` nudges past `b` instead.
export function swapPlan(a, b, dir) {
    if (a.sort_order === b.sort_order) {
        return [{ id: a.id, sort_order: b.sort_order + dir }];
    }
    return [
        { id: a.id, sort_order: b.sort_order },
        { id: b.id, sort_order: a.sort_order },
    ];
}

// Converts an HSL triple to a #rrggbb hex string.
// h in [0,360), s and l in [0,100]. Used by randomGradient below and kept
// pure so it can be unit-tested exactly.
export function hslToHex(h, s, l) {
    const sN = s / 100;
    const lN = l / 100;
    const c = (1 - Math.abs(2 * lN - 1)) * sN;
    const hp = (((h % 360) + 360) % 360) / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    const m = lN - c / 2;
    let r = 0, g = 0, b = 0;
    if (hp < 1)      { r = c; g = x; b = 0; }
    else if (hp < 2) { r = x; g = c; b = 0; }
    else if (hp < 3) { r = 0; g = c; b = x; }
    else if (hp < 4) { r = 0; g = x; b = c; }
    else if (hp < 5) { r = x; g = 0; b = c; }
    else             { r = c; g = 0; b = x; }
    const toHex = v => Math.round((v + m) * 255).toString(16).padStart(2, '0');
    return '#' + toHex(r) + toHex(g) + toHex(b);
}

// Builds a random on-theme gradient with a FIXED angle and 0%/100% stops, so
// every generated gradient has "the same distance". The first stop is locked
// to a dark, saturated band (l≈42) so it always works as the dashboard's legible
// border/icon accent on the paper background; the second stop is a lighter,
// hue-shifted companion. `rng` is injectable for deterministic tests.
export function randomGradient(rng = Math.random) {
    const hue = Math.floor(rng() * 360);
    const c1 = hslToHex(hue, 65, 42);
    const c2 = hslToHex(hue + 35, 70, 62);
    return `linear-gradient(45deg, ${c1} 0%, ${c2} 100%)`;
}

// Extracts the first hex color from a stored gradient string to use as the
// flat accent (border/icon) on the dashboard and in the admin tile list. Falls back
// to ink when the gradient has no hex color. Mirrors the same one-liner the
// dashboard view uses inline; kept here so it can be unit-tested.
export function accentFromGradient(gradient) {
    const m = /#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/.exec(gradient || '');
    return m ? m[0] : '#1c1a17';
}

// ── Marketing: promo message builder ──────────────────────────────────────
// The pricing page is unlisted, so a lead only finds it via a link we send.
// A promo is either GENERIC (cold outreach: pitch the calculator so the
// prospect builds their own baseline) or PERSONALIZED (an existing lead: remind
// them of the package and estimate they already saw, then invite a negotiation
// from that number). There is no email server anywhere in this codebase, so
// delivery is the owner's own mail client (promoMailtoHref) or the clipboard.

export const PRICING_URL = 'https://domenhribernik.com/views/pricing/';

// Copy is kept out here so buildPromoMessage stays a pure lookup + interpolation
// and the whole thing is trivially unit-testable. House style: no em dashes.
const PROMO_COPY = {
    en: {
        genericSubject: 'A baseline for your website project',
        genericBody: (url) => [
            'Hi,',
            '',
            'Thanks for your interest in working together. Before we talk numbers, I built an interactive pricing calculator so you can see roughly what a project like yours costs and exactly what is included at each level:',
            '',
            url,
            '',
            'Answer a few questions and it puts together an itemized estimate in about a minute. Treat it as a starting point for our conversation, not a fixed quote, so we can shape the scope around your budget from there.',
            '',
            'Happy to jump on a call whenever you are ready.',
            '',
            'Domen',
        ].join('\n'),
        personalSubject: (pkg, total) => `Your website estimate: around ${total}`,
        personalBody: (greetName, pkg, total, url) => [
            greetName ? `Hi ${greetName},` : 'Hi,',
            '',
            `Thanks again for trying the pricing calculator. Based on what you told me, your project lands around the ${pkg} package, roughly ${total} excl. VAT. Here is the full breakdown and everything included at that level:`,
            '',
            url,
            '',
            'Treat it as a baseline rather than a final number. We can move the scope up or down to fit your budget, so tell me what feels right and we will take it from there.',
            '',
            'Domen',
        ].join('\n'),
    },
    sl: {
        genericSubject: 'Izhodišče za vašo spletno stran',
        genericBody: (url) => [
            'Pozdravljeni,',
            '',
            'Hvala za zanimanje za sodelovanje. Preden se pogovoriva o ceni, sem pripravil interaktivni cenovni kalkulator, kjer vidite, koliko približno stane projekt, kot je vaš, in kaj je vključeno na vsaki ravni:',
            '',
            url,
            '',
            'Odgovorite na nekaj vprašanj in v približno minuti sestavi razčlenjeno oceno. Vzemite jo kot izhodišče za pogovor, ne kot dokončno ponudbo, tako da obseg prilagodiva vašemu proračunu.',
            '',
            'Z veseljem se slišiva po telefonu, ko vam ustreza.',
            '',
            'Domen',
        ].join('\n'),
        personalSubject: (pkg, total) => `Vaša ocena za spletno stran: okoli ${total}`,
        personalBody: (greetName, pkg, total, url) => [
            greetName ? `Živjo ${greetName},` : 'Pozdravljeni,',
            '',
            `Hvala, da ste preizkusili cenovni kalkulator. Glede na vaše odgovore vaš projekt sodi približno v paket ${pkg}, okoli ${total} brez DDV. Tukaj je celotna razčlenitev in vse, kar je vključeno na tej ravni:`,
            '',
            url,
            '',
            'Vzemite to kot izhodišče in ne kot dokončno številko. Obseg lahko prilagodiva navzgor ali navzdol glede na vaš proračun, zato mi povejte, kaj se vam zdi pravo, in nadaljujeva od tam.',
            '',
            'Domen',
        ].join('\n'),
    },
};

// Builds the subject + body for a promo email. A lead is "personalized" when we
// have both a package and an estimate to anchor on; otherwise it is the generic
// cold-outreach pitch. Unknown languages fall back to English.
export function buildPromoMessage({ lang = 'en', name = '', pkg = '', total = '', url = PRICING_URL } = {}) {
    const copy = PROMO_COPY[lang] || PROMO_COPY.en;
    const personalized = !!(pkg && total);
    if (personalized) {
        return {
            subject: copy.personalSubject(pkg, total),
            body: copy.personalBody((name || '').trim(), pkg, total, url),
        };
    }
    return { subject: copy.genericSubject, body: copy.genericBody(url) };
}

// A mailto: link the owner's own mail client opens, pre-filled. No email is sent
// server-side (this codebase has no MTA); the owner presses send. An empty
// address still yields a valid mailto so the owner can fill in the recipient.
export function promoMailtoHref({ email = '', subject = '', body = '' } = {}) {
    return `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

// Blank icon/gradient are omitted so the controller's defaults apply.
// is_default marks the tile for seeding onto every NEW user's shelf.
export function buildDashboardPayload({ name, url, icon, gradient, project, sort, isDefault }) {
    const body = {
        name: name.trim(),
        url: url.trim(),
        project_id: project === '' ? null : Number(project),
        sort_order: Number(sort) || 0,
        is_default: !!isDefault,
    };
    if (icon.trim()) body.icon = icon.trim();
    if (gradient.trim()) body.gradient = gradient.trim();
    return body;
}
