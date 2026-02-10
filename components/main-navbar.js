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

customElements.define('main-navbar', MainNavbar);