import { projects } from './project-data.js';
import { resolveLink, opensNewTab } from './project-links.js';

class ProjectCard extends HTMLElement {
  connectedCallback() {
    this.render();
  }

  render() {
    const key = this.getAttribute('project');
    const site = this.getAttribute('site') || '';
    const data = projects[key];

    if (!data) {
      this.innerHTML = `<div class="project-card error">⚠️ Project "${key}" not found.</div>`;
      return;
    }

    const badgeContent = data.badge && data.badge.trim();
    const badgeHtml = badgeContent ? `<div class="project-badge">${badgeContent}</div>` : '';

    /* New-tab behaviour comes from the shared opensNewTab() rather than a
       hardcoded target, so a same-site readMore stays in the tab exactly as
       it does everywhere else that renders registry links. Anything that
       does open a new tab carries rel="noopener noreferrer". */
    const LINKS = [
      ['visitSite', 'fas fa-external-link-alt', 'Website'],
      ['readMore', 'fas fa-external-link-alt', 'Read More'],
      ['code', 'fab fa-github', 'Code'],
      ['demo', 'fas fa-play', 'Live Demo'],
    ];

    const projectLinks = LINKS
      .filter(([kind]) => data.links && data.links[kind] && data.links[kind].trim())
      .map(([kind, icon, label]) => {
        const target = opensNewTab(kind, data)
          ? ' target="_blank" rel="noopener noreferrer"'
          : '';
        return `
        <a href="${resolveLink(data.links[kind], site)}" class="project-link"${target}>
          <i class="${icon}"></i> ${label}
        </a>
      `;
      });

    const projectLinksHtml = projectLinks.length > 0 ? 
      `<div class="project-links">${projectLinks.join('')}</div>` : '';

    this.innerHTML = `
      <div class="project-image">
        ${badgeHtml}
        <div class="project-image-background">
          <i class="${data.iconClass}"></i>
        </div>
      </div>
      <div class="project-content">
        <h3 class="project-title">${data.title}</h3>
        <p class="project-description">${data.description}</p>
        <div class="project-footer">
          ${projectLinksHtml}
        </div>
      </div>
    `;
  }
}

customElements.define('project-card', ProjectCard);
