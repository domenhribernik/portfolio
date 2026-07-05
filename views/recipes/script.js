import { loginUrl } from '../../components/auth-gate.js';
import {
    parseTokens, usedIngredientKeys, nextIngKey, replaceTokenWithText,
    validateDraft, buildPayload, fmtTimer, timerState,
    createCookSession, advance, back, isLastStep, starFill, avgLabel,
} from './logic.js';

const API = '../../app/controllers/recipes-controller.php';

// --- State ---
let viewer = null;
let isDemo = true;
let recipes = [];
let listLoaded = false;
let currentRecipe = null;
let draft = null;          // editor working copy
let lastStepFocus = null;  // {idx, pos} caret in the last focused step textarea
let cook = null;           // {phase, checked, session, endAt, rang}
let tickInterval = null;
let wakeLock = null;
let audioCtx = null;
let audioUnlocked = false;
let deleteBusy = false;

// --- DOM refs ---
const $ = (id) => document.getElementById(id);
const signinBtn      = $('signinBtn');
const accountChip    = $('accountChip');
const accountAvatar  = $('accountAvatar');
const accountName    = $('accountName');
const newRecipeBtn   = $('newRecipeBtn');
const listHint       = $('listHint');
const listSigninLink = $('listSigninLink');
const listLoading    = $('listLoading');
const listEmpty      = $('listEmpty');
const listError      = $('listError');
const listErrorMsg   = $('listErrorMsg');
const recipeGrid     = $('recipeGrid');
const detailBody     = $('detailBody');
const cookTitle      = $('cookTitle');
const cookChecklist  = $('cookChecklist');
const cookSteps      = $('cookSteps');
const cookDone       = $('cookDone');
const editorHeading  = $('editorHeading');
const titleInput     = $('titleInput');
const descInput      = $('descInput');
const coverInput     = $('coverInput');
const coverPreview   = $('coverPreview');
const ingRows        = $('ingRows');
const stepRows       = $('stepRows');
const usedCount      = $('usedCount');
const editorErrors   = $('editorErrors');
const editorSaveBtn  = $('editorSaveBtn');
const deleteModal    = $('deleteModal');
const deleteRecipeName = $('deleteRecipeName');
const toastContainer = $('toastContainer');

// --- Utilities ---
function esc(s) {
    if (s === null || s === undefined) return '';
    const div = document.createElement('div');
    div.textContent = String(s);
    return div.innerHTML;
}

function fmtDate(sql) {
    if (!sql) return '';
    const d = new Date(String(sql).replace(' ', 'T'));
    return isNaN(d) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function fmtDurationHuman(seconds) {
    const m = Math.round(seconds / 60);
    if (m < 1) return `${seconds} s`;
    const h = Math.floor(m / 60);
    const r = m % 60;
    if (h > 0) return r ? `${h} h ${r} min` : `${h} h`;
    return `${m} min`;
}

function toast(message, isError = false) {
    const el = document.createElement('div');
    el.className = 'toast' + (isError ? ' toast-error' : '');
    el.textContent = message;
    toastContainer.appendChild(el);
    setTimeout(() => el.remove(), 4000);
}

function detailLoginUrl() {
    return loginUrl(location.pathname + location.search);
}

// --- API ---
async function api(url, options = {}) {
    const res = await fetch(url, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const err = new Error(data.error || `Request failed (${res.status})`);
        err.status = res.status;
        if (res.status === 401) handleAuthLoss();
        throw err;
    }
    return data;
}

function handleAuthLoss() {
    if (isDemo) return;
    isDemo = true;
    viewer = null;
    updateAuthUI();
    toast('Your session expired. Sign in again to continue.', true);
}

function adoptEnvelope(data) {
    isDemo = !!data.demo;
    viewer = data.viewer || null;
    updateAuthUI();
}

// --- Auth UI ---
function updateAuthUI() {
    if (isDemo) {
        signinBtn.href = loginUrl();
        listSigninLink.href = loginUrl();
        signinBtn.style.display = 'inline-flex';
        accountChip.style.display = 'none';
        listHint.style.display = 'inline-flex';
        newRecipeBtn.classList.add('hidden');
        return;
    }
    signinBtn.style.display = 'none';
    listHint.style.display = 'none';
    newRecipeBtn.classList.remove('hidden');
    const name = (viewer && viewer.display_name) || 'Account';
    accountName.textContent = name.split(' ')[0];
    accountAvatar.innerHTML = viewer && viewer.avatar_url
        ? `<img src="${esc(viewer.avatar_url)}" alt="" class="w-full h-full object-cover" referrerpolicy="no-referrer">`
        : '<i class="fas fa-user"></i>';
    accountChip.style.display = 'inline-flex';
}

// --- Screens and routing ---
function showScreen(name) {
    document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === name + 'Screen'));
    window.scrollTo(0, 0);
}

function goList(push = true) {
    if (push) history.pushState({}, '', location.pathname);
    stopCooking();
    showScreen('list');
    if (!listLoaded) loadList();
}

async function openRecipe(id, push = true) {
    stopCooking();
    showScreen('detail');
    detailBody.innerHTML = '<div class="flex justify-center py-20"><div class="loading-spinner"></div></div>';
    if (push) history.pushState({}, '', `?id=${id}`);
    try {
        const data = await api(`${API}?resource=recipe&id=${id}`);
        adoptEnvelope(data);
        currentRecipe = data.recipe;
        renderDetail();
    } catch (e) {
        detailBody.innerHTML = `
            <div class="border border-emberdk/40 bg-ember/10 text-emberdk rounded-xl p-4">
                <p class="font-medium m-0">${esc(e.message)}</p>
            </div>`;
    }
}

