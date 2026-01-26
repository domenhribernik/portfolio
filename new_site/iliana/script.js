const config = {
    passwords: {
        'cHJldHR5cGxlYXNl': 'Iliana',
        'c3RheXByZXNlbnQ=': 'Domen'
    },
    targetDate: new Date('2026-02-06T14:00:00').getTime(),
};

// Drawing variables
let canvas, ctx;
let isDrawing = false;
let lastX = 0;
let lastY = 0;

// Data storage
let currentUser = null;
let userData = JSON.parse(localStorage.getItem('ourLittleWorld') || '{}');

const photos = [
    {
        src: '../assets/iliana/meeting.jpg',
        date: 'May 10, 2025',
        caption: 'Who is this pretty lady?!'
    },
    {
        src: '../assets/iliana/firstdatepeer.jpg',
        date: 'May 11, 2025',
        caption: 'First date and our first kiss <3'
    },
    /*{
        src: '../assets/iliana/firsttime.jpg',
        date: 'May 13, 2025',
        caption: 'Damn look at my back :O'
    }, */
    {
        src: '../assets/iliana/stargazing.jpg',
        date: 'May 15, 2025',
        caption: 'Stargazing on the roofs of Limassol ;)'
    },
    {
        src: '../assets/iliana/pafos.jpg',
        date: 'May 17, 2025',
        caption: 'Our trip to Pafos!!!'
    },
    {
        src: '../assets/iliana/polaroids.jpg',
        date: 'May 18, 2025',
        caption: 'We didn\'t forget :)'
    },
    {
        src: '../assets/iliana/marinabeach.jpg',
        date: 'May 21, 2025',
        caption: 'Beach date :D'
    },
    {
        src: '../assets/iliana/germany.jpg',
        date: 'Jun 18, 2025',
        caption: 'Went to Germany to see my girlfriend <3'
    },
    {
        src: '../assets/iliana/moviepark.jpg',
        date: 'Jun 20, 2025',
        caption: 'Movie park was so fun!!!'
    },
    {
        src: '../assets/iliana/colone.jpg',
        date: 'Jun 21, 2025',
        caption: 'Trip to Cologne and Düsseldorf :)'
    },
    {
        src: '../assets/iliana/onemonth.jpg',
        date: 'Jul 18, 2025',
        caption: 'One month anniversary <3'
    },
    {
        src: '../assets/iliana/iliana-and-sup.jpg',
        date: 'Aug 31, 2025',
        caption: 'You, sup and sunset :)'
    },
    {
        src: '../assets/iliana/tavli.jpg',
        date: 'Sep 1, 2025',
        caption: 'That time I beat you in tavli :P'
    },
    {
        src: '../assets/iliana/seafood-dinner.jpg',
        date: 'Sep 2, 2025',
        caption: 'Seafood dinner date!'
    },
    {
        src: '../assets/iliana/xanthe-gyro.jpg',
        date: 'Sep 3, 2025',
        caption: 'Best gyros in Greece!'
    },
    {
        src: '../assets/iliana/beach-dinner.jpg',
        date: 'Sep 4, 2025',
        caption: 'Most romantic beach date ever <3'
    },
    {
        src: '../assets/iliana/komotini-selfie.jpg',
        date: 'Sep 5, 2025',
        caption: 'Komotini was the best :D'
    },
    {
        src: '../assets/iliana/saloniki-selfie.jpg',
        date: 'Sep 6, 2025',
        caption: 'Our trip to Thessaloniki :)'
    },
    {
        src: '../assets/iliana/saloniki-appartment.jpg',
        date: 'Sep 6, 2025',
        caption: 'We had such a cool appartment :O'
    },
    {
        src: '../assets/iliana/castle-cat.jpg',
        date: 'Sep 7, 2025',
        caption: 'You met a new friend :D'
    },
    {
        src: '../assets/iliana/cuddles-at-home.jpg',
        date: 'Oct 26, 2025',
        caption: 'Watching the office in your room <3'
    },
    {
        src: '../assets/iliana/moviepark-part2.jpg',
        date: 'Oct 28, 2025',
        caption: 'Movie park but scary ;)'
    },
    {
        src: '../assets/iliana/daisy-movie-park.jpg',
        date: 'Oct 28, 2025',
        caption: 'Remember when we addopted Daisy? :P'
    },
    {
        src: '../assets/iliana/best-burgers-in-germany.jpg',
        date: 'Oct 30, 2025',
        caption: 'Best burgers in town!'
    },
    {
        src: '../assets/iliana/skocijan-cave-view-2025.jpg',
        date: 'Oct 30, 2025',
        caption: 'Trip to Škocijan Caves :O'
    },
    {
        src: '../assets/iliana/triest-trip-pizza-2025.jpg',
        date: 'Oct 30, 2025',
        caption: 'And for dinner pizza in Italy :)'
    },
    {
        src: '../assets/iliana/nature-hike-2025.jpg',
        date: 'Oct 31, 2025',
        caption: 'Reconnecting with nature <3'
    },
    {
        src: '../assets/iliana/bled-trip-slo-2025.jpg',
        date: 'Nov 1, 2025',
        caption: 'Bled trip :)'
    },
    {
        src: '../assets/iliana/slap-savica-2025.jpg',
        date: 'Nov 1, 2025',
        caption: 'Slap Savica waterfall :D'
    },
    {
        src: '../assets/iliana/horse-racing-lopata-2025.jpg',
        date: 'Nov 2, 2025',
        caption: 'We went to a horse race!'
    },
    {
        src: '../assets/iliana/tomatoes-from-the-garden-2025.jpg',
        date: 'Nov 4, 2025',
        caption: 'Fresh tomatoes from the garden :)'
    },
    {
        src: '../assets/iliana/luna-pet-ljubljana-2025.jpg',
        date: 'Nov 8, 2025',
        caption: 'Meeting Luna in Ljubljana!'
    },
    {
        src: '../assets/iliana/hose-of-ilusions-ljubljana-2025.jpg',
        date: 'Nov 8, 2025',
        caption: 'House of illusions was so fun :p'
    },
    {
        src: '../assets/iliana/home-made-pizza-2025.jpg',
        date: 'Nov 9, 2025',
        caption: 'Home made pizza for lunch :)'
    },
    {
        src: '../assets/iliana/spa-olimije-2025.jpg',
        date: 'Nov 10, 2025',
        caption: 'Chilling at a Spa :D'
    },
    {
        src: '../assets/iliana/hungry-twiggy-2025.jpg',
        date: 'Nov 11, 2025',
        caption: 'I know you have food >:)'
    }
];

