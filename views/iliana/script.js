const config = {
    passwords: {
        'cHJldHR5cGxlYXNl': 'Iliana',
        'c3RheXByZXNlbnQ=': 'Domen'
    },
    targetDate: new Date('2026-04-21T17:30:00').getTime(),
};

const API = '../../app/controllers/iliana-photos-controller.php';

let currentUser = null;
let photos = [];
let deleteTargetId = null;

// === API helpers ===

async function apiFetch(url, options = {}) {
    const res = await fetch(url, options);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
}

async function loadPhotosFromApi(from = '', to = '') {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to)   params.set('to', to);
    const query = params.toString();
    return apiFetch(API + (query ? '?' + query : ''));
}

async function createPhotoApi(formData) {
    return apiFetch(API, { method: 'POST', body: formData });
}

async function updatePhotoApi(id, formData) {
    return apiFetch(API + '?id=' + id, { method: 'POST', body: formData });
}

async function deletePhotoApi(id) {
    return apiFetch(API + '?id=' + id, { method: 'DELETE' });
}

// === Login / Logout ===

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

function logout() {
    currentUser = null;
    document.getElementById('loginScreen').style.display = 'flex';
    document.getElementById('mainApp').classList.remove('show');
    document.getElementById('passwordInput').value = '';
}

// === App init ===

function initializeApp() {
    updateCountdown();
    loadQuoteOfTheDay();
    loadPhotos();
    setInterval(updateCountdown, 1000);
}

// === Countdown ===

