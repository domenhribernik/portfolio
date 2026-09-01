class MainNavbar extends HTMLElement {
    connectedCallback() {
        const site = this.getAttribute('site') || '';
        //? The bar is light by default (see .navbar in base-style.css). A page
        //  whose ground is dark opts into the retired navy skin explicitly.
        const dark = this.getAttribute('theme') === 'dark' ? ' navbar--dark' : '';
        this.innerHTML = `
            <nav class="navbar${dark}">
                <div class="nav-container">
                    <a href="${site}#home" class="logo" aria-label="Domen Hribernik — home">
                        <span class="logo__mark" aria-hidden="true">DH</span>
                        <span class="logo__name notranslate" translate="no">Domen Hribernik<span class="logo__dot">.</span></span>
                    </a>
                    <ul class="nav-menu" id="navMenu">
                        <li><a href="${site}#about" class="nav-link">About</a></li>
                        <li><a href="${site}#projects" class="nav-link">Projects</a></li>
                        <li><a href="${site}#contact" class="nav-link">Contact</a></li>
                        <li class="lang-picker" id="langPicker">
                            <button class="lang-picker__trigger" id="langPickerBtn" aria-haspopup="true" aria-expanded="false" aria-label="Select language">
                                <span class="lang-picker__flag" id="langPickerFlag" aria-hidden="true"></span>
                                <span class="lang-picker__code" id="langPickerCode">EN</span>
                                <i class="fas fa-chevron-down lang-picker__caret" aria-hidden="true"></i>
                            </button>
                            <div class="gtranslate_wrapper lang-picker__panel"></div>
                        </li>
                    </ul>
                    <button class="mobile-menu-btn" id="mobileMenuBtn" type="button"
                            aria-label="Open menu" aria-expanded="false" aria-controls="navMenu">
                        <i class="fas fa-bars" aria-hidden="true"></i>
                    </button>
                </div>
            </nav>
        `;
    }
}

