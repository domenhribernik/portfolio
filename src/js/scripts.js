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