// Login function
function login() {
    const password = document.getElementById('passwordInput').value;
    const encodedPassword = btoa(password);

    if (config.passwords[encodedPassword]) {
        currentUser = config.passwords[encodedPassword];
        document.getElementById('loginScreen').style.display = 'none';
        document.getElementById('mainApp').classList.add('show');

        document.getElementById('welcomeMessage').textContent =
            `Welcome back, ${currentUser}! ❤️`;
        initializeApp();
    } else {
        document.getElementById('errorMessage').style.display = 'block';
        setTimeout(() => {
            document.getElementById('errorMessage').style.display = 'none';
        }, 3000);
    }
}

// Logout function
function logout() {
    currentUser = null;
    document.getElementById('loginScreen').style.display = 'flex';
    document.getElementById('mainApp').classList.remove('show');
    document.getElementById('passwordInput').value = '';
}

// Initialize app
function initializeApp() {
    updateCountdown();
    loadQuoteOfTheDay();
    loadPhotoGallery();
    // initializeDrawingBoard();
    // loadPartnerDrawing();
    setInterval(updateCountdown, 1000);
}

// Countdown functionality
function updateCountdown() {
    const now = new Date().getTime();
    const distance = config.targetDate - now;

    if (distance < 0) {
        document.getElementById('days').textContent = '0';
        document.getElementById('hours').textContent = '0';
        document.getElementById('minutes').textContent = '0';
        document.getElementById('seconds').textContent = '0';
        return;
    }

    const days = Math.floor(distance / (1000 * 60 * 60 * 24));
    const hours = Math.floor((distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((distance % (1000 * 60)) / 1000);

    document.getElementById('days').textContent = days;
    document.getElementById('hours').textContent = hours;
    document.getElementById('minutes').textContent = minutes;
    document.getElementById('seconds').textContent = seconds;
}

// Quote of the day
function loadQuoteOfTheDay() {
    const today = new Date().toDateString();

    function displayQuote(quotesArray) {
        const quoteIndex = Math.abs(today.split('').reduce((a, b) => {
            a = ((a << 5) - a) + b.charCodeAt(0);
            return a & a;
        }, 0)) % quotesArray.length;

        const quote = quotesArray[quoteIndex];
        document.getElementById('quoteText').textContent = `"${quote.text}"`;
        document.getElementById('quoteAuthor').textContent = `${quote.author}`;
    }

    fetch('../assets/quotes.json')
        .then(response => response.json())
        .then(data => {
            const quotes = data.map(quote => ({
                text: quote.content,
                author: quote.author
            }));

            displayQuote(quotes);
        })
        .catch(error => {
            console.warn('Could not load quotes from JSON file:', error);
            // Fallback to hardcoded quotes if fetch fails
            displayQuote(quotes);
        });
}

//Divorce button - TODO breaks the photo gallery zoom!
// let isMoving = false;
// let hasBeenClicked = false;
// const button = document.getElementById('divorceBtn');
// const message = document.getElementById('message');

// function getRandomPosition(baseMaxDistance = 400, minDistance = 150) {
//     const pageWidth = document.documentElement.scrollWidth;
//     const pageHeight = document.documentElement.scrollHeight;
//     const buttonWidth = button.offsetWidth;
//     const buttonHeight = button.offsetHeight;

//     const currentRect = button.getBoundingClientRect();
//     const currentX = currentRect.left + window.scrollX + currentRect.width / 2;
//     const currentY = currentRect.top + window.scrollY + currentRect.height / 2;

//     // Clamp maxDistance so it never exceeds available space
//     const maxXSpace = pageWidth - buttonWidth - 60; // account for margins
//     const maxYSpace = pageHeight - buttonHeight - 60;
//     const effectiveMaxDistance = Math.min(
//         baseMaxDistance,
//         maxXSpace,
//         maxYSpace
//     );

//     let x, y, distance, attempts = 0;

//     do {
//         const margin = 60;
//         const maxX = pageWidth - buttonWidth - margin;
//         const maxY = pageHeight - buttonHeight - margin;

//         x = Math.random() * maxX + margin;
//         y = Math.random() * maxY + margin;

//         const newCenterX = x + buttonWidth / 2;
//         const newCenterY = y + buttonHeight / 2;

//         distance = Math.hypot(newCenterX - currentX, newCenterY - currentY);

//         // Clamp if too far
//         if (distance > effectiveMaxDistance) {
//             const angle = Math.atan2(newCenterY - currentY, newCenterX - currentX);
//             x = currentX + Math.cos(angle) * effectiveMaxDistance - buttonWidth / 2;
//             y = currentY + Math.sin(angle) * effectiveMaxDistance - buttonHeight / 2;
//             distance = effectiveMaxDistance;
//         }

//         attempts++;
//     } while (distance < minDistance && attempts < 20);

//     return { x, y, distance };
// }

// function moveButton() {
//     if (isMoving || hasBeenClicked) return;

//     isMoving = true;
//     button.classList.add('moving');

//     const newPos = getRandomPosition();

//     // Transition time scales with distance
//     const duration = Math.min(800, Math.max(300, newPos.distance)); // between 0.3s – 0.8s
//     button.style.transition = `all ${duration}ms cubic-bezier(0.68,-0.55,0.265,1.55)`;

//     button.style.left = newPos.x + 'px';
//     button.style.top = newPos.y + 'px';

//     setTimeout(() => {
//         button.classList.remove('moving');
//         isMoving = false;
//     }, duration);
// }

// function handleSuccessfulClick() {
//     hasBeenClicked = true;

//     message.style.display = 'block';

//     button.style.transition = 'all 0.5s ease-out';
//     button.style.opacity = '0';
//     button.style.transform = 'scale(0.5) rotate(720deg)';

//     setTimeout(() => {
//         button.style.display = 'none';
//     }, 500);
// }

// button.addEventListener('mouseenter', (e) => {
//     if (hasBeenClicked) return;
//     e.preventDefault();
//     moveButton();
// });

// button.addEventListener('touchstart', (e) => {
//     if (hasBeenClicked) return;
//     e.preventDefault();
//     moveButton();
// });

// button.addEventListener('click', (e) => {
//     e.preventDefault();
//     if (!hasBeenClicked && !isMoving) {
//         handleSuccessfulClick();
//     } else if (!hasBeenClicked) {
//         moveButton();
//     }
// });

// button.addEventListener('mousedown', (e) => {
//     if (hasBeenClicked) return;
//     e.preventDefault();
//     moveButton();
// });

// // Initialize button position to center
// button.style.left = '50%';
// button.style.top = '50%';
// button.style.transform = 'translate(-50%, -50%)';

// // Handle window resize
// window.addEventListener('resize', () => {
//     if (!isMoving) {
//         const rect = button.getBoundingClientRect();
//         const windowWidth = window.innerWidth;
//         const windowHeight = window.innerHeight;

//         if (rect.right > windowWidth || rect.bottom > windowHeight || rect.left < 0 || rect.top < 0) {
//             const newPos = getRandomPosition();
//             button.style.left = newPos.x + 'px';
//             button.style.top = newPos.y + 'px';
//         }
//     }
// });

// Photo gallery
function loadPhotoGallery() {
    const gallery = document.getElementById('photoGallery');
    gallery.innerHTML = '';

    photos.forEach((photo, index) => {
        const photoItem = document.createElement('div');
        photoItem.className = 'photo-item';

        photoItem.innerHTML = `
                    <div class="photo-container">
                        <img class="photo-image" src="${photo.src}" alt="${photo.caption}" onerror="this.parentElement.innerHTML='<div class=\\'photo-placeholder\\'>Photo not found<br>Replace with: ${photo.src}</div>'">
                    </div>
                    <div class="photo-info">
                        <div class="photo-date">${photo.date}</div>
                        <div class="photo-caption">${photo.caption}</div>
                    </div>
                `;

        // Add click event to open modal
        photoItem.addEventListener('click', () => openModal(photo));

        gallery.appendChild(photoItem);
    });
}

function openModal(photo) {
    const modal = document.getElementById('imageModal');
    const modalImage = document.getElementById('modalImage');
    const modalDate = document.getElementById('modalDate');
    const modalCaption = document.getElementById('modalCaption');
    const scrollY = window.scrollY || window.pageYOffset;

    modalImage.src = photo.src;
    modalImage.alt = photo.caption;
    modalDate.textContent = photo.date;
    modalCaption.textContent = photo.caption;

    modal.style.top = `${scrollY}px`;
    modal.style.height = `${window.innerHeight}px`;
    modal.classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeModal() {
    console.log(document.getElementById('imageModal'));
    const modal = document.getElementById('imageModal');
    modal.classList.remove('active');
    document.body.style.overflow = 'auto';
}

// Close modal when clicking outside the image
document.getElementById('imageModal').addEventListener('click', function (e) {
    if (e.target === this) {
        closeModal();
    }
});

// Close modal with Escape key
document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
        closeModal();
    }
});

