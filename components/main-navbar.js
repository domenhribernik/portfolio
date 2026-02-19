class MainNavbar extends HTMLElement {
    connectedCallback() {
        const site = this.getAttribute('site') || '';
        this.innerHTML = `
            <nav class="navbar">
                <div class="nav-container">
                    <a href="${site}#home" class="logo">Domen Hribernik</a>
                    <ul class="nav-menu" id="navMenu">
                        <li><a href="${site}#about" class="nav-link">About</a></li>
                        <li><a href="${site}#projects" class="nav-link">Projects</a></li>
                        <li><a href="${site}#contact" class="nav-link">Contact</a></li>
                        <li><div class="gtranslate_wrapper"></div></li>
                    </ul>
                    <button class="mobile-menu-btn" id="mobileMenuBtn">
                        <i class="fas fa-bars"></i>
                    </button>
                </div>
            </nav>
        `;
    }
}

window.addEventListener('DOMContentLoaded', () => {
    const mobileMenuBtn = document.getElementById('mobileMenuBtn');
    const navMenu = document.getElementById('navMenu');

    mobileMenuBtn.addEventListener('click', () => {
        navMenu.classList.toggle('active');
    });

    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            e.preventDefault();
            const target = document.querySelector(this.getAttribute('href'));
            if (target) {
                target.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start'
                });

                navMenu.classList.remove('active');
            }
        });
    });

    //? Navbar background on scroll
    window.addEventListener('scroll', () => {
        const navbar = document.querySelector('.navbar');
        if (window.scrollY > 100) {
            navbar.style.background = 'rgba(15, 23, 42, 0.98)';
        } else {
            navbar.style.background = 'rgba(15, 23, 42, 0.95)';
        }
    });
});

customElements.define('main-navbar', MainNavbar);