window.addEventListener('popstate', () => {
    const id = new URLSearchParams(location.search).get('id');
    if (id) openRecipe(parseInt(id, 10), false);
    else goList(false);
});

// --- Stars ---
function starsHTML(avg, sizeClass = 'text-sm') {
    const icons = starFill(avg).map(fill => {
        if (fill === 'full') return '<i class="fa-solid fa-star"></i>';
        if (fill === 'half') return '<i class="fa-solid fa-star-half-stroke"></i>';
        return '<i class="fa-regular fa-star"></i>';
    }).join('');
    return `<span class="text-ember ${sizeClass} tracking-tight whitespace-nowrap">${icons}</span>`;
}

function ratingButtonsHTML(current, sizeClass = 'text-2xl') {
    let html = '<div class="rating-row inline-flex items-center gap-1.5">';
    for (let n = 1; n <= 5; n++) {
        const solid = n <= (current || 0);
        html += `<button type="button" data-stars="${n}" aria-label="${n} star${n > 1 ? 's' : ''}"
                    class="text-ember ${sizeClass} hover:scale-110 transition-transform">
                    <i class="${solid ? 'fa-solid' : 'fa-regular'} fa-star pointer-events-none"></i>
                 </button>`;
    }
    return html + '</div>';
}

/** Wire hover preview + click on a freshly rendered .rating-row element. */
function setupRatingRow(row, getCurrent, onRate) {
    const paint = (upTo) => {
        row.querySelectorAll('[data-stars]').forEach(btn => {
            const icon = btn.querySelector('i');
            icon.className = (+btn.dataset.stars <= upTo ? 'fa-solid' : 'fa-regular') + ' fa-star pointer-events-none';
        });
    };
    row.addEventListener('mouseover', e => {
        const btn = e.target.closest('[data-stars]');
        if (btn) paint(+btn.dataset.stars);
    });
    row.addEventListener('mouseleave', () => paint(getCurrent() || 0));
    row.addEventListener('click', e => {
        const btn = e.target.closest('[data-stars]');
        if (btn) onRate(+btn.dataset.stars);
    });
}