window.addEventListener('DOMContentLoaded', () => {
    const mobileMenuBtn = document.getElementById('mobileMenuBtn');
    const navMenu = document.getElementById('navMenu');

    //? A page can load this module without rendering <main-navbar>; bail
    //  rather than throwing on a null button and killing the rest of the file.
    if (!mobileMenuBtn || !navMenu) return;

    const setMenuOpen = open => {
        navMenu.classList.toggle('active', open);
        mobileMenuBtn.setAttribute('aria-expanded', String(open));
        mobileMenuBtn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    };

    mobileMenuBtn.addEventListener('click', () => {
        setMenuOpen(!navMenu.classList.contains('active'));
    });

    //? Respect the OS "reduce motion" setting: a smooth scroll is exactly the
    //  vestibular motion that setting exists to suppress. Read it per click so
    //  a mid-session change is honoured.
    const prefersReducedMotion = () =>
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            const hash = this.getAttribute('href');
            if (hash === '#') return;
            const target = document.querySelector(hash);
            if (!target) return;              // let the browser handle a dead anchor
            e.preventDefault();
            target.scrollIntoView({
                behavior: prefersReducedMotion() ? 'auto' : 'smooth',
                block: 'start'
            });
            setMenuOpen(false);
        });
    });

    //? Wayfinding: mark the nav link whose section is currently in view, so
    //  assistive tech can answer "where am I?". Purely semantic, no styling,
    //  and it self-disables on pages that have none of these sections.
    const spied = [...navMenu.querySelectorAll('.nav-link[href*="#"]')]
        .map(link => {
            const id = link.getAttribute('href').split('#')[1];
            return { link, section: id ? document.getElementById(id) : null };
        })
        .filter(entry => entry.section);

    if (spied.length && 'IntersectionObserver' in window) {
        const spy = new IntersectionObserver(entries => {
            entries.forEach(entry => {
                const hit = spied.find(s => s.section === entry.target);
                if (!hit) return;
                if (entry.isIntersecting) {
                    spied.forEach(s => s.link.removeAttribute('aria-current'));
                    hit.link.setAttribute('aria-current', 'true');
                }
            });
        }, { rootMargin: '-45% 0px -45% 0px' });
        spied.forEach(s => spy.observe(s.section));
    }

    const langPicker = document.getElementById('langPicker');
    const langPickerBtn = document.getElementById('langPickerBtn');
    if (langPicker && langPickerBtn) {
        langPickerBtn.addEventListener('click', e => {
            e.stopPropagation();
            const open = langPicker.classList.toggle('open');
            langPickerBtn.setAttribute('aria-expanded', open);
        });
        document.addEventListener('click', () => {
            langPicker.classList.remove('open');
            langPickerBtn.setAttribute('aria-expanded', 'false');
        });
        langPicker.addEventListener('click', e => e.stopPropagation());

        //? Reflect the active GTranslate language in the trigger + dropdown.
        //  GTranslate stores the choice in the `googtrans` cookie (e.g. /en/sl).
        const LANG_NAMES = { en: 'English', sl: 'Slovenian', de: 'German', es: 'Spanish', fr: 'French', 'zh-CN': 'Chinese (Simplified)' };
        const LANG_CODES = { en: 'EN', sl: 'SL', de: 'DE', es: 'ES', fr: 'FR', 'zh-CN': 'ZH' };

        const currentLang = () => {
            const m = document.cookie.match(/(?:^|;\s*)googtrans=([^;]+)/);
            if (!m) return 'en';
            const parts = decodeURIComponent(m[1]).split('/').filter(Boolean);
            return parts.length ? parts[parts.length - 1] : 'en';
        };

        const linkLang = a => {
            const m = (a.getAttribute('onclick') || '').match(/doGTranslate\('[^']*\|([^']+)'/);
            if (m) return m[1];
            const title = (a.getAttribute('title') || a.textContent || '').trim();
            return Object.keys(LANG_NAMES).find(code => LANG_NAMES[code] === title) || '';
        };

        const codeEl = document.getElementById('langPickerCode');
        const flagEl = document.getElementById('langPickerFlag');

        const syncLangPicker = () => {
            const wrapper = langPicker.querySelector('.gtranslate_wrapper');
            const links = wrapper ? wrapper.querySelectorAll('a') : [];
            if (!links.length) return false;
            const cur = currentLang();
            let activeLink = null;
            links.forEach(a => {
                const on = linkLang(a) === cur;
                a.classList.toggle('is-active', on);
                if (on) activeLink = a;
            });
            if (codeEl) codeEl.textContent = LANG_CODES[cur] || cur.toUpperCase();
            if (flagEl) {
                const img = activeLink && activeLink.querySelector('img');
                flagEl.innerHTML = img ? `<img src="${img.getAttribute('src')}" alt="">` : '';
            }
            langPickerBtn.setAttribute('title', LANG_NAMES[cur] || cur);
            return true;
        };

        //? GTranslate renders the flag links asynchronously; watch for them.
        if (!syncLangPicker()) {
            const obs = new MutationObserver(() => { if (syncLangPicker()) obs.disconnect(); });
            obs.observe(langPicker, { childList: true, subtree: true });
        }

        //? Re-sync after a pick in case GTranslate swaps in place without a reload.
        langPicker.addEventListener('click', e => {
            if (e.target.closest('a')) {
                langPicker.classList.remove('open');
                langPickerBtn.setAttribute('aria-expanded', 'false');
                setTimeout(syncLangPicker, 150);
                setTimeout(syncLangPicker, 700);
            }
        });
    }

    //? Navbar background on scroll (theme-aware via .scrolled class).
    //  Passive, and the element is looked up once rather than on every
    //  scroll event; the class write is coalesced into one frame so a
    //  fast scroll cannot queue up hundreds of style recalculations.
    const navbar = document.querySelector('.navbar');
    if (navbar) {
        let ticking = false;
        window.addEventListener('scroll', () => {
            if (ticking) return;
            ticking = true;
            requestAnimationFrame(() => {
                navbar.classList.toggle('scrolled', window.scrollY > 100);
                ticking = false;
            });
        }, { passive: true });
    }
});

customElements.define('main-navbar', MainNavbar);
