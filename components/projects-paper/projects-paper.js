import { projects } from '../project-data.js';
import {
  buildSections,
  primaryLink,
  opensNewTab,
  secondaryLinks,
  splitStories,
  MOBILE_VISIBLE,
} from './logic.js';

/* <projects-paper>
   The homepage projects section as one newspaper front page. Above the
   fold: Professional & Freelance as the top-stories band, the newest
   project set as a big splash story with the rest in ruled columns
   beside it. Below: Passion Projects as the dense inside-pages index,
   every brief flowing through real CSS newspaper columns. Academic work
   is deliberately not carried here; a cross-reference line at the foot
   of the paper points to the about page where it runs in full.
   Each story is one stretched-link tap target; hover is deliberately
   quiet (headline underlines in the section accent, nothing moves).
   On phones each section folds past MOBILE_VISIBLE stories behind a
   mobile-only "More stories" line (the fold classes are inert on wider
   viewports, where every story always prints).
   Styles live in views/homepage/kinetic.css under "PROJECTS PAPER". */

function targetAttr(kind, data) {
  return opensNewTab(kind, data) ? ' target="_blank" rel="noopener"' : '';
}

function storyHtml(data, extraClass = '') {
  const { kind, href } = primaryLink(data.links);
  const badge = data.badge && data.badge.trim()
    ? ` <span class="ppaper__badge">${data.badge}</span>` : '';
  const refs = secondaryLinks(data.links)
    .map(l => `<a class="ppaper__ref" href="${l.href}"${targetAttr(l.kind, data)}>${l.label}</a>`)
    .join('<span class="ppaper__ref-sep" aria-hidden="true">·</span>');

  return `
    <article class="ppaper__story${extraClass}">
      <a class="ppaper__cover" href="${href}"${targetAttr(kind, data)}
         aria-label="${data.title}"></a>
      <h4 class="ppaper__headline">${data.title}${badge}</h4>
      <p class="ppaper__deck">${data.description}</p>
      ${refs ? `<p class="ppaper__refs">${refs}</p>` : ''}
    </article>`;
}

function secheadHtml(section, accentName) {
  return `
    <header class="ppaper__sechead" style="--acc:var(--${accentName})">
      <h3 class="ppaper__sectitle">${section.label}</h3>
      <span class="ppaper__seccount" aria-hidden="true">${String(section.entries.length).padStart(2, '0')}</span>
    </header>`;
}

/* Stories past the phone fold get an extra class that only the mobile
   media query acts on; wider viewports print them regardless. */
function foldClass(index) {
  return index >= MOBILE_VISIBLE ? ' ppaper__story--fold' : '';
}

function moreHtml(entries) {
  const folded = entries.length - MOBILE_VISIBLE;
  if (folded <= 0) return '';
  return `
    <button type="button" class="ppaper__more" aria-expanded="false">
      <span>More stories</span><i aria-hidden="true">+${folded}</i>
    </button>`;
}

class ProjectsPaper extends HTMLElement {
  connectedCallback() {
    this.classList.add('ppaper');
    const [professional, passion] = buildSections(projects);
    const total = professional.entries.length + passion.entries.length;

    const { lead: splash, briefs: bandRest } = splitStories(professional.entries, Infinity);
    const band = `
      <section class="ppaper__band reveal" style="--acc:var(--clay)">
        ${secheadHtml(professional, 'clay')}
        <div class="ppaper__band-grid">
          ${storyHtml(splash, ' ppaper__story--splash')}
          ${bandRest.map((d, i) => storyHtml(d, foldClass(i + 1))).join('')}
        </div>
        ${moreHtml(professional.entries)}
      </section>`;

    const briefs = `
      <section class="ppaper__inside reveal" style="--acc:var(--cobalt)">
        ${secheadHtml(passion, 'cobalt')}
        <div class="ppaper__briefs">
          ${passion.entries.map((d, i) => storyHtml(d, ' ppaper__story--brief' + foldClass(i))).join('')}
        </div>
        ${moreHtml(passion.entries)}
      </section>`;

    this.innerHTML = `
      <div class="ppaper__mast reveal" aria-hidden="true">
        <span>Domen Hribernik · Selected Work</span>
        <span>${total} stories</span>
      </div>
      ${band}
      ${briefs}
      <a class="ppaper__crossref reveal" href="views/about/#academic-projects">
        <span class="ppaper__crossref-label">Academic &amp; Research</span>
        continues on the About page <span aria-hidden="true">&#8599;</span>
      </a>`;

    this.querySelectorAll('.ppaper__more').forEach(btn => {
      const section = btn.closest('section');
      const folded = section.querySelectorAll('.ppaper__story--fold').length;
      btn.addEventListener('click', () => {
        const open = section.classList.toggle('ppaper__sec--unfolded');
        btn.setAttribute('aria-expanded', String(open));
        btn.querySelector('span').textContent = open ? 'Fewer stories' : 'More stories';
        btn.querySelector('i').textContent = open ? '−' : `+${folded}`;
      });
    });
  }
}

customElements.define('projects-paper', ProjectsPaper);
