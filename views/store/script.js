/* views/store : page wiring for the Everbloom storefront. Decision logic
   lives in logic.js (tested); the bouquet builder is the same one the stall
   uses (../flowers/flowers.js), so the hero is the actual product, not a
   render of it. */

import { buildBouquet } from '../flowers/flowers.js';
import { easeOutCubic, renderTier } from '../flowers/logic.js';
import { attachOrbit, pauseOffscreen } from '../flowers/orbit.js';
import { HERO_ORDER, validateSignup, spotsLine } from './logic.js';

const PROXY = '../../app/proxys/store.php';

const scene = document.getElementById('scene');
const stage = document.getElementById('stage');
const bouquetRoot = document.getElementById('bouquet-root');

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ==========================================================================
   The hero bouquet: build, bloom, orbit.
   ========================================================================== */

const tier = renderTier({ coarse: matchMedia('(pointer: coarse)').matches });
buildBouquet(bouquetRoot, HERO_ORDER, { tier });

const setBloom = (v) => stage.style.setProperty('--bloom', v);

/* Same rAF ramp as the builder and share pages, with the same setTimeout
   fallback because rAF can stall in throttled or background tabs. */
function bloom(duration = 2600) {
    if (reducedMotion) {
        setBloom(1);
        return;
    }
    let done = false;
    const t0 = performance.now();
    (function step(now) {
        if (done) return;
        const t = Math.min(1, (now - t0) / duration);
        setBloom(easeOutCubic(t));
        if (t < 1) requestAnimationFrame(step);
        else done = true;
    })(t0);
    setTimeout(() => {
        if (!done) {
            done = true;
            setBloom(1);
        }
    }, duration + 400);
}

bloom();

/* Orbit: horizontal drags only, so the page still scrolls on touch. The
   autospin wrapper sits inside the stage, so user orbit and idle spin
   compose instead of fighting. Shared driver (rAF-coalesced, now with the
   same release inertia as the other pages); pause it while scrolled away. */
attachOrbit(scene, stage, { axes: 'x', rx0: 0 });
pauseOffscreen(scene);

/* ==========================================================================
   Founding-spots line: only ever prints what the server actually counted.
   On any failure the static default stays.
   ========================================================================== */

fetch(`${PROXY}?action=count`)
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((data) => {
        const line = spotsLine(data.count, data.cap);
        document.getElementById('spots-line').textContent = line.text;
    })
    .catch(() => {});

/* ==========================================================================
   Pricing CTAs preselect their plan in the join form.
   ========================================================================== */

document.querySelectorAll('[data-plan]').forEach((btn) => {
    btn.addEventListener('click', () => {
        const radio = document.querySelector(`input[name="plan"][value="${btn.dataset.plan}"]`);
        if (radio) radio.checked = true;
    });
});

/* ==========================================================================
   The join form.
   ========================================================================== */

const form = document.getElementById('join-form');
const statusEl = document.getElementById('jf-status');
const submitBtn = document.getElementById('jf-submit');

const errorEls = {
    email: document.getElementById('err-email'),
    plan: document.getElementById('err-plan'),
    note: document.getElementById('err-note'),
};

function paintErrors(errors) {
    for (const [key, el] of Object.entries(errorEls)) {
        el.hidden = !errors[key];
        el.textContent = errors[key] || '';
    }
}

form.addEventListener('submit', async (e) => {
    e.preventDefault();
    statusEl.hidden = true;

    const data = Object.fromEntries(new FormData(form));
    const { valid, errors, clean } = validateSignup(data);
    paintErrors(errors);
    if (!valid) return;

    submitBtn.disabled = true;
    try {
        const res = await fetch(PROXY, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...clean, website: data.website ?? '' }),
        });
        const body = await res.json().catch(() => ({}));
        if (res.status === 422 && body.errors) {
            paintErrors(body.errors);
            return;
        }
        if (!res.ok || !body.ok) throw new Error('save_failed');
        form.hidden = true;
        document.getElementById('joined').hidden = false;
    } catch {
        statusEl.textContent = 'The garden gate jammed. Give it a minute and try again.';
        statusEl.hidden = false;
    } finally {
        submitBtn.disabled = false;
    }
});

/* Opt-in on-screen FPS meter for on-device checks (?fps=1). Dynamically
   imported so the cold open stays untouched. */
if (new URLSearchParams(location.search).has('fps')) import('../flowers/fps.js').then((m) => m.mount());
