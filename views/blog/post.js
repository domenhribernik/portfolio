import { loadPost, formatDate, readingTime } from './blog.js';

const yearEl = document.getElementById('currentYear');
if (yearEl) yearEl.textContent = new Date().getFullYear();

const articleEl = document.getElementById('article');
const eyebrowEl = document.getElementById('post-eyebrow');
const titleEl = document.getElementById('post-title');
const metaEl = document.getElementById('post-meta');
const progressEl = document.getElementById('read-progress');

const slug = new URLSearchParams(location.search).get('slug');

if (!slug) {
    showError('No post selected.');
} else {
    loadPost(slug).then(render).catch(() => showError('That post could not be found.'));
}

function render(post) {
    const { title = post.slug, author = '', date = '', tag = '' } = post.meta;

    document.title = `${title} - Domen Hribernik`;
    eyebrowEl.textContent = tag || 'Blog';
    titleEl.textContent = title;

    const bits = [];
    if (date) bits.push(`<time datetime="${date}">${formatDate(date)}</time>`);
    if (author) bits.push(`<span>${author}</span>`);
    bits.push(`<span>${readingTime(post.body)} min read</span>`);
    metaEl.innerHTML = bits.join('<span class="post-meta__sep">/</span>');

    if (window.marked) {
        marked.setOptions({ gfm: true, breaks: false, headerIds: true, mangle: false });
        articleEl.innerHTML = marked.parse(post.body);
    } else {
        articleEl.textContent = post.body;
    }

    document.querySelector('.post-shell')?.classList.add('is-ready');
}

function showError(message) {
    eyebrowEl.textContent = 'Blog';
    titleEl.textContent = 'Not found';
    metaEl.textContent = '';
    articleEl.innerHTML = `<p>${message}</p><p><a href="index.html">Back to all writing</a></p>`;
}

//? Thin reading-progress bar across the top of the page.
if (progressEl) {
    const update = () => {
        const doc = document.documentElement;
        const scrollable = doc.scrollHeight - doc.clientHeight;
        const pct = scrollable > 0 ? (doc.scrollTop / scrollable) * 100 : 0;
        progressEl.style.transform = `scaleX(${Math.min(pct, 100) / 100})`;
    };
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    update();
}
