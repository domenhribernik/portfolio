// <beseda-widget> — the Slovenian word of the day, embeddable anywhere.
//
// Follows the rocks-showcase pattern: no shadow DOM (so the host page's fonts
// and colours flow in and it looks like it belongs), attribute-configured, and
// every URL resolved from import.meta.url so it works from any host depth.
//
// It shares the `beseda-streak` localStorage key and the streak maths with the
// full page at views/beseda, so the two always agree, and it listens for
// storage events so practising in one tab updates the other.
//
// Usage:
//   <script type="module" src=".../components/beseda/beseda-widget.js"></script>
//   <beseda-widget show-streak="true"></beseda-widget>
//
// Attributes:
//   show-streak  — "false" hides the streak line (default shows it)
//   accent       — CSS colour for the streak mark and links (default #d4451f)
//   href         — where "practise" links to (default resolves to /views/beseda/)

import {
    todayIso, wordOfTheDay, glossSegments, streakStats, addDay, mergeDays, validDays,
} from './logic.js';

const DATA = new URL('../../views/beseda/data/', import.meta.url).href;
const API = new URL('../../app/controllers/beseda-controller.php', import.meta.url).href;
const PAGE = new URL('../../views/beseda/', import.meta.url).href;
const STORE_KEY = 'beseda-streak';

let dataPromise = null;
/** Fetched once per page even if several widgets are mounted. */
function loadData() {
    if (!dataPromise) {
        dataPromise = Promise.all(
            ['daily', 'words', 'sentences'].map(async (name) => {
                const response = await fetch(`${DATA}${name}.json`);
                if (!response.ok) throw new Error(`${name}.json (${response.status})`);
                return response.json();
            }),
        ).then(([daily, words, sentences]) => ({
            daily,
            words: words.words,
            sentences: sentences.sentences,
        }));
    }
    return dataPromise;
}

let stylesInjected = false;
function injectStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    const style = document.createElement('style');
    // Every class is prefixed: there is no shadow DOM, so these share a
    // namespace with whatever page is hosting the widget.
    //
    // Sizes are in `em`, not `rem`, on purpose. The widget is a guest: on the
    // iliana page it sits inside a Poppins card, and this file has no business
    // importing the portfolio's own type ramp into someone else's system. Ems
    // make it scale with whatever the host already set.
    style.textContent = `
.beseda-w { display: block; line-height: 1.6; }
.beseda-w__label { font-size: 0.78em; letter-spacing: 0.16em; text-transform: uppercase;
    opacity: 0.55; margin-bottom: 0.5em; }
.beseda-w__word { font-size: clamp(1.9em, 7vw, 2.7em); font-weight: 700; line-height: 1.05;
    margin: 0 0 0.2em; word-break: break-word; }
.beseda-w__meta { font-size: 0.78em; letter-spacing: 0.08em; text-transform: uppercase;
    opacity: 0.5; margin-bottom: 0.75em; }
.beseda-w__gloss { font-size: 1.15em; margin-bottom: 1.2em; }
.beseda-w__sentence { margin: 0 0 0.4em; }
.beseda-w__en { font-size: 0.92em; opacity: 0.6; margin: 0; }
.beseda-w__gl { border-bottom: 1px dotted currentColor; cursor: help; }
.beseda-w__gl:hover, .beseda-w__gl:focus-visible { background: rgba(28, 26, 23, 0.08); outline: none; }
.beseda-w__foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;
    gap: 0.75em; margin-top: 1.35em; padding-top: 1em; border-top: 1px solid rgba(28, 26, 23, 0.12); }
.beseda-w__streak { display: inline-flex; align-items: center; gap: 0.45em; font-size: 0.92em; }
.beseda-w__flame { width: 1.05em; height: 1.05em; flex-shrink: 0; }
.beseda-w__count { font-weight: 700; }
.beseda-w__go { font-size: 0.88em; text-decoration: none; border-bottom: 1px solid currentColor;
    padding-bottom: 1px; transition: opacity 0.15s ease-out; }
.beseda-w__go:hover { opacity: 0.65; }
.beseda-w__done { border: 0; background: none; padding: 0; font: inherit; font-size: 0.88em;
    cursor: pointer; text-decoration: none; border-bottom: 1px solid currentColor; }
.beseda-w__done[disabled] { cursor: default; opacity: 0.55; border-bottom-color: transparent; }
.beseda-w__quiet { opacity: 0.6; font-size: 0.9em; }
.beseda-w__tip { position: absolute; z-index: 60; max-width: 18rem; padding: 0.45em 0.65em;
    background: #1c1a17; color: #f6f2ea; font-size: 1rem; line-height: 1.35; border-radius: 4px;
    box-shadow: 0 6px 18px rgba(28, 26, 23, 0.22); opacity: 0; visibility: hidden; pointer-events: none;
    transition: opacity 0.12s ease-out, visibility 0.12s; }
.beseda-w__tip.is-open { opacity: 1; visibility: visible; }
.beseda-w__tip strong { display: block; font-size: 0.72rem; letter-spacing: 0.1em;
    text-transform: uppercase; opacity: 0.7; }
@media (prefers-reduced-motion: reduce) {
    .beseda-w__go, .beseda-w__tip { transition: none; }
}`;
    document.head.append(style);
}