async function postRating(stars) {
    const data = await api(`${API}?resource=rating&id=${currentRecipe.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stars }),
    });
    currentRecipe.avg_rating = data.avg_rating;
    currentRecipe.rating_count = data.rating_count;
    currentRecipe.my_rating = data.my_rating;
    return data;
}

// --- Step body rendering ({ing:K} tokens -> chips) ---
function stepBodyHTML(body, ingredients) {
    const byKey = new Map((ingredients || []).map(i => [i.key, i]));
    return parseTokens(body).map(part => {
        if (part.type === 'text') return esc(part.text);
        const ing = byKey.get(part.key);
        if (!ing) return '';
        const qty = String(ing.quantity || '').trim();
        return `<span class="ing-chip">${esc(ing.name)}${qty ? `<span class="ing-chip-qty">${esc(qty)}</span>` : ''}</span>`;
    }).join('');
}

// --- Cover art ---
const PLACEHOLDER_GRADIENTS = [
    'linear-gradient(135deg, #e0731d 0%, #f3e3c3 100%)',
    'linear-gradient(135deg, #b85a10 0%, #e8dcc4 100%)',
    'linear-gradient(135deg, #6b6256 0%, #e0d7c4 100%)',
    'linear-gradient(135deg, #c8741a 0%, #f9f1e1 100%)',
];

function coverHTML(recipe, heightClass) {
    if (recipe.image_url) {
        return `<img src="../../${esc(recipe.image_url)}" alt="" loading="lazy"
                     class="w-full ${heightClass} object-cover">`;
    }
    const gradient = PLACEHOLDER_GRADIENTS[recipe.id % PLACEHOLDER_GRADIENTS.length];
    const initial = (recipe.title || '?').trim().charAt(0).toUpperCase();
    return `<div class="w-full ${heightClass} flex items-center justify-center" style="background:${gradient}">
                <span class="font-display italic font-semibold text-5xl text-card/80 select-none">${esc(initial)}</span>
            </div>`;
}

function authorHTML(recipe) {
    const avatar = recipe.author_avatar
        ? `<img src="${esc(recipe.author_avatar)}" alt="" referrerpolicy="no-referrer" class="w-5 h-5 rounded-full object-cover">`
        : '<span class="w-5 h-5 rounded-full bg-cocoa/20 text-cocoa flex items-center justify-center text-[9px]"><i class="fas fa-user"></i></span>';
    return `<span class="inline-flex items-center gap-1.5 text-sm text-cocoa">${avatar}${esc(recipe.author)}</span>`;
}

// --- List screen ---
async function loadList() {
    listLoading.style.display = 'flex';
    listError.classList.add('hidden');
    try {
        const data = await api(`${API}?resource=recipes`);
        adoptEnvelope(data);
        recipes = data.recipes;
        listLoaded = true;
        renderList();
    } catch (e) {
        listErrorMsg.textContent = e.message;
        listError.classList.remove('hidden');
        recipeGrid.classList.add('hidden');
        listEmpty.classList.add('hidden');
    } finally {
        listLoading.style.display = 'none';
    }
}

function renderList() {
    if (recipes.length === 0) {
        listEmpty.classList.remove('hidden');
        recipeGrid.classList.add('hidden');
        return;
    }
    listEmpty.classList.add('hidden');
    recipeGrid.classList.remove('hidden');
    recipeGrid.innerHTML = recipes.map(r => `
        <article data-id="${r.id}" class="group bg-card border border-linen rounded-2xl overflow-hidden cursor-pointer
                        hover:shadow-lift hover:-translate-y-0.5 transition-all">
            <div class="relative overflow-hidden">
                ${coverHTML(r, 'h-40')}
                ${r.mine ? '<span class="absolute top-2 right-2 bg-ink/80 text-beige text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full">Yours</span>' : ''}
            </div>
            <div class="p-4">
                <h3 class="font-display font-semibold text-xl leading-snug tracking-tight m-0 group-hover:text-emberdk transition-colors">${esc(r.title)}</h3>
                <div class="flex items-center justify-between gap-2 mt-2">
                    ${authorHTML(r)}
                    <span class="inline-flex items-center gap-1.5">${starsHTML(r.avg_rating, 'text-xs')}
                        <span class="text-xs text-cocoa">${esc(avgLabel(r.avg_rating, r.rating_count))}</span></span>
                </div>
                ${r.description ? `<p class="text-sm text-cocoa mt-2 mb-0 line-clamp-2">${esc(r.description)}</p>` : ''}
            </div>
        </article>
    `).join('');
}

recipeGrid.addEventListener('click', e => {
    const card = e.target.closest('[data-id]');
    if (card) openRecipe(parseInt(card.dataset.id, 10));
});
$('listRetryBtn').addEventListener('click', loadList);
$('backToListBtn').addEventListener('click', () => goList());

// --- Detail screen ---
function renderDetail() {
    const r = currentRecipe;
    const hasTimers = r.steps.some(s => s.duration_seconds);
    detailBody.innerHTML = `
        <div class="rounded-2xl overflow-hidden border border-linen mb-6">${coverHTML(r, 'h-52 sm:h-64')}</div>

        <div class="flex items-start justify-between gap-4 flex-wrap">
            <div class="min-w-0">
                <h2 class="font-display font-semibold text-3xl sm:text-4xl leading-tight tracking-tight m-0">${esc(r.title)}</h2>
                <div class="flex items-center gap-3 flex-wrap mt-2">
                    ${authorHTML(r)}
                    <span class="text-cocoa/50 select-none">·</span>
                    <span class="inline-flex items-center gap-1.5">${starsHTML(r.avg_rating)}
                        <span class="text-sm text-cocoa">${esc(avgLabel(r.avg_rating, r.rating_count))}</span></span>
                    <span class="text-cocoa/50 select-none">·</span>
                    <span class="text-sm text-cocoa">${esc(fmtDate(r.created_at))}</span>
                </div>
            </div>
            ${r.can_edit ? `
            <div class="flex gap-2 shrink-0">
                <button id="editRecipeBtn" class="border border-linen bg-card hover:border-ember/60 text-ink text-sm font-semibold px-3.5 py-2 rounded-xl transition-colors">
                    <i class="fas fa-pen mr-1.5 text-ember"></i>Edit</button>
                <button id="deleteRecipeBtn" class="border border-linen bg-card hover:border-emberdk/60 text-cocoa text-sm font-semibold px-3.5 py-2 rounded-xl transition-colors">
                    <i class="fas fa-trash-can mr-1.5"></i>Delete</button>
            </div>` : ''}
        </div>

        ${r.description ? `<p class="text-cocoa text-base sm:text-lg max-w-2xl mt-3 mb-0">${esc(r.description)}</p>` : ''}

        <button id="startCookingBtn" class="mt-6 bg-ember hover:bg-emberdk text-card font-semibold text-lg px-7 py-3 rounded-2xl shadow-lift transition-colors">
            <i class="fas fa-fire-burner mr-2.5"></i>Start cooking
        </button>
        ${hasTimers ? '<p class="text-xs text-cocoa mt-2">Cooking mode keeps the screen awake and rings a bell when a timer runs out.</p>' : ''}

        <div class="grid grid-cols-1 md:grid-cols-[2fr,3fr] gap-6 items-start mt-8">
            <div class="bg-card border border-linen rounded-2xl p-5 sm:p-6">
                <h3 class="font-display font-semibold text-xl mt-0 mb-3">Ingredients</h3>
                <ul class="list-none m-0 p-0 divide-y divide-linen/70">
                    ${r.ingredients.map(i => `
                        <li class="flex items-baseline justify-between gap-3 py-2">
                            <span>${esc(i.name)}</span>
                            <span class="font-mono text-sm text-cocoa whitespace-nowrap">${esc(i.quantity)}</span>
                        </li>`).join('')}
                </ul>
            </div>
            <div class="bg-card border border-linen rounded-2xl p-5 sm:p-6">
                <h3 class="font-display font-semibold text-xl mt-0 mb-3">Method</h3>
                <ol class="list-none m-0 p-0 flex flex-col gap-4">
                    ${r.steps.map((s, i) => `
                        <li class="flex gap-3.5">
                            <span class="font-display italic font-semibold text-ember text-xl leading-none pt-0.5 w-7 shrink-0 text-right select-none">${i + 1}</span>
                            <div class="min-w-0">
                                <p class="m-0 leading-relaxed">${stepBodyHTML(s.body, r.ingredients)}</p>
                                ${s.duration_seconds ? `<span class="inline-flex items-center gap-1.5 mt-1.5 font-mono text-xs text-emberdk bg-ember/10 border border-ember/25 rounded-full px-2.5 py-0.5">
                                    <i class="fas fa-stopwatch"></i>${esc(fmtDurationHuman(s.duration_seconds))}</span>` : ''}
                            </div>
                        </li>`).join('')}
                </ol>
            </div>
        </div>

        <div id="ratingWidget" class="bg-card border border-linen rounded-2xl p-5 sm:p-6 mt-6"></div>
    `;

    renderRatingWidget();
    $('startCookingBtn').addEventListener('click', enterCookMode);
    if (r.can_edit) {
        $('editRecipeBtn').addEventListener('click', () => openEditor(r));
        $('deleteRecipeBtn').addEventListener('click', () => {
            deleteRecipeName.textContent = r.title;
            deleteModal.classList.add('active');
        });
    }
}

function renderRatingWidget() {
    const widget = $('ratingWidget');
    if (!widget) return;
    const r = currentRecipe;
    if (isDemo) {
        widget.innerHTML = `
            <h3 class="font-display font-semibold text-xl mt-0 mb-1">Rate this recipe</h3>
            <p class="text-sm text-cocoa m-0"><i class="fas fa-lock mr-1.5"></i>
                <a href="${esc(detailLoginUrl())}" class="text-emberdk font-semibold underline decoration-ember/40 hover:decoration-ember">Sign in</a>
                to leave a rating once you've cooked it.</p>`;
        return;
    }
    if (r.mine) {
        widget.innerHTML = `
            <h3 class="font-display font-semibold text-xl mt-0 mb-1">Rate this recipe</h3>
            <p class="text-sm text-cocoa m-0"><i class="fas fa-utensils mr-1.5"></i>This one's yours. Other cooks get to do the judging.</p>`;
        return;
    }
    widget.innerHTML = `
        <h3 class="font-display font-semibold text-xl mt-0 mb-1">${r.my_rating ? 'Your rating' : 'Rate this recipe'}</h3>
        <p class="text-sm text-cocoa mt-0 mb-3">${r.my_rating ? 'Tap a star to change it.' : 'Cooked it? Tell everyone how it went.'}</p>
        ${ratingButtonsHTML(r.my_rating)}`;
    setupRatingRow(widget.querySelector('.rating-row'), () => currentRecipe.my_rating, async (stars) => {
        try {
            await postRating(stars);
            renderDetail();
            toast('Thanks for rating!');
        } catch (e) {
            toast(e.message, true);
        }
    });
}

