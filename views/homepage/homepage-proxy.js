// ===== Code Stats =====

(async () => {
    try {
        const res = await fetch('app/proxys/stats-proxy.php');
        if (!res.ok) throw new Error(res.status);
        const data = await res.json();

        const totalEl = document.getElementById('stats-total-number');
        const filesEl = document.getElementById('stats-total-files');
        const updatedEl = document.getElementById('stats-updated');
        const barEl = document.getElementById('stats-bar');
        const legendEl = document.getElementById('stats-legend');
        if (!totalEl || !barEl || !legendEl) return;

        // Editorial palette so the chart sits in the same world as the rest of the page.
        const colors = {
            html: '#d4451f', // clay
            css: '#1f35e0', // cobalt
            js: '#f2b705', // marigold
            php: '#2f5b53', // pine
            sql: '#6b6256'  // stone
        };

        const labels = {
            html: 'HTML',
            css: 'CSS',
            js: 'JavaScript',
            php: 'PHP',
            sql: 'SQL'
        };

        // Biggest languages first, drop anything with no lines.
        const langs = Object.entries(data.counts)
            .filter(([, info]) => info.lines > 0)
            .sort((a, b) => b[1].lines - a[1].lines);

        const totalFiles = langs.reduce((n, [, info]) => n + info.files, 0);

        animateNumber(totalEl, data.total);
        filesEl.textContent = totalFiles.toLocaleString();
        if (updatedEl && data.date) {
            updatedEl.textContent = new Date(data.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        }

        // Single stacked composition bar.
        barEl.innerHTML = '';
        langs.forEach(([lang, info], i) => {
            const seg = document.createElement('span');
            seg.className = 'stats-comp-seg';
            seg.style.background = colors[lang] || '#6b6256';
            seg.style.width = '0%';
            seg.title = `${labels[lang] || lang} · ${info.percent}%`;
            barEl.appendChild(seg);
            requestAnimationFrame(() => {
                setTimeout(() => { seg.style.width = info.percent + '%'; }, 90 * i);
            });
        });

        // Legend grid.
        legendEl.innerHTML = '';
        langs.forEach(([lang, info], i) => {
            const row = document.createElement('div');
            row.className = 'stats-legend__item';
            row.style.setProperty('--seg', colors[lang] || '#6b6256');
            row.style.transitionDelay = (i * 0.06) + 's';
            row.innerHTML = `
                <span class="stats-legend__dot" aria-hidden="true"></span>
                <span class="stats-legend__name">${labels[lang] || lang}</span>
                <span class="stats-legend__pct">${Math.round(info.percent)}%</span>
                <span class="stats-legend__detail">${info.lines.toLocaleString()} lines · ${info.files} files</span>
            `;
            legendEl.appendChild(row);
            requestAnimationFrame(() => row.classList.add('is-in'));
        });
    } catch (e) {
        const content = document.getElementById('stats-content');
        if (content) content.innerHTML = '<p style="text-align:center;color:var(--stone)">Unable to load stats.</p>';
    }
})();

// Count-up for the headline figure (ease-out cubic).
function animateNumber(el, target) {
    const dur = 1300;
    const start = performance.now();
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { el.textContent = Math.round(target).toLocaleString(); return; }
    (function tick(now) {
        const t = Math.min((now - start) / dur, 1);
        const eased = 1 - Math.pow(1 - t, 3);
        el.textContent = Math.round(target * eased).toLocaleString();
        if (t < 1) requestAnimationFrame(tick);
    })(start);
}

// ===== APOD (Astronomy Picture of the Day) =====

(async () => {
    const spinner = document.getElementById('apod-spinner');
    const body    = document.getElementById('apod-body');
    const imgEl   = document.getElementById('apod-img');

    const renderApod = (d) => {
        document.getElementById('apod-title').textContent   = d.title;
        document.getElementById('apod-date').textContent    = new Date(d.date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
        document.getElementById('apod-explain').textContent = d.explanation;
        document.getElementById('apod-link').href           = `https://apod.nasa.gov/apod/ap${d.date.replace(/-/g, '').slice(2)}.html`;
        document.getElementById('apod-copy').textContent    = d.copyright ? `© ${d.copyright}` : '';

        imgEl.src   = d.url;
        imgEl.alt   = d.title;
        imgEl.title = d.title;
        imgEl.onclick = () => window.open(d.hdurl || d.url, '_blank');
    };

    try {
        const res = await fetch('app/proxys/apod-proxy.php');
        if (!res.ok) throw new Error(res.status);
        const d = await res.json();

        renderApod(d);
        spinner.hidden = true;
        body.hidden    = false;

        // If what we got isn't today's date, try to fetch fresh in the background
        const today = new Date().toISOString().slice(0, 10);
        if (d.date !== today) {
            fetch('app/proxys/apod-proxy.php?refresh=1')
                .then(r => r.ok ? r.json() : null)
                .then(fresh => { if (fresh?.date && fresh.date !== d.date) renderApod(fresh); })
                .catch(() => {});
        }
    } catch (e) {
        spinner.hidden = true;
        body.hidden    = false;
        body.innerHTML = `<p style="text-align:center;color:var(--clay)">Unable to load picture.</p>`;
    }
})();