let tooltip = null;
function ensureTooltip() {
    if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.className = 'beseda-w__tip';
        tooltip.setAttribute('role', 'tooltip');
        document.body.append(tooltip);
    }
    return tooltip;
}

class BesedaWidget extends HTMLElement {
    connectedCallback() {
        injectStyles();
        this.classList.add('beseda-w');
        this._accent = this.getAttribute('accent') || '#d4451f';
        this._showStreak = this.getAttribute('show-streak') !== 'false';
        this._days = this._readDays();

        this._onStorage = (e) => {
            if (e.key !== STORE_KEY) return;
            this._days = this._readDays();
            this._renderStreak();
        };
        window.addEventListener('storage', this._onStorage);

        this._boot();
    }

    disconnectedCallback() {
        window.removeEventListener('storage', this._onStorage);
        if (this._hideTip) {
            document.removeEventListener('pointerover', this._pointerHandler);
            document.removeEventListener('click', this._clickHandler);
        }
    }

    _readDays() {
        try {
            return validDays(JSON.parse(localStorage.getItem(STORE_KEY) || '{}').days, todayIso());
        } catch {
            return [];
        }
    }

    _writeDays() {
        try {
            localStorage.setItem(STORE_KEY, JSON.stringify({ days: this._days }));
        } catch {
            // Nothing to do: the streak is a nicety, not the content.
        }
    }

    async _boot() {
        let data;
        try {
            data = await loadData();
        } catch (err) {
            // Fail quiet: a broken widget must not disfigure its host page.
            console.warn('beseda-widget: could not load content', err);
            this.remove();
            return;
        }
        this._data = data;

        const pick = wordOfTheDay(data.daily, todayIso());
        if (!pick || !data.words[pick.wordIndex]) {
            console.warn('beseda-widget: no word scheduled for today');
            this.remove();
            return;
        }
        this._render(pick);
        this._sync();
    }

    _render(pick) {
        const { words, sentences } = this._data;
        const word = words[pick.wordIndex];
        this.replaceChildren();

        const label = document.createElement('p');
        label.className = 'beseda-w__label';
        label.textContent = 'Beseda dneva';

        const heading = document.createElement('p');
        heading.className = 'beseda-w__word';
        heading.textContent = word[0];

        const meta = document.createElement('p');
        meta.className = 'beseda-w__meta';
        meta.textContent = word[3] ? `${word[2]}, ${word[3]}.` : word[2];

        const gloss = document.createElement('p');
        gloss.className = 'beseda-w__gloss';
        gloss.textContent = word[1];

        this.append(label, heading, meta, gloss);

        const sentence = sentences[pick.sentences[0]];
        if (sentence) {
            const line = document.createElement('p');
            line.className = 'beseda-w__sentence';
            for (const segment of glossSegments(sentence)) {
                if (segment.wordIndex === null || !words[segment.wordIndex]) {
                    line.append(document.createTextNode(segment.text));
                    continue;
                }
                const span = document.createElement('span');
                span.className = 'beseda-w__gl';
                span.textContent = segment.text;
                span.tabIndex = 0;
                span.dataset.gloss = words[segment.wordIndex][1];
                span.dataset.lemma = words[segment.wordIndex][0];
                span.setAttribute('aria-label', `${segment.text}: ${words[segment.wordIndex][1]}`);
                line.append(span);
            }
            const english = document.createElement('p');
            english.className = 'beseda-w__en';
            english.textContent = sentence[1];
            this.append(line, english);
        }

        const foot = document.createElement('div');
        foot.className = 'beseda-w__foot';

        if (this._showStreak) {
            this._streakEl = document.createElement('span');
            this._streakEl.className = 'beseda-w__streak';
            foot.append(this._streakEl);
        }

        const actions = document.createElement('span');
        actions.style.display = 'inline-flex';
        actions.style.gap = '1rem';
        actions.style.alignItems = 'center';

        this._doneBtn = document.createElement('button');
        this._doneBtn.type = 'button';
        this._doneBtn.className = 'beseda-w__done';
        this._doneBtn.style.color = this._accent;
        this._doneBtn.addEventListener('click', () => this._markToday());

        const go = document.createElement('a');
        go.className = 'beseda-w__go';
        go.href = this.getAttribute('href') || PAGE;
        go.style.color = this._accent;
        go.textContent = 'Practise more';

        actions.append(this._doneBtn, go);
        foot.append(actions);
        this.append(foot);

        this._renderStreak();
        this._wireTooltip();
    }