// --- Delete modal ---
$('deleteCancelBtn').addEventListener('click', () => deleteModal.classList.remove('active'));
deleteModal.addEventListener('click', e => { if (e.target === deleteModal) deleteModal.classList.remove('active'); });
$('deleteConfirmBtn').addEventListener('click', async () => {
    if (deleteBusy || !currentRecipe) return;
    deleteBusy = true;
    try {
        await api(`${API}?resource=recipe&id=${currentRecipe.id}`, { method: 'DELETE' });
        deleteModal.classList.remove('active');
        toast('Recipe deleted');
        currentRecipe = null;
        listLoaded = false;
        goList();
    } catch (e) {
        toast(e.message, true);
    } finally {
        deleteBusy = false;
    }
});

// --- Editor ---
function blankIngredient(list) { return { key: nextIngKey(list), name: '', quantity: '' }; }

function openEditor(recipe = null) {
    stopCooking();
    lastStepFocus = null;
    if (recipe) {
        draft = {
            id: recipe.id,
            title: recipe.title,
            description: recipe.description || '',
            ingredients: recipe.ingredients.map(i => ({ ...i })),
            steps: recipe.steps.map(s => ({
                body: s.body,
                minutes: s.duration_seconds ? String(Math.round(s.duration_seconds / 60)) : '',
            })),
            coverFile: null,
            coverUrl: recipe.image_url ? `../../${recipe.image_url}` : null,
        };
        editorHeading.textContent = 'Edit recipe';
    } else {
        draft = {
            id: null, title: '', description: '',
            ingredients: [], steps: [{ body: '', minutes: '' }],
            coverFile: null, coverUrl: null,
        };
        draft.ingredients.push(blankIngredient(draft.ingredients));
        editorHeading.textContent = 'New recipe';
    }
    titleInput.value = draft.title;
    descInput.value = draft.description;
    coverInput.value = '';
    renderCoverPreview();
    renderIngRows();
    renderStepRows();
    editorErrors.classList.add('hidden');
    showScreen('editor');
}

function renderCoverPreview() {
    if (draft.coverFile) {
        coverPreview.innerHTML = `<img src="${URL.createObjectURL(draft.coverFile)}" alt="" class="w-full h-full object-cover">`;
    } else if (draft.coverUrl) {
        coverPreview.innerHTML = `<img src="${esc(draft.coverUrl)}" alt="" class="w-full h-full object-cover">`;
    } else {
        coverPreview.innerHTML = '<i class="fas fa-image text-xl"></i>';
    }
}

function renderIngRows() {
    ingRows.innerHTML = draft.ingredients.map((ing, i) => `
        <div class="ing-row flex items-center gap-2" data-idx="${i}">
            <span class="ing-used w-5 h-5 rounded-full border border-linen text-[10px] flex items-center justify-center shrink-0 text-transparent" title="Not linked in any step yet"></span>
            <input type="text" class="ing-name flex-1 min-w-0 bg-beige/50 border border-linen rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:border-ember" placeholder="Flour" maxlength="100" value="${esc(ing.name)}">
            <input type="text" class="ing-qty w-24 bg-beige/50 border border-linen rounded-lg px-2.5 py-1.5 text-sm font-mono focus:outline-none focus:border-ember" placeholder="500 g" maxlength="50" value="${esc(ing.quantity)}">
            <button type="button" class="ing-link w-8 h-8 rounded-lg text-emberdk hover:bg-ember/10 transition-colors shrink-0" title="Insert into the focused step"><i class="fas fa-link pointer-events-none text-sm"></i></button>
            <button type="button" class="ing-del w-8 h-8 rounded-lg text-cocoa/70 hover:text-emberdk hover:bg-ember/10 transition-colors shrink-0" title="Remove ingredient"><i class="fas fa-xmark pointer-events-none"></i></button>
        </div>
    `).join('');
    updateUsedState();
}