function updateCountdown() {
    const now = new Date().getTime();
    const distance = config.targetDate - now;

    if (distance < 0) {
        ['days', 'hours', 'minutes', 'seconds'].forEach(id => {
            document.getElementById(id).textContent = '0';
        });
        return;
    }

    const days    = Math.floor(distance / (1000 * 60 * 60 * 24));
    const hours   = Math.floor((distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((distance % (1000 * 60)) / 1000);

    document.getElementById('days').textContent    = days;
    document.getElementById('hours').textContent   = hours;
    document.getElementById('minutes').textContent = minutes;
    document.getElementById('seconds').textContent = seconds;
}

// === Quote of the day ===

function loadQuoteOfTheDay() {
    const today = new Date().toDateString();

    function displayQuote(quotesArray) {
        const quoteIndex = Math.abs(today.split('').reduce((a, b) => {
            a = ((a << 5) - a) + b.charCodeAt(0);
            return a & a;
        }, 0)) % quotesArray.length;

        const quote = quotesArray[quoteIndex];
        document.getElementById('quoteText').textContent   = `"${quote.text}"`;
        document.getElementById('quoteAuthor').textContent = `${quote.author}`;
    }

    fetch('../../assets/quotes.json')
        .then(response => response.json())
        .then(data => {
            const quotes = data.map(quote => ({ text: quote.content, author: quote.author }));
            displayQuote(quotes);
        })
        .catch(error => {
            console.warn('Could not load quotes from JSON file:', error);
        });
}

// === Photo gallery ===

function formatDisplayDate(dateStr) {
    const [y, m, d] = dateStr.split('-');
    return new Date(parseInt(y), parseInt(m) - 1, parseInt(d))
        .toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

async function loadPhotos() {
    const from = document.getElementById('filterFrom').value;
    const to   = document.getElementById('filterTo').value;
    const gallery = document.getElementById('photoGallery');
    gallery.innerHTML = '<div class="gallery-state"><p>Loading memories...</p></div>';
    try {
        photos = await loadPhotosFromApi(from, to);
        renderPhotoGallery();
    } catch (e) {
        gallery.innerHTML = '<div class="gallery-state"><p>Could not load memories. Is the server running?</p></div>';
    }
}

function renderPhotoGallery() {
    const gallery = document.getElementById('photoGallery');
    gallery.innerHTML = '';

    if (photos.length === 0) {
        gallery.innerHTML = '<div class="gallery-state"><p>No memories yet. Add your first! 💕</p></div>';
        return;
    }

    photos.forEach((photo) => {
        const item = document.createElement('div');
        item.className = 'photo-item';

        const displayDate = formatDisplayDate(photo.photo_date);
        const imgSrc = '../../' + photo.image_url;

        item.innerHTML = `
            <div class="photo-container">
                <img class="photo-image" src="${imgSrc}" alt="${escapeHtml(photo.caption)}"
                     onerror="this.parentElement.innerHTML='<div class=\\'photo-placeholder\\'>Photo not found</div>'">
            </div>
            <div class="photo-info">
                <div class="photo-date">${displayDate}</div>
                <div class="photo-caption">${escapeHtml(photo.caption)}</div>
            </div>
        `;

        item.addEventListener('click', () => openModal({
            id: photo.id,
            src: imgSrc,
            date: displayDate,
            caption: photo.caption,
            addedBy: photo.added_by,
        }));

        gallery.appendChild(item);
    });
}

function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// === Image view modal ===

function openModal(photo) {
    const modal       = document.getElementById('imageModal');
    const scrollY     = window.scrollY || window.pageYOffset;

    document.getElementById('modalImage').src          = photo.src;
    document.getElementById('modalImage').alt          = photo.caption;
    document.getElementById('modalDate').textContent   = photo.date;
    document.getElementById('modalCaption').textContent = photo.caption;
    document.getElementById('modalAuthor').textContent  = 'by ' + photo.addedBy;

    document.getElementById('modalEditBtn').onclick = () => { closeModal(); openEditPhotoForm(photo.id); };
    document.getElementById('modalDeleteBtn').onclick = () => { closeModal(); openDeleteConfirm(photo.id); };

    modal.style.top    = `${scrollY}px`;
    modal.style.height = `${window.innerHeight}px`;
    modal.classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeModal() {
    const modal = document.getElementById('imageModal');
    modal.classList.remove('active');
    document.body.style.overflow = 'auto';
}

document.getElementById('imageModal').addEventListener('click', function (e) {
    if (e.target === this) closeModal();
});

// === Photo form modal ===

function openAddPhotoForm() {
    document.getElementById('photoFormTitle').textContent = 'Add Memory';
    document.getElementById('photoId').value = '';
    document.getElementById('photoForm').reset();
    resetImagePreview();
    document.getElementById('photoAddedBy').value = currentUser || '';
    document.getElementById('photoImageRequired').style.display = 'inline';
    document.getElementById('photoFormError').style.display = 'none';
    document.getElementById('photoFormOverlay').classList.add('active');
}

function openEditPhotoForm(id) {
    const photo = photos.find(p => p.id === id);
    if (!photo) return;

    document.getElementById('photoFormTitle').textContent = 'Edit Memory';
    document.getElementById('photoId').value   = id;
    document.getElementById('photoCaption').value  = photo.caption;
    document.getElementById('photoDate').value     = photo.photo_date;
    document.getElementById('photoAddedBy').value  = photo.added_by;
    document.getElementById('photoImageRequired').style.display = 'none';
    document.getElementById('photoFormError').style.display = 'none';

    document.getElementById('photoImagePreviewContainer').style.display = 'block';
    document.getElementById('photoUploadPlaceholder').style.display = 'none';
    document.getElementById('photoImagePreviewImg').src = '../../' + photo.image_url;

    document.getElementById('photoFormOverlay').classList.add('active');
}

function closePhotoForm() {
    document.getElementById('photoFormOverlay').classList.remove('active');
}

function resetImagePreview() {
    document.getElementById('photoImagePreviewContainer').style.display = 'none';
    document.getElementById('photoUploadPlaceholder').style.display = 'block';
}

document.getElementById('photoImage').addEventListener('change', function () {
    const file = this.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        document.getElementById('photoImagePreviewImg').src = e.target.result;
        document.getElementById('photoImagePreviewContainer').style.display = 'block';
        document.getElementById('photoUploadPlaceholder').style.display = 'none';
    };
    reader.readAsDataURL(file);
});

document.getElementById('photoForm').addEventListener('submit', async function (e) {
    e.preventDefault();

    const id       = document.getElementById('photoId').value;
    const caption  = document.getElementById('photoCaption').value.trim();
    const date     = document.getElementById('photoDate').value;
    const addedBy  = document.getElementById('photoAddedBy').value;
    const imgFile  = document.getElementById('photoImage').files[0];

    const errors = [];
    if (!caption)  errors.push('Caption is required');
    if (!date)     errors.push('Date is required');
    if (!addedBy)  errors.push('Please select who added this');
    if (!id && !imgFile) errors.push('Photo image is required');

    const errEl = document.getElementById('photoFormError');
    if (errors.length) {
        errEl.textContent  = errors.join('. ');
        errEl.style.display = 'block';
        return;
    }
    errEl.style.display = 'none';

    const formData = new FormData();
    formData.append('caption',    caption);
    formData.append('photo_date', date);
    formData.append('added_by',   addedBy);
    if (imgFile) formData.append('image', imgFile);

    const submitBtn  = document.getElementById('photoFormSubmit');
    const btnText    = submitBtn.querySelector('.btn-text');
    const btnLoading = submitBtn.querySelector('.btn-loading');
    submitBtn.disabled  = true;
    btnText.style.display    = 'none';
    btnLoading.style.display = 'inline';

    try {
        let result;
        if (id) {
            result = await updatePhotoApi(parseInt(id), formData);
            const idx = photos.findIndex(p => p.id === parseInt(id));
            if (idx !== -1) photos[idx] = result;
        } else {
            result = await createPhotoApi(formData);
            photos.push(result);
            photos.sort((a, b) => a.photo_date.localeCompare(b.photo_date));
        }
        renderPhotoGallery();
        closePhotoForm();
        showToast(id ? 'Memory updated! ✏️' : 'Memory added! ❤️');
    } catch (err) {
        errEl.textContent  = err.message;
        errEl.style.display = 'block';
    } finally {
        submitBtn.disabled       = false;
        btnText.style.display    = 'inline';
        btnLoading.style.display = 'none';
    }
});

document.getElementById('photoFormClose').addEventListener('click', closePhotoForm);
document.getElementById('photoFormCancel').addEventListener('click', closePhotoForm);

document.getElementById('photoFormOverlay').addEventListener('click', function (e) {
    if (e.target === this) closePhotoForm();
});

// === Delete modal ===

function openDeleteConfirm(id) {
    deleteTargetId = id;
    document.getElementById('deleteOverlay').classList.add('active');
}

function closeDeleteConfirm() {
    deleteTargetId = null;
    document.getElementById('deleteOverlay').classList.remove('active');
}

document.getElementById('deleteCancelBtn').addEventListener('click', closeDeleteConfirm);

document.getElementById('deleteConfirmBtn').addEventListener('click', async function () {
    if (!deleteTargetId) return;
    const id = deleteTargetId;
    closeDeleteConfirm();
    try {
        await deletePhotoApi(id);
        photos = photos.filter(p => p.id !== id);
        renderPhotoGallery();
        showToast('Memory deleted.');
    } catch (err) {
        showToast('Failed to delete: ' + err.message, 'error');
    }
});

document.getElementById('deleteOverlay').addEventListener('click', function (e) {
    if (e.target === this) closeDeleteConfirm();
});

// === Toast ===

function showToast(message, type = 'success') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = 'toast toast-' + type;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3500);
}

// === Date filter ===

(function () {
    const fromEl  = document.getElementById('filterFrom');
    const toEl    = document.getElementById('filterTo');
    const clearEl = document.getElementById('filterClearBtn');

    function updateClearBtn() {
        clearEl.style.display = (fromEl.value || toEl.value) ? 'inline-flex' : 'none';
    }

    fromEl.addEventListener('change', () => { updateClearBtn(); loadPhotos(); });
    toEl.addEventListener('change',   () => { updateClearBtn(); loadPhotos(); });

    clearEl.addEventListener('click', () => {
        fromEl.value = '';
        toEl.value   = '';
        updateClearBtn();
        loadPhotos();
    });
})();

// === Keyboard shortcuts ===

document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
        if (document.getElementById('deleteOverlay').classList.contains('active')) {
            closeDeleteConfirm();
        } else if (document.getElementById('photoFormOverlay').classList.contains('active')) {
            closePhotoForm();
        } else {
            closeModal();
        }
    }
});

// === Click ripple effects ===

document.querySelectorAll('.click-effect').forEach(element => {
    element.addEventListener('click', function (e) {
        const ripple = document.createElement('span');
        const rect   = this.getBoundingClientRect();
        const size   = Math.max(rect.width, rect.height);
        const x      = e.clientX - rect.left - size / 2;
        const y      = e.clientY - rect.top  - size / 2;

        ripple.style.width  = ripple.style.height = size + 'px';
        ripple.style.left   = x + 'px';
        ripple.style.top    = y + 'px';
        ripple.classList.add('ripple');

        this.appendChild(ripple);
        setTimeout(() => ripple.remove(), 600);
    });
});

// === Enter key on password input ===

document.getElementById('passwordInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') login();
});
