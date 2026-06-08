import { loadManifest, loadPost, formatDate, readingTime, plainExcerpt, observeReveals } from './blog.js';

const gridEl = document.getElementById('post-grid');
const filtersEl = document.getElementById('post-filters');
const countEl = document.getElementById('post-count');
const yearEl = document.getElementById('currentYear');
if (yearEl) yearEl.textContent = new Date().getFullYear();

observeReveals();

let cards = [];

(async () => {
    try {
        const slugs = await loadManifest();
        const posts = await Promise.all(slugs.map(loadPost));

        //? Newest first by frontmatter date, regardless of manifest order.
        posts.sort((a, b) => (b.meta.date || '').localeCompare(a.meta.date || ''));

        render(posts);
    } catch (err) {
        gridEl.innerHTML = `<p class="blog-state blog-state--error">${err.message}</p>`;
    }
})();

function render(posts) {
    if (!posts.length) {
        gridEl.innerHTML = `<p class="blog-state">No entries yet. Check back soon.</p>`;
        return;
    }

    if (countEl) {
        countEl.textContent = `${posts.length} ${posts.length === 1 ? 'entry' : 'entries'}`;
    }

    //? Unique categories in first-seen order, drawn straight from the post tags.
    const categories = [...new Set(posts.map(p => p.meta.tag).filter(Boolean))];
    renderFilters(categories);

    gridEl.innerHTML = '';
    posts.forEach((post, i) => {
        const { title = post.slug, date = '', tag = '' } = post.meta;
        const card = document.createElement('a');
        card.className = 'post-card reveal';
        card.href = `post.html?slug=${encodeURIComponent(post.slug)}`;
        card.dataset.category = tag;
        card.style.transitionDelay = `${Math.min(i, 8) * 0.05}s`;

        card.innerHTML = `
            ${tag ? `<span class="post-card__cat">${tag}</span>` : ''}
            <h2 class="post-card__title">${title}</h2>
            <p class="post-card__snippet">${plainExcerpt(post.body, 120)}</p>
            <div class="post-card__meta">
                ${date ? `<time datetime="${date}">${formatDate(date)}</time>` : ''}
                <span class="post-card__sep">·</span>
                <span>${readingTime(post.body)} min read</span>
            </div>
        `;
        gridEl.appendChild(card);
    });

    cards = [...gridEl.querySelectorAll('.post-card')];
    observeReveals(gridEl);
}

function renderFilters(categories) {
    if (!filtersEl || !categories.length) return;
    filtersEl.innerHTML = '';
    filtersEl.appendChild(makePill('All', '', true));
    categories.forEach(cat => filtersEl.appendChild(makePill(cat, cat, false)));
}

function makePill(label, category, active) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `filter-pill${active ? ' is-active' : ''}`;
    btn.dataset.category = category;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(active));
    btn.textContent = label;
    btn.addEventListener('click', () => selectFilter(btn, category));
    return btn;
}

function selectFilter(btn, category) {
    filtersEl.querySelectorAll('.filter-pill').forEach(p => {
        const on = p === btn;
        p.classList.toggle('is-active', on);
        p.setAttribute('aria-selected', String(on));
    });
    applyFilter(category);
}

//? Client-side filter: hide non-matching cards, fade the matching ones back in.
function applyFilter(category) {
    let shown = 0;
    cards.forEach(card => {
        const match = !category || card.dataset.category === category;
        card.classList.toggle('is-hidden', !match);
        if (match) {
            card.style.transitionDelay = `${Math.min(shown, 8) * 0.04}s`;
            card.classList.add('is-filtering');
            requestAnimationFrame(() => card.classList.remove('is-filtering'));
            shown++;
        }
    });
}