function renderStepRows() {
    stepRows.innerHTML = draft.steps.map((step, i) => `
        <div class="step-row bg-beige/40 border border-linen rounded-xl p-3" data-idx="${i}">
            <div class="flex items-center gap-2 mb-2">
                <span class="font-display italic font-semibold text-ember text-lg leading-none select-none">${i + 1}</span>
                <span class="flex-1"></span>
                <label class="inline-flex items-center gap-1.5 text-xs text-cocoa font-semibold">
                    <i class="fas fa-stopwatch text-ember"></i>
                    <input type="number" class="step-min w-16 bg-card border border-linen rounded-lg px-2 py-1 text-sm font-mono focus:outline-none focus:border-ember" min="1" max="1440" placeholder="–" value="${esc(step.minutes)}">
                    min
                </label>
                <button type="button" class="step-up w-7 h-7 rounded-lg text-cocoa/70 hover:text-ink hover:bg-linen/50 transition-colors ${i === 0 ? 'invisible' : ''}" title="Move up"><i class="fas fa-chevron-up pointer-events-none text-xs"></i></button>
                <button type="button" class="step-down w-7 h-7 rounded-lg text-cocoa/70 hover:text-ink hover:bg-linen/50 transition-colors ${i === draft.steps.length - 1 ? 'invisible' : ''}" title="Move down"><i class="fas fa-chevron-down pointer-events-none text-xs"></i></button>
                <button type="button" class="step-del w-7 h-7 rounded-lg text-cocoa/70 hover:text-emberdk hover:bg-ember/10 transition-colors" title="Remove step"><i class="fas fa-xmark pointer-events-none"></i></button>
            </div>
            <textarea class="step-body w-full bg-card border border-linen rounded-lg px-3 py-2 text-sm leading-relaxed focus:outline-none focus:border-ember resize-y" rows="2"
                      placeholder="Whisk the eggs and sugar until pale...">${esc(step.body)}</textarea>
            <div class="step-preview text-sm text-cocoa mt-1.5 leading-relaxed" style="${stepHasToken(step.body) ? '' : 'display:none'}">${stepBodyHTML(step.body, draft.ingredients)}</div>
        </div>
    `).join('');
    updateUsedState();
}

function stepHasToken(body) {
    return parseTokens(body).some(p => p.type === 'ing');
}

function updateUsedState() {
    const used = usedIngredientKeys(draft.steps);
    let linked = 0;
    ingRows.querySelectorAll('.ing-row').forEach(row => {
        const ing = draft.ingredients[+row.dataset.idx];
        const mark = row.querySelector('.ing-used');
        const isUsed = ing && used.has(ing.key);
        if (isUsed) linked++;
        mark.className = 'ing-used w-5 h-5 rounded-full text-[10px] flex items-center justify-center shrink-0 border ' +
            (isUsed ? 'border-ember bg-ember text-card' : 'border-linen text-transparent');
        mark.innerHTML = isUsed ? '<i class="fas fa-check"></i>' : '';
        mark.title = isUsed ? 'Linked in the method' : 'Not linked in any step yet';
        row.querySelector('.ing-name').classList.toggle('opacity-60', isUsed);
        row.querySelector('.ing-qty').classList.toggle('opacity-60', isUsed);
    });
    const total = draft.ingredients.filter(i => i.name.trim() !== '').length;
    usedCount.textContent = total ? `${linked} of ${total} linked` : '';
}

function updateStepPreview(row, step) {
    const preview = row.querySelector('.step-preview');
    if (stepHasToken(step.body)) {
        preview.style.display = '';
        preview.innerHTML = stepBodyHTML(step.body, draft.ingredients);
    } else {
        preview.style.display = 'none';
    }
}

function refreshAllStepPreviews() {
    stepRows.querySelectorAll('.step-row').forEach(row => {
        updateStepPreview(row, draft.steps[+row.dataset.idx]);
    });
}

// Ingredient panel events
ingRows.addEventListener('input', e => {
    const row = e.target.closest('.ing-row');
    if (!row) return;
    const ing = draft.ingredients[+row.dataset.idx];
    if (e.target.classList.contains('ing-name')) ing.name = e.target.value;
    if (e.target.classList.contains('ing-qty')) ing.quantity = e.target.value;
    updateUsedState();
    refreshAllStepPreviews();
});

ingRows.addEventListener('click', e => {
    const row = e.target.closest('.ing-row');
    if (!row) return;
    const idx = +row.dataset.idx;
    if (e.target.classList.contains('ing-link')) {
        insertToken(draft.ingredients[idx]);
    } else if (e.target.classList.contains('ing-del')) {
        const ing = draft.ingredients.splice(idx, 1)[0];
        draft.steps.forEach(s => { s.body = replaceTokenWithText(s.body, ing.key, ing.name.trim()); });
        lastStepFocus = null;
        renderIngRows();
        renderStepRows();
    }
});

$('addIngBtn').addEventListener('click', () => {
    draft.ingredients.push(blankIngredient(draft.ingredients));
    renderIngRows();
    const inputs = ingRows.querySelectorAll('.ing-name');
    inputs[inputs.length - 1]?.focus();
});

// Step panel events
function trackCaret(e) {
    if (!e.target.classList.contains('step-body')) return;
    const row = e.target.closest('.step-row');
    lastStepFocus = { idx: +row.dataset.idx, pos: e.target.selectionStart ?? e.target.value.length };
}

