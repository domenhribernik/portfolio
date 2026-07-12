import { projects } from './project-data.js';
import { resolveLink } from './project-links.js';

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

    const projectLinks = [];
    

    if (data.links && data.links.visitSite && data.links.visitSite.trim()) {
      projectLinks.push(`
        <a href="${resolveLink(data.links.visitSite, site)}" class="project-link" target="_blank">
          <i class="fas fa-external-link-alt"></i> Website
        </a>
      `);
    }

    if (data.links && data.links.readMore && data.links.readMore.trim()) {
      projectLinks.push(`
        <a href="${resolveLink(data.links.readMore, site)}" class="project-link" ${data.noTarget ? "" : 'target="_blank"'}>
          <i class="fas fa-external-link-alt"></i> Read More
        </a>
      `);
    }
    
    if (data.links && data.links.code && data.links.code.trim()) {
      projectLinks.push(`
        <a href="${resolveLink(data.links.code, site)}" class="project-link" target="_blank">
          <i class="fab fa-github"></i> Code
        </a>
      `);
    }
    
    if (data.links && data.links.demo && data.links.demo.trim()) {
      projectLinks.push(`
        <a href="${resolveLink(data.links.demo, site)}" class="project-link" target="_blank">
          <i class="fas fa-play"></i> Live Demo
        </a>
      `);
    }

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
        <h4 class="project-title">${data.title}</h4>
        <p class="project-description">${data.description}</p>
        <div class="project-footer">
          ${projectLinksHtml}
        </div>
      </div>
    `;
  }
}

customElements.define('project-card', ProjectCard);
