import { projects } from '../project-data.js';
import { primaryLink, opensNewTab } from '../project-links.js';
import { featuredEntries, professionalEntries, archiveCount } from './logic.js';

/* <projects-index>
   The homepage projects section as a kinetic index: a compact
   Professional & Freelance band up top (quiet ruled stories, same
   grammar as the old paper), then the hand-ranked featured selection
   as big numbered headline rows. Hover stays quiet everywhere: the
   headline underlines in the section accent, the number and arrow
   take the accent, the arrow nudges. The section closes with the
   edition banner handing off to views/projects, where every project
   runs in full. Every story and row is one stretched-link tap target.
   None of the homepage entries carry links beyond the primary; the
   full edition renders those, so this component deliberately doesn't.
   Styles live in views/homepage/kinetic.css under "PROJECTS INDEX". */

function targetAttr(kind, data) {
  return opensNewTab(kind, data) ? ' target="_blank" rel="noopener"' : '';
}

function bandStoryHtml(data) {
  const { kind, href } = primaryLink(data.links);
  return `
    <article class="pindex__story">
      <a class="pindex__cover" href="${href}"${targetAttr(kind, data)}
         aria-label="${data.title}"></a>
      <h4 class="pindex__story-head">${data.title}</h4>
      <p class="pindex__story-deck">${data.description}</p>
    </article>`;
}

function rowHtml(data, i) {
  const { kind, href } = primaryLink(data.links);
  return `
    <li class="pindex__row">
      <a class="pindex__cover" href="${href}"${targetAttr(kind, data)}
         aria-label="${data.title}"></a>
      <span class="pindex__num" aria-hidden="true">${String(i + 1).padStart(2, '0')}</span>
      <div class="pindex__body">
        <h4 class="pindex__headline">${data.title}</h4>
        <p class="pindex__deck">${data.description}</p>
      </div>
      <span class="pindex__go" aria-hidden="true">&#8599;</span>
    </li>`;
}

function secheadHtml(label, count, accentName) {
  return `
    <header class="pindex__sechead" style="--acc:var(--${accentName})">
      <h3 class="pindex__sectitle">${label}</h3>
      <span class="pindex__seccount" aria-hidden="true">${String(count).padStart(2, '0')}</span>
    </header>`;
}

class ProjectsIndex extends HTMLElement {
  connectedCallback() {
    this.classList.add('pindex');
    const band = professionalEntries(projects);
    const rows = featuredEntries(projects);
    const total = archiveCount(projects);

    this.innerHTML = `
      <section class="pindex__band reveal">
        ${secheadHtml('Professional & Freelance', band.length, 'clay')}
        <div class="pindex__band-grid">
          ${band.map(bandStoryHtml).join('')}
        </div>
      </section>

      <section class="pindex__featured reveal">
        ${secheadHtml('Featured builds', rows.length, 'cobalt')}
        <ol class="pindex__rows">
          ${rows.map(rowHtml).join('')}
        </ol>
      </section>

      <a class="pindex__edition reveal" href="views/projects/">
        <span class="pindex__edition-rule" aria-hidden="true"></span>
        <span class="pindex__edition-line">
          <strong>Read the full edition</strong>
          <span class="pindex__edition-note">All ${total} projects &middot; professional / passion / academic</span>
        </span>
        <span class="pindex__edition-go" aria-hidden="true">&#8599;</span>
      </a>`;
  }
}

customElements.define('projects-index', ProjectsIndex);
