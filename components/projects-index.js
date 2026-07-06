import { projects } from './project-data.js';

/* <projects-index category="..." label="...">
   Editorial index rows for the homepage projects section: one full-width
   tappable row per registry entry (newest first, same order rule as
   <projects-grid>). The clay/cobalt/pine accent cycle runs continuously
   across every instance on the page, which works because custom elements
   upgrade in document order. Each group collapses to COLLAPSE_LIMIT rows
   behind its own Show More toggle.
   The about page keeps <projects-grid>; this component is homepage-only. */

const ACCENTS = ['var(--clay)', 'var(--cobalt)', 'var(--pine)'];
const COLLAPSE_LIMIT = 3;
let rowCount = 0;

/* Human labels for the secondary link chips (every link beyond the primary). */
const CHIP_LABELS = {
  visitSite: { label: 'Website', icon: 'fas fa-external-link-alt' },
  readMore: { label: 'Read more', icon: 'fas fa-external-link-alt' },
  code: { label: 'Code', icon: 'fab fa-github' },
  demo: { label: 'Demo', icon: 'fas fa-play' },
};

/* Primary destination priority; the whole row links here. */
const PRIMARY_ORDER = ['visitSite', 'readMore', 'code', 'demo'];

function linkTarget(kind, data) {
  if (kind === 'readMore' && data.noTarget) return '';
  return ' target="_blank" rel="noopener"';
}

/* ------------------------------------------------------------------
   Cursor stamp: one tilted icon card shared by all instances, lerped
   after the cursor while a row is hovered. Desktop pointers only.
   ------------------------------------------------------------------ */
const fancyPointer =
  window.matchMedia('(hover: hover) and (pointer: fine)').matches &&
  !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const stamp = {
  el: null,
  x: 0, y: 0,
  tx: 0, ty: 0,
  vx: 0,
  raf: 0,
  on: false,

  ensure() {
    if (this.el) return;
    this.el = document.createElement('div');
    this.el.className = 'pindex-stamp';
    this.el.setAttribute('aria-hidden', 'true');
    this.el.innerHTML = '<span class="pindex-stamp__card"><i></i></span>';
    document.body.appendChild(this.el);
  },

  show(iconClass, accent, x, y) {
    this.ensure();
    this.el.querySelector('i').className = iconClass;
    this.el.style.setProperty('--acc', accent);
    if (!this.on) { this.x = x; this.y = y; }
    this.tx = x; this.ty = y;
    this.on = true;
    this.el.classList.add('is-on');
    if (!this.raf) this.tick();
  },

  move(x, y) {
    this.tx = x; this.ty = y;
  },

  hide() {
    this.on = false;
    if (this.el) this.el.classList.remove('is-on');
  },

  tick() {
    const dx = this.tx - this.x;
    this.x += dx * 0.16;
    this.y += (this.ty - this.y) * 0.16;
    /* Small velocity tilt so the stamp leans into the motion. */
    this.vx += (Math.max(-10, Math.min(10, dx * 0.22)) - this.vx) * 0.12;
    this.el.style.transform =
      `translate3d(${this.x}px, ${this.y}px, 0) rotate(${this.vx}deg)`;
    const settled = !this.on && Math.abs(dx) < 0.5 && Math.abs(this.ty - this.y) < 0.5;
    this.raf = settled ? 0 : requestAnimationFrame(() => this.tick());
  },
};

class ProjectsIndex extends HTMLElement {
  connectedCallback() {
    this.classList.add('pindex');
    const category = this.getAttribute('category');
    const label = this.getAttribute('label') || '';
    const entries = Object.entries(projects)
      .filter(([, data]) => data.category === category)
      .reverse();

    const rows = entries.map(([, data], i) => {
      const accent = ACCENTS[rowCount++ % ACCENTS.length];
      const links = data.links || {};
      const primaryKind = PRIMARY_ORDER.find(k => links[k] && links[k].trim());
      const primary = primaryKind ? links[primaryKind] : '#';

      const chips = PRIMARY_ORDER
        .filter(k => k !== primaryKind && links[k] && links[k].trim())
        .map(k => `<a class="pindex__chip" href="${links[k]}"${linkTarget(k, data)}>
            <i class="${CHIP_LABELS[k].icon}"></i>${CHIP_LABELS[k].label}</a>`)
        .join('');

      const badge = data.badge && data.badge.trim()
        ? `<span class="pindex__badge">${data.badge}</span>` : '';

      const hidden = i >= COLLAPSE_LIMIT ? ' pindex__row--hidden' : '';

      return `
        <article class="pindex__row reveal${hidden}" style="--acc:${accent}" data-icon="${data.iconClass}">
          <a class="pindex__cover" href="${primary}"${linkTarget(primaryKind, data)}
             aria-label="${data.title}"></a>
          <div class="pindex__body">
            <h4 class="pindex__title"><span class="pindex__title-text">${data.title}</span>${badge}</h4>
            <p class="pindex__desc">${data.description}</p>
          </div>
          <div class="pindex__meta">
            ${chips}
            <span class="pindex__arrow" aria-hidden="true">&#8599;</span>
          </div>
        </article>`;
    }).join('');

    this.innerHTML = `
      <header class="pindex__head">
        <h3 class="pindex__cat">${label}</h3>
        <span class="pindex__rule" aria-hidden="true"></span>
        <span class="pindex__count" aria-hidden="true">${String(entries.length).padStart(2, '0')}</span>
      </header>
      <div class="pindex__rows">${rows}</div>`;

    this.initShowMore(entries.length);
    if (fancyPointer) this.initStamp();
  }

  initShowMore(total) {
    if (total <= COLLAPSE_LIMIT) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pindex__more';
    btn.innerHTML = `<span>Show More</span><i aria-hidden="true">+${total - COLLAPSE_LIMIT}</i>`;
    let expanded = false;
    btn.addEventListener('click', () => {
      expanded = !expanded;
      this.querySelectorAll('.pindex__row').forEach((row, i) => {
        if (i >= COLLAPSE_LIMIT) row.classList.toggle('pindex__row--hidden', !expanded);
      });
      btn.querySelector('span').textContent = expanded ? 'Show Less' : 'Show More';
      btn.querySelector('i').textContent = expanded ? '−' : `+${total - COLLAPSE_LIMIT}`;
    });
    this.appendChild(btn);
  }

  initStamp() {
    this.querySelectorAll('.pindex__row').forEach(row => {
      row.addEventListener('pointerenter', e => {
        stamp.show(row.dataset.icon, row.style.getPropertyValue('--acc'), e.clientX, e.clientY);
      });
      row.addEventListener('pointerleave', () => stamp.hide());
    });
    this.addEventListener('pointermove', e => stamp.move(e.clientX, e.clientY));
  }
}

customElements.define('projects-index', ProjectsIndex);