    _renderStreak() {
        if (!this._doneBtn) return;
        const stats = streakStats(this._days, todayIso());

        if (this._streakEl) {
            this._streakEl.replaceChildren();
            const flame = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            flame.setAttribute('viewBox', '0 0 24 24');
            flame.setAttribute('fill', 'currentColor');
            flame.setAttribute('aria-hidden', 'true');
            flame.classList.add('beseda-w__flame');
            flame.style.color = this._accent;
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', 'M12 2c.4 3.3-1.6 4.6-2.8 6C7.7 9.7 7 11.2 7 13a5 5 0 0 0 10 0c0-2.3-1.2-3.6-2.3-5-.4 1-1 1.7-1.8 2 .4-2.6-.5-5.6-.9-8Z');
            flame.append(path);

            const count = document.createElement('span');
            count.className = 'beseda-w__count';
            count.textContent = String(stats.current);

            const unit = document.createElement('span');
            unit.className = 'beseda-w__quiet';
            unit.textContent = stats.current === 1 ? 'day streak' : 'day streak';

            this._streakEl.append(flame, count, unit);
        }

        this._doneBtn.disabled = stats.activeToday;
        this._doneBtn.textContent = stats.activeToday ? 'Learned today' : 'Mark as learned';
    }

    _markToday() {
        const today = todayIso();
        if (this._days.includes(today)) return;
        this._days = addDay(this._days, today);
        this._writeDays();
        this._renderStreak();
        if (this._signedIn) this._post([today]).catch(() => {});
    }

    async _post(days) {
        const response = await fetch(`${API}?resource=streak`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ days }),
        });
        if (!response.ok) throw new Error(String(response.status));
        return validDays((await response.json()).days, todayIso());
    }

    /** Merge with the account's history if there is one. Never blocks the render. */
    async _sync() {
        try {
            const session = await (await fetch(`${API}?resource=session`)).json();
            if (!session || session.demo) return;
            this._signedIn = true;
            this._days = mergeDays(this._days, await this._post(this._days));
            this._writeDays();
            this._renderStreak();
        } catch {
            // Offline, or no backend on this host. The local streak still works.
        }
    }

    _wireTooltip() {
        const tip = ensureTooltip();
        let open = null;

        const show = (target) => {
            tip.replaceChildren();
            const lemma = document.createElement('strong');
            lemma.textContent = target.dataset.lemma;
            tip.append(lemma, document.createTextNode(target.dataset.gloss));
            tip.classList.add('is-open');

            const rect = target.getBoundingClientRect();
            const tipRect = tip.getBoundingClientRect();
            const margin = 8;
            const maxLeft = window.scrollX + document.documentElement.clientWidth - tipRect.width - margin;
            const left = Math.max(window.scrollX + margin,
                Math.min(rect.left + window.scrollX + rect.width / 2 - tipRect.width / 2, maxLeft));
            const above = rect.top - tipRect.height - margin;
            tip.style.left = `${left}px`;
            tip.style.top = `${above > 0 ? above + window.scrollY : rect.bottom + margin + window.scrollY}px`;
            open = target;
        };

        const hide = () => {
            tip.classList.remove('is-open');
            open = null;
        };

        this._pointerHandler = (e) => {
            const target = e.target.closest?.('.beseda-w__gl');
            if (target && this.contains(target)) show(target);
            else if (open) hide();
        };
        this._clickHandler = (e) => {
            const target = e.target.closest?.('.beseda-w__gl');
            if (target && this.contains(target)) {
                if (open === target) hide();
                else show(target);
            } else if (open) {
                hide();
            }
        };
        this._hideTip = hide;

        document.addEventListener('pointerover', this._pointerHandler);
        document.addEventListener('click', this._clickHandler);
        this.addEventListener('focusin', (e) => {
            const target = e.target.closest?.('.beseda-w__gl');
            if (target) show(target);
        });
        this.addEventListener('focusout', hide);
    }
}

customElements.define('beseda-widget', BesedaWidget);
