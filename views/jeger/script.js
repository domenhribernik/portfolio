const CONTROLLER = '../../app/controllers/jeger-controller.php';
const STORAGE_KEY = 'jeger-checklist';
const currentMonth = new Date().getMonth() + 1;

const SL_MONTHS = ['januar','februar','marec','april','maj','junij','julij','avgust','september','oktober','november','december'];

const GROUPS = [
    {
        name: 'Marec', icon: '🌱',
        plants: [
            { id: 'lapuh-cvet', name: 'Lapuh', detail: 'cvet', period: 'marec', months: [[3,3]] },
        ]
    },
    {
        name: 'April', icon: '🌸',
        plants: [
            { id: 'trobentice-cvet', name: 'Trobentice', detail: 'cvet', period: 'april', months: [[4,4]] },
            { id: 'trobentice-listje', name: 'Trobentice', detail: 'listje', period: 'april', months: [[4,4]] },
            { id: 'smreka-vrscicki', name: 'Smreka', detail: 'vršički', period: 'april–maj', months: [[4,5]] },
            { id: 'robida-listi', name: 'Robida', detail: 'listi', period: 'april–junij, sep–okt', months: [[4,6],[9,10]] },
            { id: 'tropotec-ozko', name: 'Ozkolistni suličasti tropotec', period: 'april–september', months: [[4,9]] },
        ]
    },
    {
        name: 'Maj', icon: '🌿',
        plants: [
            { id: 'brin-zelene', name: 'Brin', detail: 'zelene jagode', period: 'maj', months: [[5,5]] },
            { id: 'lapuh-listje', name: 'Lapuh', detail: 'listje', period: 'maj–junij', months: [[5,6]] },
            { id: 'kamilica-cvet', name: 'Kamilica', detail: 'cvet', period: 'maj–junij', months: [[5,6]] },
            { id: 'gozdna-jagoda', name: 'Gozdna jagoda', detail: 'listje', period: 'maj–junij', months: [[5,6]] },
            { id: 'pelin', name: 'Pelin', period: 'maj–junij', months: [[5,6]] },
            { id: 'bezeg-cvet', name: 'Bezeg', detail: 'cvet', period: 'maj–junij', months: [[5,6]] },
            { id: 'rman-cvet', name: 'Navadni rman', detail: 'cvet', period: 'maj–junij', months: [[5,6]] },
            { id: 'zajbelj', name: 'Žajbelj', period: 'maj–junij', months: [[5,6]] },
            { id: 'ajbiz', name: 'Ajbiž', period: 'maj–junij', months: [[5,6]] },
            { id: 'meta', name: 'Meta', period: 'maj–avgust', months: [[5,8]] },
            { id: 'materina-dusica', name: 'Materina dušica', period: 'maj–september', months: [[5,9]] },
            { id: 'marjetica-cvet', name: 'Navadna marjetica', detail: 'cvet', period: 'maj–september', months: [[5,9]] },
        ]
    },
    {
        name: 'Junij', icon: '🌻',
        plants: [
            { id: 'akacija-cvet', name: 'Akacija', detail: 'cvet', period: 'junij', months: [[6,6]] },
            { id: 'borovnice-listi', name: 'Borovnice', detail: 'listi pred zorenjem', period: 'junij', months: [[6,6]] },
            { id: 'majaron', name: 'Majaron', period: 'junij', months: [[6,6]] },
            { id: 'lipa-cvet', name: 'Lipa', detail: 'cvet', period: 'junij', months: [[6,6]] },
            { id: 'oreh', name: 'Oreh', detail: 'zelen, zrezan', period: 'junij', months: [[6,6]] },
            { id: 'bela-detelja', name: 'Bela detelja', detail: 'cvet', period: 'junij–julij', months: [[6,7]] },
            { id: 'janez-zelen', name: 'Janež', detail: 'zelen', period: 'junij–julij', months: [[6,7]] },
            { id: 'kumina', name: 'Kumina', period: 'junij–avgust', months: [[6,8]] },
            { id: 'tropotec-siroko', name: 'Širokolistni tropotec', period: 'junij–avgust', months: [[6,8]] },
            { id: 'sentjanzvka-cvet', name: 'Šentjanževka', detail: 'cvet', period: 'junij–avgust', months: [[6,8]] },
            { id: 'rozmarim', name: 'Rožmarin', period: 'junij–avgust', months: [[6,8]] },
            { id: 'srcna-moc-cvet', name: 'Srčna moč', detail: 'cvet', period: 'junij–avgust', months: [[6,8]] },
        ]
    },
    {
        name: 'Julij', icon: '☀️',
        plants: [
            { id: 'pravi-kostanj-cvet', name: 'Pravi kostanj', detail: 'cvet', period: 'julij', months: [[7,7]] },
            { id: 'arnika-cvet', name: 'Arnika', detail: 'cvet', period: 'julij–avgust', months: [[7,8]] },
            { id: 'tavzentroza', name: 'Tavžentroža', period: 'julij–avgust', months: [[7,8]] },
            { id: 'navadna-melisa', name: 'Navadna melisa', period: 'julij–avgust', months: [[7,8]] },
            { id: 'njivska-preslica', name: 'Njivska preslica', period: 'julij–oktober', months: [[7,10]] },
        ]
    },
    {
        name: 'Oktober–November', icon: '🍂',
        plants: [
            { id: 'brin-zrele', name: 'Brin', detail: 'zrele jagode', period: 'oktober–november', months: [[10,11]] },
        ]
    },
];

