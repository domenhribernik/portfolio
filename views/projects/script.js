import { projects } from '../../components/project-data.js';
import {
    resolveLink,
    primaryLink,
    secondaryLinks,
    opensNewTab,
} from '../../components/project-links.js';
import { buildEdition, editionMeta } from './logic.js';

/* The full edition. Renders every registry project as one broadsheet:
   masthead dateline, then one section per category, each opening with
   a photo lead (section C pins Virtual Runner via its leadKey) and
   running the rest as ruled brief columns. All decisions (section
   order, the lead hoist, folios) live in logic.js; this file is only
   markup plus the masthead's live dateline. */

const SITE = '../../';

const PRIMARY_LABELS = {
    visitSite: 'Visit the site',
    readMore: 'Read the story',
    code: 'Read the source',
    demo: 'See the demo',
};

/* Section accents: A clay, B cobalt, C pine. */
const ACCENTS = { A: '#d4451f', B: '#1f35e0', C: '#2f5b53' };

function targetAttr(kind, data) {
    return opensNewTab(kind, data) ? ' target="_blank" rel="noopener"' : '';
}

function refsHtml(data) {
    const { kind, href } = primaryLink(data.links);
    const refs = [];
    if (kind) {
        refs.push(`<a class="bsheet__ref bsheet__ref--lead" href="${resolveLink(href, SITE)}"${targetAttr(kind, data)}>${PRIMARY_LABELS[kind]} <span aria-hidden="true">&#8599;</span></a>`);
    }
    for (const ref of secondaryLinks(data.links)) {
        refs.push(`<a class="bsheet__ref" href="${resolveLink(ref.href, SITE)}"${targetAttr(ref.kind, data)}>${ref.label}</a>`);
    }
    return refs.length ? `<p class="bsheet__refs">${refs.join('')}</p>` : '';
}

function badgeHtml(data) {
    return data.badge && data.badge.trim()
        ? ` <span class="bsheet__badge">${data.badge}</span>` : '';
}

/* A press photo: the project's registry gradient as the plate, its icon
   as the subject, halftone dots printed on top by the stylesheet. */
function photoHtml(data) {
    return `
        <figure class="bsheet__figure">
            <div class="bsheet__photo" style="--art:${data.gradient}">
                <i class="${data.iconClass}" aria-hidden="true"></i>
            </div>
            <figcaption class="bsheet__caption">Fig. ${data.folio} &middot; ${data.title}</figcaption>
        </figure>`;
}

function coverHtml(data) {
    const { kind, href } = primaryLink(data.links);
    if (!kind) return '';
    return `<a class="bsheet__cover" href="${resolveLink(href, SITE)}"${targetAttr(kind, data)}
        aria-label="${data.title}"></a>`;
}

function storyHtml(data) {
    return `
        <article class="bsheet__story">
            ${coverHtml(data)}
            <p class="bsheet__folio">${data.folio}</p>
            <h3 class="bsheet__head">${data.title}${badgeHtml(data)}</h3>
            <p class="bsheet__deck">${data.description}</p>
            ${refsHtml(data)}
        </article>`;
}

function leadHtml(data) {
    return `
        <article class="bsheet__story bsheet__story--lead">
            ${coverHtml(data)}
            <div class="bsheet__lead-text">
                <p class="bsheet__folio">${data.folio}</p>
                <h3 class="bsheet__head bsheet__head--lead">${data.title}${badgeHtml(data)}</h3>
                <p class="bsheet__deck">${data.description}</p>
                ${refsHtml(data)}
            </div>
            ${photoHtml(data)}
        </article>`;
}

function sectionHtml({ letter, label, entries }) {
    const [lead, ...rest] = entries;
    return `
        <section class="bsheet__sec reveal" id="section-${letter.toLowerCase()}" style="--acc:${ACCENTS[letter]}">
            <header class="bsheet__sechead">
                <span class="bsheet__sec-tag">Section ${letter}</span>
                <h2 class="bsheet__sec-label">${label}</h2>
                <span class="bsheet__sec-folio">Page ${letter}1</span>
            </header>
            ${lead ? leadHtml(lead) : ''}
            ${rest.length ? `<div class="bsheet__briefs">${rest.map(storyHtml).join('')}</div>` : ''}
        </section>`;
}

/* ---- print the edition ---- */

const edition = buildEdition(projects);
const meta = editionMeta(projects);

document.getElementById('edition').innerHTML =
    edition.sections.map(sectionHtml).join('');

for (const [key, value] of Object.entries({
    volume: `${meta.volume} &middot; ${meta.number}`,
    dateline: meta.dateline,
    count: String(meta.count),
})) {
    document.querySelector(`[data-ed="${key}"]`).innerHTML = value;
}

/* Scroll reveal, gated on JS the same way the homepage does it. */
document.body.classList.add('reveals-on');
const observer = new IntersectionObserver((entries, obs) => {
    for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-in');
        obs.unobserve(entry.target);
    }
}, { threshold: 0.08 });
document.querySelectorAll('.reveal').forEach(el => observer.observe(el));

document.getElementById('currentYear').textContent = new Date().getFullYear();
