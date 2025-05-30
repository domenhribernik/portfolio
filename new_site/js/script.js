window.addEventListener('load', () => {
    document.getElementById('loadingOverlay').classList.add('hidden');
});

const mobileMenuBtn = document.getElementById('mobileMenuBtn');
const navMenu = document.getElementById('navMenu');

mobileMenuBtn.addEventListener('click', () => {
    navMenu.classList.toggle('active');
});

//? Language toggle
const langButtons = document.querySelectorAll('.lang-btn');

langButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        const lang = btn.dataset.lang;

        langButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        if (lang === 'slo') {
            document.body.classList.add('lang-slovenian');
        } else {
            document.body.classList.remove('lang-slovenian');
        }

        console.log(`Language changed to: ${lang}`);
    });
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

// Navbar background on scroll
window.addEventListener('scroll', () => {
    const navbar = document.querySelector('.navbar');
    if (window.scrollY > 100) {
        navbar.style.background = 'rgba(15, 23, 42, 0.98)';
    } else {
        navbar.style.background = 'rgba(15, 23, 42, 0.95)';
    }
});

document.getElementById('currentYear').textContent = new Date().getFullYear();

//? Intersection Observer for scroll animations
const observerOptions = {
    threshold: 0.1,
    rootMargin: '0px 0px -50px 0px'
};

const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.style.opacity = '1';
            entry.target.style.transform = 'translateY(0)';
        }
    });
}, observerOptions);

//? Observe elements for animations
document.querySelectorAll('.project-card, .contact-card').forEach(el => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(30px)';
    el.style.transition = 'all 0.6s ease';
    observer.observe(el);
});

//? Typing effect for hero subtitle
const subtitles = {
    eng: "Developer & Tech Enthusiast",
    slo: "Razvijalec & Ljubitelj Tehnologije"
};

function typeWriter(element, text, speed = 100) {
    let i = 0;
    element.innerHTML = '';

    function type() {
        if (i < text.length) {
            element.innerHTML += text.charAt(i);
            i++;
            setTimeout(type, speed);
        }
    }

    type();
}

setTimeout(() => {
    const heroSubtitle = document.querySelector('.hero h2 .lang-eng');
    if (heroSubtitle) {
        typeWriter(heroSubtitle, subtitles.eng, 80);
    }
}, 1000);

//? Particle effect for hero background
function createParticles() {
    const hero = document.querySelector('.hero');
    const particlesContainer = document.createElement('div');
    particlesContainer.style.position = 'absolute';
    particlesContainer.style.top = '0';
    particlesContainer.style.left = '0';
    particlesContainer.style.width = '100%';
    particlesContainer.style.height = '100%';
    particlesContainer.style.pointerEvents = 'none';
    particlesContainer.style.zIndex = '1';

    hero.appendChild(particlesContainer);

    for (let i = 0; i < 50; i++) {
        const particle = document.createElement('div');
        particle.style.position = 'absolute';
        particle.style.width = Math.random() * 4 + 1 + 'px';
        particle.style.height = particle.style.width;
        particle.style.background = 'rgba(255, 255, 255, 0.1)';
        particle.style.borderRadius = '50%';
        particle.style.left = Math.random() * 100 + '%';
        particle.style.top = Math.random() * 100 + '%';
        particle.style.animation = `float ${Math.random() * 10 + 10}s linear infinite`;

        particlesContainer.appendChild(particle);
    }
}

const style = document.createElement('style');
style.textContent = `
            @keyframes float {
                0% {
                    transform: translateY(100vh) rotate(0deg);
                    opacity: 0;
                }
                10% {
                    opacity: 1;
                }
                90% {
                    opacity: 1;
                }
                100% {
                    transform: translateY(-100vh) rotate(360deg);
                    opacity: 0;
                }
            }
            
            .project-card:hover .project-image {
                transform: scale(1.05);
                transition: transform 0.3s ease;
            }
            
            .contact-card:hover .contact-icon {
                transform: scale(1.1) rotate(5deg);
                transition: transform 0.3s ease;
            }
            
            .hero-content {
                animation: fadeInUp 1s ease 0.5s both;
            }
            
            @keyframes fadeInUp {
                from {
                    opacity: 0;
                    transform: translateY(30px);
                }
                to {
                    opacity: 1;
                    transform: translateY(0);
                }
            }
        `;
document.head.appendChild(style);

createParticles();

//? Parallax effect for sections
window.addEventListener('scroll', () => {
    const scrolled = window.pageYOffset;
    const rate = scrolled * -0.5;

    const hero = document.querySelector('.hero');
    if (hero) {
        hero.style.transform = `translateY(${rate}px)`;
    }
});

//? Add ripple effect to buttons
function addRippleEffect() {
    const buttons = document.querySelectorAll('.cta-button, .project-link, .social-link');

    buttons.forEach(button => {
        button.addEventListener('click', function (e) {
            const ripple = document.createElement('span');
            const rect = this.getBoundingClientRect();
            const size = Math.max(rect.width, rect.height);
            const x = e.clientX - rect.left - size / 2;
            const y = e.clientY - rect.top - size / 2;

            ripple.style.width = ripple.style.height = size + 'px';
            ripple.style.left = x + 'px';
            ripple.style.top = y + 'px';
            ripple.classList.add('ripple');

            this.appendChild(ripple);

            setTimeout(() => {
                ripple.remove();
            }, 600);
        });
    });
}

const rippleStyle = document.createElement('style');
rippleStyle.textContent = `
            .ripple {
                position: absolute;
                border-radius: 50%;
                background: rgba(255, 255, 255, 0.3);
                transform: scale(0);
                animation: rippleEffect 0.6s linear;
                pointer-events: none;
            }
            
            @keyframes rippleEffect {
                to {
                    transform: scale(4);
                    opacity: 0;
                }
            }
            
            .cta-button, .project-link, .social-link {
                position: relative;
                overflow: hidden;
            }
        `;
document.head.appendChild(rippleStyle);

addRippleEffect();

//? Preload images and optimize performance
const imageUrls = [
    // Add any image URLs you want to preload
];

imageUrls.forEach(url => {
    const img = new Image();
    img.src = url;
});

document.addEventListener('DOMContentLoaded', () => {
    const categories = document.querySelectorAll('.project-category');

    categories.forEach(category => {
        const projects = category.querySelectorAll('.project-card');
        if (projects.length > 3) {
            projects.forEach((project, index) => {
                if (index >= 3) {
                    project.style.display = 'none';
                }
            });

            const toggleBtn = document.createElement('button');
            toggleBtn.className = 'show-more-btn';
            toggleBtn.style.marginTop = '1rem';

            const engSpan = document.createElement('span');
            engSpan.className = 'lang-eng';
            engSpan.textContent = 'Show More...';

            const sloSpan = document.createElement('span');
            sloSpan.className = 'lang-slo';
            sloSpan.textContent = 'Prikaži Več...';

            toggleBtn.appendChild(engSpan);
            toggleBtn.appendChild(sloSpan);

            let expanded = false;
            toggleBtn.addEventListener('click', () => {
                expanded = !expanded;

                projects.forEach((project, index) => {
                    if (index >= 3) {
                        project.style.display = expanded ? 'flex' : 'none';
                    }
                });

                engSpan.textContent = expanded ? 'Show Less...' : 'Show More...';
                sloSpan.textContent = expanded ? 'Prikaži Manj...' : 'Prikaži Več...';
            });

            category.querySelector('.projects-grid').after(toggleBtn);
        }
    });
});

