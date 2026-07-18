const API = '../../app/controllers/stocks-controller.php';

const input = document.getElementById('tickerInput');
const addBtn = document.getElementById('addBtn');
const tickerList = document.getElementById('tickerList');
const emptyState = document.getElementById('emptyState');
const errorMsg = document.getElementById('errorMsg');
const countBar = document.getElementById('countBar');
const tickerCount = document.getElementById('tickerCount');
const clearAllBtn = document.getElementById('clearAllBtn');

function showError(msg) {
    errorMsg.textContent = msg;
    errorMsg.classList.remove('hidden');
    setTimeout(() => errorMsg.classList.add('hidden'), 3000);
}

function renderTickers(tickers) {
    tickerList.innerHTML = '';

    if (tickers.length === 0) {
        emptyState.classList.remove('hidden');
        countBar.classList.add('hidden');
        return;
    }

    emptyState.classList.add('hidden');
    countBar.classList.remove('hidden');
    tickerCount.textContent = tickers.length;

    tickers.forEach(ticker => {
        const row = document.createElement('div');
        row.className = 'ticker-row flex items-center justify-between bg-[#1a1d26] border border-[#2a2d3a] rounded-lg px-4 py-3 group';
        row.innerHTML = `
            <span class="font-mono text-green-400 font-semibold tracking-wider text-sm ticker-label">${ticker}</span>
            <input
                type="text"
                class="hidden font-mono text-green-400 font-semibold tracking-wider text-sm bg-transparent border-b border-green-500 focus:outline-none uppercase w-24 ticker-input"
                value="${ticker}" maxlength="10"
            >
            <div class="flex gap-3 opacity-0 group-hover:opacity-100 transition-opacity">
                <button class="text-gray-600 hover:text-blue-400 transition-colors text-xs edit-btn" title="Edit">
                    <i class="fas fa-pen"></i>
                </button>
                <button class="text-gray-600 hover:text-green-400 transition-colors text-xs confirm-btn hidden" title="Save">
                    <i class="fas fa-check"></i>
                </button>
                <button class="text-gray-600 hover:text-red-400 transition-colors text-xs remove-btn" title="Remove">
                    <i class="fas fa-times"></i>
                </button>
            </div>
        `;

        const label = row.querySelector('.ticker-label');
        const editInput = row.querySelector('.ticker-input');
        const editBtn = row.querySelector('.edit-btn');
        const confirmBtn = row.querySelector('.confirm-btn');
        const removeBtn = row.querySelector('.remove-btn');

        function enterEdit() {
            label.classList.add('hidden');
            editInput.classList.remove('hidden');
            editBtn.classList.add('hidden');
            confirmBtn.classList.remove('hidden');
            row.classList.add('!opacity-100');
            editInput.focus();
            editInput.select();
        }

        function exitEdit() {
            editInput.classList.add('hidden');
            label.classList.remove('hidden');
            confirmBtn.classList.add('hidden');
            editBtn.classList.remove('hidden');
            row.classList.remove('!opacity-100');
            editInput.value = ticker;
        }

        async function saveEdit() {
            const newTicker = editInput.value.trim().toUpperCase();
            if (!newTicker || newTicker === ticker) { exitEdit(); return; }
            await renameTicker(ticker, newTicker);
        }

        editBtn.addEventListener('click', enterEdit);
        confirmBtn.addEventListener('click', saveEdit);
        removeBtn.addEventListener('click', () => removeTicker(ticker));
        editInput.addEventListener('keydown', e => {
            if (e.key === 'Enter') saveEdit();
            if (e.key === 'Escape') exitEdit();
        });
        editInput.addEventListener('input', () => { editInput.value = editInput.value.toUpperCase(); });

        tickerList.appendChild(row);
    });
}

// The backend is admin-only (SEC-02): signed out gets 401, signed in
// without admin gets 403. Show a wall instead of the list in both cases.
function showAuthWall(status) {
    emptyState.classList.add('hidden');
    countBar.classList.add('hidden');
    input.disabled = true;
    addBtn.disabled = true;
    tickerList.innerHTML = '';

    const wall = document.createElement('div');
    wall.className = 'text-center py-16';

    const msg = document.createElement('p');
    msg.className = 'text-gray-500 text-sm mb-4 font-mono';
    msg.textContent = status === 401
        ? 'Sign in to manage the watchlist.'
        : 'This watchlist is owner-only.';
    wall.appendChild(msg);

    if (status === 401) {
        const link = document.createElement('a');
        link.href = '../account/?redirect=' + encodeURIComponent(location.pathname);
        link.textContent = 'Sign in';
        link.className = 'text-green-400 font-mono text-sm underline hover:text-green-300';
        wall.appendChild(link);
    }

    tickerList.appendChild(wall);
}

async function loadTickers() {
    try {
        const res = await fetch(API);
        if (res.status === 401 || res.status === 403) {
            showAuthWall(res.status);
            return;
        }
        const tickers = await res.json();
        renderTickers(tickers);
    } catch {
        showError('Could not load tickers — is XAMPP running?');
    }
}

async function addTicker() {
    const value = input.value.trim().toUpperCase();
    if (!value) return;

    try {
        const res = await fetch(API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ticker: value }),
        });
        const data = await res.json();

        if (!res.ok) {
            showError(data.error || 'Failed to add ticker');
            return;
        }

        input.value = '';
        renderTickers(data);
    } catch {
        showError('Request failed — is XAMPP running?');
    }
}

async function removeTicker(ticker) {
    try {
        const res = await fetch(API, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ticker }),
        });
        const data = await res.json();
        renderTickers(data);
    } catch {
        showError('Request failed');
    }
}

async function renameTicker(oldTicker, newTicker) {
    try {
        const del = await fetch(API, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ticker: oldTicker }),
        });
        if (!del.ok) { showError('Failed to remove old ticker'); return; }

        const add = await fetch(API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ticker: newTicker }),
        });
        const data = await add.json();

        if (!add.ok) {
            await fetch(API, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ticker: oldTicker }),
            });
            showError(data.error || 'Failed to add new ticker');
            return;
        }

        renderTickers(data);
    } catch {
        showError('Request failed');
    }
}

async function clearAll() {
    const tickers = [...tickerList.querySelectorAll('button[data-ticker]')]
        .map(b => b.dataset.ticker);

    for (const ticker of tickers) {
        await fetch(API, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ticker }),
        });
    }

    renderTickers([]);
}

addBtn.addEventListener('click', addTicker);
input.addEventListener('keydown', e => { if (e.key === 'Enter') addTicker(); });
input.addEventListener('input', () => { input.value = input.value.toUpperCase(); });
clearAllBtn.addEventListener('click', clearAll);

loadTickers();