const TOTAL = GROUPS.reduce((sum, g) => sum + g.plants.length, 0);

let checked = {};

function isInSeason(plant) {
    return plant.months.some(([start, end]) => currentMonth >= start && currentMonth <= end);
}

function checkedCount() {
    return Object.values(checked).filter(Boolean).length;
}

async function load() {
    try {
        const res = await fetch(CONTROLLER);
        if (res.ok) checked = await res.json();
    } catch {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) checked = JSON.parse(stored);
    }
    render();
}

async function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(checked));
    try {
        await fetch(CONTROLLER, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(checked),
        });
    } catch {}
}

function toggle(id) {
    checked[id] = !checked[id];
    save();
    const el = document.querySelector(`[data-id="${id}"]`);
    if (!el) return;
    applyItemState(el, id);
    updateGroupProgress(el.closest('.plant-group'));
    updateProgress();
}

function applyItemState(el, id) {
    const isChecked = !!checked[id];
    el.querySelector('.checkbox').classList.toggle('checked', isChecked);
    el.querySelector('.plant-name').classList.toggle('done', isChecked);
}

function updateGroupProgress(groupEl) {
    if (!groupEl) return;
    const items = [...groupEl.querySelectorAll('[data-id]')];
    const total = items.length;
    const done = items.filter(el => checked[el.dataset.id]).length;
    const header = groupEl.querySelector('.group-header');
    groupEl.querySelector('.group-counter').textContent = `${done}/${total}`;
    header.classList.toggle('all-done', done === total);
}

function updateProgress() {
    const done = checkedCount();
    const pct = Math.round((done / TOTAL) * 100);
    document.getElementById('progress-bar').style.width = `${pct}%`;
    document.getElementById('progress-text').textContent = `${done} / ${TOTAL} zelišč nabranih`;
    document.getElementById('progress-pct').textContent = `${pct}%`;
    const allDone = done === TOTAL;
    document.getElementById('all-done-msg').style.display = allDone ? 'block' : 'none';
}

function render() {
    document.getElementById('season-month').textContent = SL_MONTHS[currentMonth - 1];

    const container = document.getElementById('plant-list');
    container.innerHTML = GROUPS.map(group => {
        const total = group.plants.length;
        const done = group.plants.filter(p => checked[p.id]).length;
        const allDone = done === total;
        return `
<div class="plant-group mb-6">
    <div class="group-header flex items-center justify-between px-1 mb-2.5 ${allDone ? 'all-done' : ''}">
        <h3 class="group-name flex items-center gap-2.5 text-gold/70 text-xs font-semibold uppercase tracking-[0.25em] transition-colors">
            <span class="flourish">✦</span>
            <span class="text-base">${group.icon}</span>
            <span>${group.name}</span>
            <span class="group-done-check text-herb ml-1 ${allDone ? '' : 'hidden'}"><i class="fas fa-check text-[10px]"></i></span>
            <span class="flourish">✦</span>
        </h3>
        <span class="group-counter text-gold/40 text-xs font-mono">${done}/${total}</span>
    </div>
    <div class="rounded-xl overflow-hidden border border-dashed border-gold/15 bg-night-soft/60">
        ${group.plants.map(plant => renderPlant(plant)).join('')}
    </div>
</div>`;
    }).join('');

    document.querySelectorAll('[data-id]').forEach(el => applyItemState(el, el.dataset.id));
    updateProgress();
}

function renderPlant(plant) {
    const season = isInSeason(plant);
    return `
<div class="plant-item flex items-center gap-3 px-4 py-3 cursor-pointer border-b border-gold/5 last:border-b-0 hover:bg-gold/[0.035] transition-colors select-none"
     data-id="${plant.id}" onclick="toggle('${plant.id}')">
    <div class="checkbox w-5 h-5 rounded-full border-2 border-gold/30 flex items-center justify-center flex-shrink-0">
        <i class="fas fa-check check-icon"></i>
    </div>
    <div class="flex-1 min-w-0">
        <span class="plant-name font-medium text-sm text-cream">${plant.name}</span>${plant.detail ? `<span class="text-gold/55 text-xs ml-1.5 italic">· ${plant.detail}</span>` : ''}
    </div>
    <div class="flex items-center gap-2 flex-shrink-0">
        ${season ? '<span class="season-dot w-1.5 h-1.5 rounded-full bg-herb flex-shrink-0"></span>' : ''}
        <span class="text-gold/35 text-[11px] hidden sm:block font-mono">${plant.period}</span>
    </div>
</div>`;
}

function initMarquee() {
    const track = document.querySelector('.marquee');
    if (!track) return;
    const original = track.querySelector('span');
    if (!original) return;
    [...track.querySelectorAll('span')].slice(1).forEach(s => s.remove());

    const singleW = original.scrollWidth;
    const needed = Math.ceil((window.innerWidth * 4) / singleW) + 2;
    for (let i = 1; i < needed; i++) track.appendChild(original.cloneNode(true));

    let pos = 0;
    (function tick() {
        pos -= 0.45;
        if (pos <= -singleW) pos += singleW;
        track.style.transform = `translateX(${pos}px)`;
        requestAnimationFrame(tick);
    })();
}

load();
initMarquee();
