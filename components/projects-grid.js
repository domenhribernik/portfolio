import { projects } from './project-data.js';

class ProjectsGrid extends HTMLElement {
  connectedCallback() {
    this.classList.add('projects-grid');
    const category = this.getAttribute('category');
    const entries = Object.entries(projects)
      .filter(([, data]) => data.category === category)
      .reverse();

    this.innerHTML = entries.map(([key, data]) =>
      `<project-card class="project-card" project="${key}" gradient="${data.gradient}"></project-card>`
    ).join('');
  }
}

customElements.define('projects-grid', ProjectsGrid);
