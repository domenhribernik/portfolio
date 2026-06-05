window.addEventListener('DOMContentLoaded', () => {
    document.getElementById('currentYear').textContent = new Date().getFullYear();

    //? Scroll reveal (gate hidden state on JS so content stays visible if this script never runs)
    document.body.classList.add('reveals-on');

    const revealObserver = new IntersectionObserver((entries, obs) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('is-visible');
                obs.unobserve(entry.target);
            }
        });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });

    document.querySelectorAll('.reveal').forEach(el => revealObserver.observe(el));

    //? Show More functionality for project categories (collapse past 3 cards)
    const initShowMore = () => {
        const categories = document.querySelectorAll('.project-category');

        categories.forEach(category => {
            if (category.dataset.showMoreInitialized) return;

            const projects = category.querySelectorAll('.project-card');
            if (projects.length > 3) {
                projects.forEach((project, index) => {
                    if (index >= 3) {
                        project.style.display = 'none';
                    }
                });

                const toggleBtn = document.createElement('button');
                toggleBtn.className = 'show-more-btn';

                const engSpan = document.createElement('span');
                engSpan.className = 'lang-eng';
                engSpan.textContent = 'Show More';
                toggleBtn.appendChild(engSpan);

                let expanded = false;
                toggleBtn.addEventListener('click', () => {
                    expanded = !expanded;
                    projects.forEach((project, index) => {
                        if (index >= 3) {
                            project.style.display = expanded ? 'flex' : 'none';
                        }
                    });
                    engSpan.textContent = expanded ? 'Show Less' : 'Show More';
                });

                category.querySelector('.projects-grid').after(toggleBtn);
                category.dataset.showMoreInitialized = 'true';
            }
        });
    };

    customElements.whenDefined('project-card').then(() => {
        setTimeout(initShowMore, 100);
    });
});
