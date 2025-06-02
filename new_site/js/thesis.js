    window.addEventListener('load', function() {
        const loadingOverlay = document.getElementById('loadingOverlay');
        setTimeout(() => {
            loadingOverlay.classList.add('hidden');
        }, 1000);
    });

    // Mobile menu toggle
    const mobileMenuBtn = document.getElementById('mobileMenuBtn');
    const navMenu = document.getElementById('navMenu');

    mobileMenuBtn.addEventListener('click', function() {
        navMenu.classList.toggle('active');
    });

    // Language toggle
    const langButtons = document.querySelectorAll('.lang-btn');

    langButtons.forEach(btn => {
        btn.addEventListener('click', function () {
            const lang = this.dataset.lang;

            // Update active button
            langButtons.forEach(b => b.classList.remove('active'));
            this.classList.add('active');

            // Update body class
            // if (lang === 'slo') {
            //     document.body.classList.add('lang-slo');
            // } else {
            //     document.body.classList.remove('lang-slo');
            // }

            // Store preference
            localStorage.setItem('preferredLanguage', lang);
        });
    });

    // Restore language preference on load
    window.addEventListener('DOMContentLoaded', function () {
        const preferredLang = localStorage.getItem('preferredLanguage') || 'eng';
        const targetButton = document.querySelector(`.lang-btn[data-lang="${preferredLang}"]`);
        if (targetButton) {
            targetButton.click();
        }

        // Set current year in footer
        document.getElementById('currentYear').textContent = new Date().getFullYear();
    });