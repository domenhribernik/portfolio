class MainNavbar extends HTMLElement {
    connectedCallback() {
        const site = this.getAttribute('site') || '';
        this.innerHTML = `
            <nav class="navbar">
                <div class="nav-container">
                    <a href="${site}#home" class="logo">Domen Hribernik</a>
                    <ul class="nav-menu" id="navMenu">
                        <li><a href="${site}#about" class="nav-link">
                                <span class="lang-eng">About</span>
                                <span class="lang-slo">O Meni</span>
                            </a></li>
                        <li><a href="${site}#projects" class="nav-link">
                                <span class="lang-eng">Projects</span>
                                <span class="lang-slo">Projekti</span>
                            </a></li>
                        <li><a href="${site}#contact" class="nav-link">
                                <span class="lang-eng">Contact</span>
                                <span class="lang-slo">Kontakt</span>
                            </a></li>
                        <li class="language-toggle">
                            <button class="lang-btn active" data-lang="eng">ENG</button>
                            <button class="lang-btn" data-lang="slo">SLO</button>
                        </li>
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