stepRows.addEventListener('focusin', trackCaret);
stepRows.addEventListener('keyup', trackCaret);
stepRows.addEventListener('click', trackCaret);

stepRows.addEventListener('input', e => {
    const row = e.target.closest('.step-row');
    if (!row) return;
    const step = draft.steps[+row.dataset.idx];
    if (e.target.classList.contains('step-body')) {
        step.body = e.target.value;
        trackCaret(e);
        updateStepPreview(row, step);
        updateUsedState();
    } else if (e.target.classList.contains('step-min')) {
        step.minutes = e.target.value;
    }
});

stepRows.addEventListener('click', e => {
    const row = e.target.closest('.step-row');
    if (!row) return;
    const idx = +row.dataset.idx;
    if (e.target.classList.contains('step-del')) {
        draft.steps.splice(idx, 1);
        if (draft.steps.length === 0) draft.steps.push({ body: '', minutes: '' });
        lastStepFocus = null;
        renderStepRows();
        updateUsedState();
    } else if (e.target.classList.contains('step-up') && idx > 0) {
        [draft.steps[idx - 1], draft.steps[idx]] = [draft.steps[idx], draft.steps[idx - 1]];
        lastStepFocus = null;
        renderStepRows();
    } else if (e.target.classList.contains('step-down') && idx < draft.steps.length - 1) {
        [draft.steps[idx + 1], draft.steps[idx]] = [draft.steps[idx], draft.steps[idx + 1]];
        lastStepFocus = null;
        renderStepRows();
    }
});

$('addStepBtn').addEventListener('click', () => {
    draft.steps.push({ body: '', minutes: '' });
    renderStepRows();
    const areas = stepRows.querySelectorAll('.step-body');
    areas[areas.length - 1]?.focus();
});

function insertToken(ing) {
    if (!ing || ing.name.trim() === '') {
        toast('Name the ingredient first, then link it.', true);
        return;
    }
    if (!lastStepFocus) {
        toast('Click into a step first, then link the ingredient.', true);
        return;
    }
    const { idx, pos } = lastStepFocus;
    const step = draft.steps[idx];
    if (!step) { lastStepFocus = null; return; }
    const token = `{ing:${ing.key}}`;
    step.body = step.body.slice(0, pos) + token + step.body.slice(pos);
    const row = stepRows.querySelector(`.step-row[data-idx="${idx}"]`);
    const ta = row.querySelector('.step-body');
    ta.value = step.body;
    const newPos = pos + token.length;
    ta.focus();
    ta.setSelectionRange(newPos, newPos);
    lastStepFocus = { idx, pos: newPos };
    updateStepPreview(row, step);
    updateUsedState();
}

titleInput.addEventListener('input', () => { draft.title = titleInput.value; });
descInput.addEventListener('input', () => { draft.description = descInput.value; });
coverInput.addEventListener('change', () => {
    if (coverInput.files && coverInput.files[0]) {
        draft.coverFile = coverInput.files[0];
        renderCoverPreview();
    }
});

function closeEditor() {
    if (draft && draft.id && currentRecipe && currentRecipe.id === draft.id) {
        showScreen('detail');
    } else {
        goList(false);
    }
    draft = null;
}
$('editorCancelBtn').addEventListener('click', closeEditor);
$('editorCancelTop').addEventListener('click', closeEditor);

newRecipeBtn.addEventListener('click', () => openEditor(null));

editorSaveBtn.addEventListener('click', async () => {
    if (!draft || editorSaveBtn.disabled) return;
    const errors = validateDraft(draft);
    if (errors.length) {
        editorErrors.innerHTML = errors.map(e => `<p class="m-0">${esc(e)}</p>`).join('');
        editorErrors.classList.remove('hidden');
        editorErrors.scrollIntoView({ block: 'center' });
        return;
    }
    editorErrors.classList.add('hidden');
    setSaving(true);
    try {
        const payload = buildPayload(draft);
        const url = draft.id ? `${API}?resource=recipe&id=${draft.id}` : `${API}?resource=recipe`;
        const data = await api(url, {
            method: draft.id ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        let saved = data.recipe;
        if (draft.coverFile) {
            const fd = new FormData();
            fd.append('image', draft.coverFile);
            const withCover = await api(`${API}?resource=recipe&id=${saved.id}&action=cover`, { method: 'POST', body: fd });
            saved = withCover.recipe;
        }
        draft = null;
        listLoaded = false;
        currentRecipe = saved;
        toast('Recipe saved');
        history.pushState({}, '', `?id=${saved.id}`);
        showScreen('detail');
        renderDetail();
    } catch (e) {
        editorErrors.innerHTML = `<p class="m-0">${esc(e.message)}</p>`;
        editorErrors.classList.remove('hidden');
    } finally {
        setSaving(false);
    }
});

function setSaving(saving) {
    editorSaveBtn.disabled = saving;
    editorSaveBtn.querySelector('.btn-text').classList.toggle('hidden', saving);
    editorSaveBtn.querySelector('.btn-loading').classList.toggle('hidden', !saving);
}

// --- Audio (bell synthesized on the fly, no asset needed) ---
function unlockAudio() {
    if (audioUnlocked) return;
    try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        audioUnlocked = true;
    } catch { /* audio disabled, skip bells */ }
}

function ringBell({ celebratory = false } = {}) {
    if (!audioCtx) return;
    const now = audioCtx.currentTime;
    const notes = celebratory
        ? [880, 1108.73, 1318.51, 1760]   // A5, C#6, E6, A6 major arpeggio
        : [880, 1318.51];                  // A5 -> E6 short ding
    notes.forEach((freq, i) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        const start = now + i * 0.12;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.32, start + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.7);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(start);
        osc.stop(start + 0.75);
    });
}