document.addEventListener('DOMContentLoaded', loadPhotoGallery);

// Drawing Board Functions
function initializeDrawingBoard() {
    canvas = document.getElementById('drawingCanvas');
    ctx = canvas.getContext('2d');
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#FFC2CC';
    ctx.lineWidth = 3;

    // Drawing event listeners
    canvas.addEventListener('mousedown', startDrawing);
    canvas.addEventListener('mousemove', draw);
    canvas.addEventListener('mouseup', stopDrawing);
    canvas.addEventListener('mouseout', stopDrawing);

    // Touch events for mobile
    canvas.addEventListener('touchstart', handleTouch);
    canvas.addEventListener('touchmove', handleTouch);
    canvas.addEventListener('touchend', stopDrawing);

    // Control event listeners
    document.getElementById('colorPicker').addEventListener('change', function () {
        ctx.strokeStyle = this.value;
    });

    document.getElementById('brushSize').addEventListener('input', function () {
        ctx.lineWidth = this.value;
        document.getElementById('brushSizeDisplay').textContent = this.value + 'px';
    });
}

function startDrawing(e) {
    isDrawing = true;
    const rect = canvas.getBoundingClientRect();
    lastX = e.clientX - rect.left;
    lastY = e.clientY - rect.top;
}

function draw(e) {
    if (!isDrawing) return;

    const rect = canvas.getBoundingClientRect();
    const currentX = e.clientX - rect.left;
    const currentY = e.clientY - rect.top;

    ctx.beginPath();
    ctx.moveTo(lastX, lastY);
    ctx.lineTo(currentX, currentY);
    ctx.stroke();

    lastX = currentX;
    lastY = currentY;
}

