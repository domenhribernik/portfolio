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

    //? Show More functionality for project categories.
    //  Collapsed count is viewport-aware: 4 on mobile (a clean 2x2 block in the
    //  two-column phone grid) and 3 on desktop. Re-evaluated live on resize.
    const initShowMore = () => {
        const mq = window.matchMedia('(max-width: 640px)');
        const getLimit = () => (mq.matches ? 4 : 3);

        document.querySelectorAll('.project-category').forEach(category => {
            // Skip if already initialized
            if (category.dataset.showMoreInitialized) return;

            const grid = category.querySelector('.projects-grid');
            const projects = Array.from(category.querySelectorAll('.project-card'));
            // 3 is the smallest possible limit, so fewer than that can never overflow.
            if (projects.length <= 3) return;

            const toggleBtn = document.createElement('button');
            toggleBtn.className = 'show-more-btn';
            const engSpan = document.createElement('span');
            engSpan.className = 'lang-eng';
            toggleBtn.appendChild(engSpan);

            let expanded = false;

            const apply = () => {
                const limit = getLimit();
                const overflows = projects.length > limit;
                projects.forEach((project, index) => {
                    project.style.display = (expanded || index < limit) ? 'flex' : 'none';
                });
                // Hide the toggle entirely when the current limit already fits everything.
                toggleBtn.style.display = overflows ? '' : 'none';
                engSpan.textContent = expanded ? 'Show Less' : 'Show More';
            };

            toggleBtn.addEventListener('click', () => {
                expanded = !expanded;
                apply();
            });
            mq.addEventListener('change', apply);

            grid.after(toggleBtn);
            category.dataset.showMoreInitialized = 'true';
            apply();
        });
    };

    // Wait for custom elements to be defined before initializing
    customElements.whenDefined('project-card').then(() => {
        // Small delay to ensure all cards are rendered
        setTimeout(initShowMore, 100);
    });
});