// --- Wake lock (keep the screen on while cooking) ---
async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    } catch { /* not critical */ }
}

function releaseWakeLock() {
    try { wakeLock?.release(); } catch { /* already released */ }
    wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && cook) requestWakeLock();
});

// --- Cooking mode ---
function enterCookMode() {
    if (!currentRecipe || currentRecipe.steps.length === 0) return;
    unlockAudio();
    requestWakeLock();
    cook = { phase: 'checklist', checked: new Set(), session: null, endAt: null, rang: false };
    cookTitle.textContent = currentRecipe.title;
    showScreen('cook');
    renderCook();
}

function stopCooking() {
    if (!cook) return;
    cook = null;
    releaseWakeLock();
    if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
}

function renderCook() {
    cookChecklist.innerHTML = '';
    cookSteps.innerHTML = '';
    cookDone.innerHTML = '';
    if (!cook) return;
    if (cook.phase === 'checklist') renderCookChecklist();
    else if (cook.phase === 'steps') renderCookSteps();
    else renderCookDone();
}

function renderCookChecklist() {
    const r = currentRecipe;
    cookChecklist.innerHTML = `
        <div class="bg-card border border-linen rounded-2xl p-5 sm:p-7 max-w-xl mx-auto">
            <p class="text-[11px] uppercase tracking-[0.18em] text-cocoa font-bold m-0">Mise en place</p>
            <h3 class="font-display font-semibold text-2xl mt-1 mb-1">Get everything on the counter.</h3>
            <p class="text-sm text-cocoa mt-0 mb-5">Tick things off as you gather them, or skip straight ahead.</p>
            <div class="flex flex-col gap-1.5">
                ${r.ingredients.map((ing, i) => {
                    const checked = cook.checked.has(i);
                    return `
                    <button type="button" data-check="${i}" class="flex items-center gap-3 text-left rounded-xl border px-3.5 py-2.5 transition-colors
                            ${checked ? 'border-ember/50 bg-ember/10' : 'border-linen bg-beige/40 hover:border-ember/40'}">
                        <span class="w-5 h-5 rounded-full border flex items-center justify-center text-[10px] shrink-0 transition-colors
                            ${checked ? 'border-ember bg-ember text-card' : 'border-cocoa/40 text-transparent'}"><i class="fas fa-check"></i></span>
                        <span class="flex-1 ${checked ? 'line-through text-cocoa' : ''}">${esc(ing.name)}</span>
                        <span class="font-mono text-sm text-cocoa whitespace-nowrap">${esc(ing.quantity)}</span>
                    </button>`;
                }).join('')}
            </div>
            <div class="flex items-center justify-between gap-3 mt-6 flex-wrap">
                <span id="checklistProgress" class="text-sm text-cocoa font-semibold">${cook.checked.size} / ${r.ingredients.length} ready</span>
                <button id="cookStartBtn" class="bg-ember hover:bg-emberdk text-card font-semibold px-5 py-2.5 rounded-xl shadow-lift transition-colors">
                    Got everything<i class="fas fa-arrow-right ml-2"></i>
                </button>
            </div>
        </div>`;

    cookChecklist.querySelectorAll('[data-check]').forEach(btn => {
        btn.addEventListener('click', () => {
            const i = +btn.dataset.check;
            cook.checked.has(i) ? cook.checked.delete(i) : cook.checked.add(i);
            renderCook();
        });
    });
    $('cookStartBtn').addEventListener('click', startSteps);
}

function startSteps() {
    cook.phase = 'steps';
    cook.session = createCookSession(currentRecipe.steps);
    armStepTimer();
    renderCook();
    startTicker();
}

function armStepTimer() {
    const step = currentRecipe.steps[cook.session.index];
    cook.rang = false;
    cook.endAt = step.duration_seconds ? Date.now() + step.duration_seconds * 1000 : null;
}

function startTicker() {
    if (tickInterval) return;
    tickInterval = setInterval(tick, 1000);
}

function tick() {
    if (!cook || cook.phase !== 'steps' || !cook.endAt) return;
    const { remaining, done } = timerState(cook.endAt, Date.now());
    const digits = document.querySelector('.cook-timer-digits');
    if (digits) digits.textContent = fmtTimer(remaining);
    if (done && !cook.rang) {
        cook.rang = true;
        ringBell();
        const timerBox = document.querySelector('.cook-timer');
        if (timerBox) {
            timerBox.classList.add('timer-done');
            const label = timerBox.querySelector('.cook-timer-label');
            if (label) label.textContent = "Ding! Time's up.";
        }
    }
}

