/*!
* Start Bootstrap - Grayscale v7.0.6 (https://startbootstrap.com/theme/grayscale)
* Copyright 2013-2024 Start Bootstrap
* Licensed under MIT (https://github.com/StartBootstrap/startbootstrap-grayscale/blob/master/LICENSE)
*/
//
// Scripts
// 

window.addEventListener('DOMContentLoaded', event => {

    // Navbar shrink function
    var navbarShrink = function () {
        const navbarCollapsible = document.body.querySelector('#mainNav');
        if (!navbarCollapsible) {
            return;
        }
        if (window.scrollY === 0) {
            navbarCollapsible.classList.remove('navbar-shrink')
        } else {
            navbarCollapsible.classList.add('navbar-shrink')
        }

    };

    // Shrink the navbar 
    navbarShrink();

    // Shrink the navbar when page is scrolled
    document.addEventListener('scroll', navbarShrink);

    // Activate Bootstrap scrollspy on the main nav element
    const mainNav = document.body.querySelector('#mainNav');
    if (mainNav) {
        new bootstrap.ScrollSpy(document.body, {
            target: '#mainNav',
            rootMargin: '0px 0px -40%',
        });
    };

    // Collapse responsive navbar when toggler is visible
    const navbarToggler = document.body.querySelector('.navbar-toggler');
    const responsiveNavItems = [].slice.call(
        document.querySelectorAll('#navbarResponsive .nav-link')
    );
    responsiveNavItems.map(function (responsiveNavItem) {
        responsiveNavItem.addEventListener('click', () => {
            if (window.getComputedStyle(navbarToggler).display !== 'none') {
                navbarToggler.click();
            }
        });
    });

    // Language toggle
    const langToggle = document.getElementById('langToggle');
    const body = document.body;
    const engText = document.querySelector('.eng-text');
    const sloText = document.querySelector('.slo-text');
    const engElements = document.querySelectorAll('.lang-eng');
    const sloElements = document.querySelectorAll('.lang-slo');

    // Load saved language from localStorage
    const savedLang = localStorage.getItem('siteLanguage');
    if (savedLang === 'slovenian') {
        body.classList.add('slovenian');
        langToggle.checked = true;
        engText.classList.remove('active');
        sloText.classList.add('active');
        sloElements.forEach(el => el.style.display = 'inline-block');
        engElements.forEach(el => el.style.display = 'none');
    } else {
        // Default to English if no saved language
        engText.classList.add('active');
        sloText.classList.remove('active');
        sloElements.forEach(el => el.style.display = 'none');
        engElements.forEach(el => el.style.display = 'inline-block');
    }
    
    // Toggle language on click
    langToggle.addEventListener('click', () => {
        
        body.classList.toggle('slovenian');
        engText.classList.toggle('active');
        sloText.classList.toggle('active');

        if (body.classList[0] === 'slovenian') {
            sloElements.forEach(el => el.style.display = 'inline-block');
            engElements.forEach(el => el.style.display = 'none');
        } else {
            sloElements.forEach(el => el.style.display = 'none');
            engElements.forEach(el => el.style.display = 'inline-block');
        }

        // Save the current language to localStorage
        const currentLang = body.classList.contains('slovenian') ? 'slovenian' : 'english';
        localStorage.setItem('siteLanguage', currentLang);
    });

});

let loadFromMemory = () => {
    fetch('assets/quotes.json')
        .then(response => response.json())
        .then(data => {
            const randomQuote = data[Math.floor(Math.random() * data.length)];
            document.querySelector("blockquote p").textContent = `"${randomQuote.content}"`;
            document.querySelector(".blockquote-footer").textContent = `${randomQuote.author || "Unknown"}`;
        })
        .catch(error => {
            console.error('Error fetching or parsing quotes.json:', error);
        });
}

window.document.addEventListener('DOMContentLoaded', async () => {
    // Get Quote
    try {
        fetch("https://api.quotable.io/quotes/random?tags=famous-quotes||wisdom||technology")
            .then(response => {
                if (!response.ok) {
                    throw new Error('Network response was not ok');
                }
                return response.json();
            })
            .then(data => {
                document.querySelector("blockquote p").textContent = `"${data[0].content}"`;
                document.querySelector(".blockquote-footer").textContent = `${data[0].author || "Unknown"}`;
            })
            .catch(error => {
                loadFromMemory();
                console.error("Error fetching or displaying the quote:", error);
            });
    } catch (error) {
        console.error("Error fetching or displaying the quote:", error);
    }
});