function stopDrawing() {
    isDrawing = false;
}

function handleTouch(e) {
    e.preventDefault();
    const touch = e.touches[0];
    const mouseEvent = new MouseEvent(e.type === 'touchstart' ? 'mousedown' :
        e.type === 'touchmove' ? 'mousemove' : 'mouseup', {
        clientX: touch.clientX,
        clientY: touch.clientY
    });
    canvas.dispatchEvent(mouseEvent);
}

function clearCanvas() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
}


function exportDrawing() {
    // Check if canvas has any drawing
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const pixels = imageData.data;
    let hasDrawing = false;

    for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i + 3] > 0) { // Check alpha channel
            hasDrawing = true;
            break;
        }
    }

    if (!hasDrawing) {
        alert('Please draw something first! 🎨');
        return;
    }

    // Create download link
    const link = document.createElement('a');
    link.download = 'my-drawing.png';
    link.href = canvas.toDataURL();
    link.click();
}

async function uploadDrawing() {
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const pixels = imageData.data;
    let hasDrawing = false;

    for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i + 3] > 0) {
            hasDrawing = true;
            break;
        }
    }

    if (!hasDrawing) {
        alert('Please draw something first! 🎨');
        return;
    }

    const drawingName = prompt('Give your drawing a name:');
    if (!drawingName) return;

    const drawingData = {
        name: drawingName,
        author: currentUser,
        timestamp: new Date().toISOString(),
        imageData: canvas.toDataURL()
    };

    // Store locally for now
    let drawings = JSON.parse(localStorage.getItem('drawings') || '[]');
    drawings.push(drawingData);
    localStorage.setItem('drawings', JSON.stringify(drawings));

    alert('Drawing shared! 💕');
    loadPartnerDrawing();

    // TODO: Replace with actual Firebase upload
    // uploadToFirebase(drawingData);
}

async function loadPartnerDrawing() {
    // Load from local storage for now
    const drawings = JSON.parse(localStorage.getItem('drawings') || '[]');

    // Find the latest drawing from the other person
    const partnerDrawings = drawings
        .filter(drawing => drawing.author !== currentUser)
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    if (partnerDrawings.length > 0) {
        const latestDrawing = partnerDrawings[0];

        document.getElementById('partnerDrawingImage').src = latestDrawing.imageData;
        document.getElementById('partnerDrawingText').textContent = latestDrawing.name;
        document.getElementById('partnerDrawingDate').textContent =
            new Date(latestDrawing.timestamp).toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'long',
                day: 'numeric'
            });

        document.getElementById('partnerDrawingSection').style.display = 'block';
    } else {
        document.getElementById('partnerDrawingSection').style.display = 'none';
    }

    // TODO: Replace with actual Firebase query
    // loadFromFirebase();
}

// Click effects
document.querySelectorAll('.click-effect').forEach(element => {
    element.addEventListener('click', function (e) {
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