function renderCookSteps() {
    const r = currentRecipe;
    const idx = cook.session.index;
    cookSteps.innerHTML = `
        <div class="max-w-2xl mx-auto flex flex-col gap-3">
            ${r.steps.map((s, i) => {
                const state = i < idx ? 'past' : i === idx ? 'current' : 'future';
                if (state === 'current') {
                    const t = s.duration_seconds ? timerState(cook.endAt, Date.now()) : null;
                    return `
                    <div class="step-current bg-card border-2 border-ember rounded-2xl p-5 sm:p-6">
                        <p class="text-[11px] uppercase tracking-[0.18em] text-ember font-bold m-0">Step ${i + 1} of ${r.steps.length}</p>
                        <p class="text-lg sm:text-xl leading-relaxed mt-2 mb-0">${stepBodyHTML(s.body, r.ingredients)}</p>
                        ${s.duration_seconds ? `
                        <div class="cook-timer ${t.done ? 'timer-done' : ''} mt-4 bg-beige/60 border border-ember/30 rounded-xl px-5 py-3 inline-flex items-baseline gap-3">
                            <span class="cook-timer-digits font-mono font-semibold text-4xl sm:text-5xl text-emberdk tabular-nums">${fmtTimer(t.remaining)}</span>
                            <span class="cook-timer-label text-sm text-cocoa font-semibold">${t.done ? "Ding! Time's up." : 'on the clock'}</span>
                        </div>` : ''}
                        <div class="flex items-center justify-between gap-3 mt-5">
                            <button id="cookBackBtn" class="text-cocoa hover:text-ink font-semibold text-sm px-3 py-2 transition-colors ${i === 0 ? 'invisible' : ''}">
                                <i class="fas fa-arrow-left mr-1.5"></i>Back</button>
                            <button id="cookNextBtn" class="bg-ember hover:bg-emberdk text-card font-semibold px-5 py-2.5 rounded-xl shadow-lift transition-colors">
                                ${i === r.steps.length - 1 ? 'Finish<i class="fas fa-flag-checkered ml-2"></i>' : 'Next step<i class="fas fa-arrow-right ml-2"></i>'}
                            </button>
                        </div>
                    </div>`;
                }
                return `
                <div class="flex gap-3.5 px-5 py-3 rounded-2xl border border-linen/70 bg-card/50 ${state === 'past' ? 'opacity-45' : 'opacity-80'}">
                    <span class="w-6 shrink-0 text-right font-display italic font-semibold ${state === 'past' ? 'text-cocoa' : 'text-ember/70'} select-none">
                        ${state === 'past' ? '<i class="fas fa-check text-xs not-italic"></i>' : i + 1}</span>
                    <div class="min-w-0 text-sm leading-relaxed ${state === 'past' ? 'line-through decoration-cocoa/40' : ''}">
                        ${stepBodyHTML(s.body, r.ingredients)}
                        ${s.duration_seconds ? `<span class="font-mono text-xs text-cocoa ml-1.5 whitespace-nowrap"><i class="fas fa-stopwatch mr-1"></i>${esc(fmtDurationHuman(s.duration_seconds))}</span>` : ''}
                    </div>
                </div>`;
            }).join('')}
        </div>`;

    $('cookNextBtn').addEventListener('click', () => {
        if (isLastStep(cook.session)) {
            finishCooking();
        } else {
            cook.session = advance(cook.session);
            armStepTimer();
            renderCook();
            scrollToCurrent();
        }
    });
    const backBtn = $('cookBackBtn');
    if (backBtn) backBtn.addEventListener('click', () => {
        cook.session = back(cook.session);
        armStepTimer();
        renderCook();
        scrollToCurrent();
    });
}

function scrollToCurrent() {
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    document.querySelector('.step-current')?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'center' });
}

function finishCooking() {
    cook.phase = 'done';
    cook.endAt = null;
    ringBell({ celebratory: true });
    renderCook();
}

function renderCookDone() {
    const r = currentRecipe;
    let ratingBlock;
    if (isDemo) {
        ratingBlock = `
            <p class="text-sm text-cocoa mt-1 mb-0"><i class="fas fa-lock mr-1.5"></i>
                <a href="${esc(detailLoginUrl())}" class="text-emberdk font-semibold underline decoration-ember/40 hover:decoration-ember">Sign in</a>
                to rate this recipe.</p>`;
    } else if (r.mine) {
        ratingBlock = '<p class="text-sm text-cocoa mt-1 mb-0">You wrote this one. Chef\'s privilege: no self-ratings.</p>';
    } else {
        ratingBlock = `
            <p class="text-sm text-cocoa mt-1 mb-4">How was it? Rate it for the next cook.</p>
            <div id="doneRating">${ratingButtonsHTML(r.my_rating, 'text-3xl')}</div>`;
    }
    cookDone.innerHTML = `
        <div class="bg-card border border-linen rounded-2xl p-6 sm:p-10 max-w-xl mx-auto text-center">
            <div class="text-5xl select-none mb-3">🍽️</div>
            <h3 class="font-display font-semibold text-3xl m-0 tracking-tight">It's ready.</h3>
            <p class="text-cocoa mt-1 mb-6">You cooked <strong class="text-ink">${esc(r.title)}</strong>. Enjoy it while it's warm.</p>
            <div class="border-t border-linen pt-5">${ratingBlock}</div>
            <button id="cookDoneBackBtn" class="mt-7 text-cocoa hover:text-ink font-semibold text-sm transition-colors">
                <i class="fas fa-arrow-left mr-1.5"></i>Back to the recipe
            </button>
        </div>`;

    $('cookDoneBackBtn').addEventListener('click', exitCookToDetail);
    const row = cookDone.querySelector('.rating-row');
    if (row) {
        setupRatingRow(row, () => currentRecipe.my_rating, async (stars) => {
            try {
                await postRating(stars);
                $('doneRating').innerHTML = `
                    <p class="text-emberdk font-semibold m-0"><i class="fas fa-check mr-1.5"></i>Thanks! You gave it ${stars} star${stars > 1 ? 's' : ''}.</p>`;
            } catch (e) {
                toast(e.message, true);
            }
        });
    }
}

function exitCookToDetail() {
    stopCooking();
    showScreen('detail');
    renderDetail();
}
$('cookExitBtn').addEventListener('click', exitCookToDetail);

// --- Init ---
function init() {
    loadList();
    const id = new URLSearchParams(location.search).get('id');
    if (id) openRecipe(parseInt(id, 10), false);
    else showScreen('list');
}

init();
