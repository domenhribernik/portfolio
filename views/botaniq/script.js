(() => {
    'use strict';

    const API = '../../app/controllers/plants-controller.php';

    // --- State ---
    let plants = [];
    let currentIssues = [];
    let currentTips = [];
    let countdownInterval = null;

    // --- DOM refs ---
    const plantsGrid = document.getElementById('plantsGrid');
    const emptyState = document.getElementById('emptyState');
    const loadingState = document.getElementById('loadingState');
    const errorState = document.getElementById('errorState');
    const errorMessage = document.getElementById('errorMessage');
    const detailModal = document.getElementById('detailModal');
    const detailContent = document.getElementById('detailContent');
    const formModal = document.getElementById('formModal');
    const formTitle = document.getElementById('formTitle');
    const plantForm = document.getElementById('plantForm');
    const deleteModal = document.getElementById('deleteModal');
    const deletePlantName = document.getElementById('deletePlantName');
    const formError = document.getElementById('formError');
    const imagePreview = document.getElementById('imagePreview');
    const removeImageLabel = document.getElementById('removeImageLabel');
    const issuesItems = document.getElementById('issuesItems');
    const tipsItems = document.getElementById('tipsItems');
    const toastContainer = document.getElementById('toastContainer');

    let deleteTargetId = null;

    // --- API helpers ---

    async function apiFetch(url, options = {}) {
        const response = await fetch(url, options);
        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.error || `Request failed (${response.status})`);
        }
        return data;
    }

    async function loadPlants() {
        showLoading();
        try {
            plants = await apiFetch(API);
            renderPlants();
        } catch (err) {
            showError(err.message);
        }
    }

    async function createPlant(formData) {
        return apiFetch(API, { method: 'POST', body: formData });
    }

    async function updatePlant(id, formData) {
        return apiFetch(`${API}?id=${id}`, { method: 'POST', body: formData });
    }

    async function deletePlantApi(id) {
        return apiFetch(`${API}?id=${id}`, { method: 'DELETE' });
    }

    async function waterPlantApi(id) {
        return apiFetch(`${API}?action=water&id=${id}`, { method: 'POST' });
    }

    // --- Utility ---

    function esc(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function formatTemp(temp) {
        if (!temp) return '';
        temp = temp.trim();
        if (temp.includes('°')) return temp;
        return temp + '°C';
    }

    // --- Rendering ---

    function showLoading() {
        loadingState.style.display = 'flex';
        plantsGrid.style.display = 'none';
        emptyState.style.display = 'none';
        errorState.style.display = 'none';
    }

    function showError(msg) {
        loadingState.style.display = 'none';
        plantsGrid.style.display = 'none';
        emptyState.style.display = 'none';
        errorState.style.display = 'block';
        errorMessage.textContent = msg;
    }

    function renderPlants() {
        loadingState.style.display = 'none';
        errorState.style.display = 'none';

        if (plants.length === 0) {
            plantsGrid.style.display = 'none';
            emptyState.style.display = 'block';
            return;
        }

        emptyState.style.display = 'none';
        plantsGrid.style.display = 'grid';
        plantsGrid.innerHTML = plants.map(plantCardHTML).join('');
        startCountdownUpdates();
    }

    function plantCardHTML(plant) {
        const displayName = plant.nickname || plant.name;
        const scientificLine = plant.nickname
            ? `<div class="text-xs text-neutral-400 italic mb-2">${esc(plant.name)}</div>`
            : '';
        const imageHTML = plant.image_url
            ? `<img class="w-full aspect-square object-cover block" src="../../${esc(plant.image_url)}" alt="${esc(displayName)}" loading="lazy">`
            : `<div class="w-full aspect-square bg-neutral-100 flex items-center justify-center text-6xl select-none">🪴</div>`;
        const watering = getWateringStatus(plant);

        return `
        <div class="plant-card bg-white border border-neutral-200 rounded-xl overflow-hidden cursor-pointer transition-shadow hover:shadow-lg" data-id="${plant.id}">
            ${imageHTML}
            <div class="p-4 px-5">
                <div class="text-lg font-semibold mb-0.5">${esc(displayName)}</div>
                ${scientificLine}
                <div class="text-xs text-neutral-500 bg-neutral-100 px-2.5 py-0.5 rounded-full inline-block mb-3">${esc(plant.type)}</div>
                <div class="watering-countdown ${watering.statusClass} flex items-center gap-2.5 px-3.5 py-3 rounded-lg mb-3" data-plant-id="${plant.id}">
                    <i class="fas fa-tint watering-icon text-base"></i>
                    <div class="flex-1">
                        <div class="watering-label text-[0.7rem] text-neutral-500 uppercase tracking-wide font-semibold">Next watering</div>
                        <div class="watering-time text-sm font-semibold">${watering.text}</div>
                    </div>
                    <button class="bg-sky-100 text-sky-700 px-4 py-2 rounded-lg text-xs font-semibold border-none cursor-pointer transition-colors hover:bg-sky-200 inline-flex items-center gap-1.5" onclick="event.stopPropagation(); waterPlant(${plant.id})" title="Mark as watered">
                        <i class="fas fa-tint"></i> Water
                    </button>
                </div>
                <div class="flex gap-1.5 justify-end pt-2 border-t border-neutral-100">
                    <button class="bg-transparent border-none cursor-pointer text-neutral-400 p-1.5 rounded-md text-sm transition-colors hover:text-neutral-900 hover:bg-neutral-100" onclick="event.stopPropagation(); openEditForm(${plant.id})" title="Edit">
                        <i class="fas fa-pen"></i>
                    </button>
                    <button class="bg-transparent border-none cursor-pointer text-neutral-400 p-1.5 rounded-md text-sm transition-colors hover:text-neutral-900 hover:bg-neutral-100" onclick="event.stopPropagation(); confirmDelete(${plant.id})" title="Delete">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            </div>
        </div>`;
    }

    // --- Watering countdown ---

    function getWateringStatus(plant) {
        if (!plant.last_watered) {
            return { text: 'Never watered', statusClass: 'status-overdue' };
        }

        const lastWatered = new Date(plant.last_watered);
        const now = new Date();
        const diffMs = now - lastWatered;
        const diffDays = diffMs / (1000 * 60 * 60 * 24);

        const minDays = plant.watering_min_days;
        const maxDays = plant.watering_max_days;

        if (diffDays >= maxDays) {
            const overdueDays = Math.floor(diffDays - maxDays);
            return {
                text: overdueDays === 0 ? 'Water today!' : `Overdue by ${overdueDays} day${overdueDays !== 1 ? 's' : ''}`,
                statusClass: 'status-overdue'
            };
        }

        if (diffDays >= minDays) {
            const remainingDays = Math.ceil(maxDays - diffDays);
            return {
                text: remainingDays <= 1 ? 'Water today or tomorrow' : `Water within ${remainingDays} days`,
                statusClass: 'status-soon'
            };
        }

        const daysUntilMin = Math.ceil(minDays - diffDays);
        if (daysUntilMin <= 0) {
            return { text: 'Water today', statusClass: 'status-soon' };
        }

        const hours = Math.floor((minDays - diffDays) * 24);
        if (hours < 24) {
            return { text: `${hours} hour${hours !== 1 ? 's' : ''} left`, statusClass: 'status-soon' };
        }

        return {
            text: `${daysUntilMin} day${daysUntilMin !== 1 ? 's' : ''} left`,
            statusClass: 'status-ok'
        };
    }

    function startCountdownUpdates() {
        if (countdownInterval) clearInterval(countdownInterval);
        countdownInterval = setInterval(() => {
            plants.forEach(plant => {
                const el = document.querySelector(`.watering-countdown[data-plant-id="${plant.id}"]`);
                if (!el) return;
                const status = getWateringStatus(plant);
                el.className = `watering-countdown ${status.statusClass} flex items-center gap-2.5 px-3.5 py-3 rounded-lg mb-3`;
                el.querySelector('.watering-time').textContent = status.text;
            });
        }, 60000);
    }

    // --- Detail modal ---

    function showPlantDetail(plant) {
        const displayName = plant.nickname || plant.name;
        const scientificLine = plant.nickname
            ? `<div class="text-sm text-neutral-400 italic mb-2">${esc(plant.name)}</div>`
            : '';
        const imageHTML = plant.image_url
            ? `<img class="w-full aspect-square object-cover rounded-xl mb-5" src="../../${esc(plant.image_url)}" alt="${esc(displayName)}">`
            : `<div class="w-full aspect-square bg-neutral-100 rounded-xl flex items-center justify-center text-7xl mb-5 select-none">🪴</div>`;
        const watering = getWateringStatus(plant);

        const issuesHTML = plant.common_issues.length > 0
            ? `<ul class="list-none p-0">${plant.common_issues.map(i => `<li class="py-1.5 text-sm text-neutral-500 flex items-start gap-2"><span class="text-neutral-300 font-bold shrink-0">&bull;</span>${esc(i)}</li>`).join('')}</ul>`
            : '<p class="text-neutral-400 text-sm">None listed</p>';

        const tipsHTML = plant.useful_tips.length > 0
            ? `<ul class="list-none p-0">${plant.useful_tips.map(t => `<li class="py-1.5 text-sm text-neutral-500 flex items-start gap-2"><span class="text-neutral-300 font-bold shrink-0">&bull;</span>${esc(t)}</li>`).join('')}</ul>`
            : '<p class="text-neutral-400 text-sm">None listed</p>';

        detailContent.innerHTML = `
            ${imageHTML}
            <div class="text-2xl font-bold mb-0.5">${esc(displayName)}</div>
            ${scientificLine}
            <div class="text-sm text-neutral-500 bg-neutral-100 px-3 py-1 rounded-full inline-block mb-4">${esc(plant.type)}</div>
            <p class="text-neutral-500 text-sm mb-6 leading-7">${esc(plant.description)}</p>

            <div class="watering-countdown ${watering.statusClass} flex items-center gap-2.5 px-3.5 py-3 rounded-lg mb-5">
                <i class="fas fa-tint watering-icon text-base"></i>
                <div class="flex-1">
                    <div class="watering-label text-[0.7rem] text-neutral-500 uppercase tracking-wide font-semibold">Next watering</div>
                    <div class="watering-time text-sm font-semibold">${watering.text}</div>
                </div>
            </div>

            <div class="mb-5">
                <div class="text-[0.7rem] font-semibold uppercase tracking-widest text-neutral-400 mb-2.5">Care Requirements</div>
                <div class="grid grid-cols-2 gap-2.5 max-md:grid-cols-1">
                    <div class="bg-neutral-50 p-3 rounded-lg">
                        <div class="text-[0.7rem] text-neutral-400 uppercase tracking-wide font-semibold"><i class="fas fa-tint"></i> Watering</div>
                        <div class="text-sm font-medium">${esc(plant.watering_frequency_text)}</div>
                    </div>
                    <div class="bg-neutral-50 p-3 rounded-lg">
                        <div class="text-[0.7rem] text-neutral-400 uppercase tracking-wide font-semibold"><i class="fas fa-sun"></i> Light</div>
                        <div class="text-sm font-medium">${esc(plant.light)}</div>
                    </div>
                    <div class="bg-neutral-50 p-3 rounded-lg">
                        <div class="text-[0.7rem] text-neutral-400 uppercase tracking-wide font-semibold"><i class="fas fa-water"></i> Humidity</div>
                        <div class="text-sm font-medium">${esc(plant.humidity)}</div>
                    </div>
                    <div class="bg-neutral-50 p-3 rounded-lg">
                        <div class="text-[0.7rem] text-neutral-400 uppercase tracking-wide font-semibold"><i class="fas fa-thermometer-half"></i> Temperature</div>
                        <div class="text-sm font-medium">${formatTemp(esc(plant.temperature))}</div>
                    </div>
                    <div class="bg-neutral-50 p-3 rounded-lg">
                        <div class="text-[0.7rem] text-neutral-400 uppercase tracking-wide font-semibold"><i class="fas fa-mountain"></i> Soil</div>
                        <div class="text-sm font-medium">${esc(plant.soil)}</div>
                    </div>
                </div>
            </div>

            <div class="mb-5">
                <div class="text-[0.7rem] font-semibold uppercase tracking-widest text-neutral-400 mb-2.5">Common Issues</div>
                ${issuesHTML}
            </div>

            <div class="mb-5">
                <div class="text-[0.7rem] font-semibold uppercase tracking-widest text-neutral-400 mb-2.5">Useful Tips</div>
                ${tipsHTML}
            </div>

            <div class="flex gap-3 mt-6 pt-4 border-t border-neutral-100">
                <button class="flex-1 justify-center bg-sky-100 text-sky-700 px-4 py-2 rounded-lg text-xs font-semibold border-none cursor-pointer transition-colors hover:bg-sky-200 inline-flex items-center gap-1.5" onclick="waterPlant(${plant.id})">
                    <i class="fas fa-tint"></i> Mark as Watered
                </button>
                <button class="flex-1 justify-center bg-neutral-100 text-neutral-900 px-5 py-2.5 rounded-lg text-sm font-medium border-none cursor-pointer transition-colors hover:bg-neutral-200 inline-flex items-center gap-1.5" onclick="openEditForm(${plant.id})">
                    <i class="fas fa-pen"></i> Edit
                </button>
                <button class="flex-1 justify-center bg-red-600 text-white px-5 py-2.5 rounded-lg text-sm font-medium border-none cursor-pointer transition-colors hover:bg-red-700 inline-flex items-center gap-1.5" onclick="confirmDelete(${plant.id})">
                    <i class="fas fa-trash"></i> Delete
                </button>
            </div>
        `;

        openModal(detailModal);
    }

    // --- Form handling ---

    function openAddForm() {
        formTitle.textContent = 'Add Plant';
        plantForm.reset();
        document.getElementById('plantId').value = '';
        currentIssues = [];
        currentTips = [];
        renderListItems(issuesItems, currentIssues);
        renderListItems(tipsItems, currentTips);
        resetImagePreview();
        removeImageLabel.style.display = 'none';
        formError.style.display = 'none';
        clearValidation();
        closeModal(detailModal);
        openModal(formModal);
    }

    window.openEditForm = function (id) {
        const plant = plants.find(p => p.id === id);
        if (!plant) return;

        formTitle.textContent = 'Edit Plant';
        document.getElementById('plantId').value = plant.id;
        document.getElementById('plantName').value = plant.name;
        document.getElementById('plantNickname').value = plant.nickname || '';
        document.getElementById('plantType').value = plant.type;
        document.getElementById('plantDescription').value = plant.description;
        document.getElementById('wateringText').value = plant.watering_frequency_text;
        document.getElementById('wateringMin').value = plant.watering_min_days;
        document.getElementById('wateringMax').value = plant.watering_max_days;
        document.getElementById('plantLight').value = plant.light;
        document.getElementById('plantHumidity').value = plant.humidity;
        document.getElementById('plantTemperature').value = plant.temperature;
        document.getElementById('plantSoil').value = plant.soil;

        currentIssues = [...(plant.common_issues || [])];
        currentTips = [...(plant.useful_tips || [])];
        renderListItems(issuesItems, currentIssues);
        renderListItems(tipsItems, currentTips);

        document.getElementById('removeImage').checked = false;
        if (plant.image_url) {
            imagePreview.innerHTML = `<img src="../../${esc(plant.image_url)}" alt="Current">`;
            imagePreview.classList.add('has-image');
            removeImageLabel.style.display = 'flex';
        } else {
            resetImagePreview();
            removeImageLabel.style.display = 'none';
        }

        formError.style.display = 'none';
        clearValidation();
        closeModal(detailModal);
        openModal(formModal);
    };

    async function handleFormSubmit(e) {
        e.preventDefault();
        clearValidation();

        const id = document.getElementById('plantId').value;
        const formData = new FormData();

        const fields = {
            name: document.getElementById('plantName').value.trim(),
            nickname: document.getElementById('plantNickname').value.trim(),
            type: document.getElementById('plantType').value.trim(),
            description: document.getElementById('plantDescription').value.trim(),
            watering_frequency_text: document.getElementById('wateringText').value.trim(),
            watering_min_days: document.getElementById('wateringMin').value,
            watering_max_days: document.getElementById('wateringMax').value,
            light: document.getElementById('plantLight').value.trim(),
            humidity: document.getElementById('plantHumidity').value.trim(),
            temperature: document.getElementById('plantTemperature').value.trim(),
            soil: document.getElementById('plantSoil').value.trim(),
        };

        // Client-side validation
        const errors = [];
        const required = ['name', 'type', 'description', 'watering_frequency_text',
            'watering_min_days', 'watering_max_days', 'light', 'humidity', 'temperature', 'soil'];

        required.forEach(field => {
            if (!fields[field]) {
                errors.push(field);
                const el = getFieldElement(field);
                if (el) el.classList.add('invalid');
            }
        });

        if (errors.length > 0) {
            showFormError('Please fill in all required fields');
            return;
        }

        const minDays = parseInt(fields.watering_min_days, 10);
        const maxDays = parseInt(fields.watering_max_days, 10);
        if (minDays < 1) {
            showFormError('Minimum watering days must be at least 1');
            document.getElementById('wateringMin').classList.add('invalid');
            return;
        }
        if (maxDays < minDays) {
            showFormError('Maximum watering days must be greater than or equal to minimum');
            document.getElementById('wateringMax').classList.add('invalid');
            return;
        }

        Object.entries(fields).forEach(([key, val]) => formData.append(key, val));
        formData.append('common_issues', JSON.stringify(currentIssues));
        formData.append('useful_tips', JSON.stringify(currentTips));

        const imageFile = document.getElementById('plantImage').files[0];
        if (imageFile) {
            formData.append('image', imageFile);
        }

        if (id && document.getElementById('removeImage').checked) {
            formData.append('remove_image', '1');
        }

        setSubmitting(true);

        try {
            if (id) {
                await updatePlant(id, formData);
                showToast('Plant updated');
            } else {
                await createPlant(formData);
                showToast('Plant added');
            }
            closeModal(formModal);
            await loadPlants();
        } catch (err) {
            showFormError(err.message);
        } finally {
            setSubmitting(false);
        }
    }

    function getFieldElement(field) {
        const map = {
            name: 'plantName',
            type: 'plantType',
            description: 'plantDescription',
            watering_frequency_text: 'wateringText',
            watering_min_days: 'wateringMin',
            watering_max_days: 'wateringMax',
            light: 'plantLight',
            humidity: 'plantHumidity',
            temperature: 'plantTemperature',
            soil: 'plantSoil',
        };
        return document.getElementById(map[field]);
    }

    function showFormError(msg) {
        formError.textContent = msg;
        formError.style.display = 'block';
    }

    function clearValidation() {
        formError.style.display = 'none';
        document.querySelectorAll('.invalid').forEach(el => el.classList.remove('invalid'));
    }

    function setSubmitting(loading) {
        const btn = document.getElementById('formSubmit');
        btn.querySelector('.btn-text').style.display = loading ? 'none' : 'inline';
        btn.querySelector('.btn-loading').style.display = loading ? 'inline-flex' : 'none';
        btn.disabled = loading;
    }

    function resetImagePreview() {
        imagePreview.innerHTML = `
            <i class="fas fa-cloud-upload-alt"></i>
            <span>Click or drag to upload</span>
        `;
        imagePreview.classList.remove('has-image');
        document.getElementById('plantImage').value = '';
    }

    // --- List items (issues/tips) ---

    function renderListItems(container, items) {
        container.innerHTML = items.map((item, i) => `
            <div class="list-item">
                <span>${esc(item)}</span>
                <button type="button" onclick="removeListItem(this, ${i})" title="Remove">
                    <i class="fas fa-times"></i>
                </button>
            </div>
        `).join('');
    }

    window.removeListItem = function (btn, index) {
        const container = btn.closest('.list-input');
        if (container.id === 'issuesList') {
            currentIssues.splice(index, 1);
            renderListItems(issuesItems, currentIssues);
        } else {
            currentTips.splice(index, 1);
            renderListItems(tipsItems, currentTips);
        }
    };

    function addListItem(input, items, container) {
        const val = input.value.trim();
        if (!val) return;
        items.push(val);
        renderListItems(container, items);
        input.value = '';
    }

    // --- Delete ---

    window.confirmDelete = function (id) {
        const plant = plants.find(p => p.id === id);
        if (!plant) return;
        deleteTargetId = id;
        deletePlantName.textContent = plant.nickname || plant.name;
        closeModal(detailModal);
        openModal(deleteModal);
    };

    async function handleDelete() {
        if (!deleteTargetId) return;
        try {
            await deletePlantApi(deleteTargetId);
            showToast('Plant deleted');
            closeModal(deleteModal);
            await loadPlants();
        } catch (err) {
            showToast(err.message, true);
        }
        deleteTargetId = null;
    }

    // --- Water ---

    window.waterPlant = async function (id) {
        try {
            await waterPlantApi(id);
            showToast('Marked as watered');
            closeModal(detailModal);
            await loadPlants();
        } catch (err) {
            showToast(err.message, true);
        }
    };

    // --- Modal helpers ---

    function openModal(modal) {
        modal.classList.add('active');
        document.body.style.overflow = 'hidden';
    }

    function closeModal(modal) {
        modal.classList.remove('active');
        if (!document.querySelector('.modal-overlay.active')) {
            document.body.style.overflow = '';
        }
    }

    // --- Toast ---

    function showToast(msg, isError = false) {
        const toast = document.createElement('div');
        toast.className = `toast ${isError ? 'bg-red-600' : 'bg-neutral-900'} text-white px-5 py-3 rounded-lg text-sm font-medium shadow-lg inline-flex items-center gap-2`;
        toast.innerHTML = `<i class="fas fa-${isError ? 'exclamation-circle' : 'check-circle'}"></i> ${esc(msg)}`;
        toastContainer.appendChild(toast);

        setTimeout(() => {
            toast.classList.add('toast-out');
            toast.addEventListener('animationend', () => toast.remove());
        }, 3000);
    }

    // --- Event listeners ---

    document.getElementById('addPlantBtn').addEventListener('click', openAddForm);
    document.getElementById('emptyAddBtn').addEventListener('click', openAddForm);
    document.getElementById('retryBtn').addEventListener('click', loadPlants);

    plantForm.addEventListener('submit', handleFormSubmit);
    document.getElementById('formCancel').addEventListener('click', () => closeModal(formModal));
    document.getElementById('formClose').addEventListener('click', () => closeModal(formModal));
    document.getElementById('detailClose').addEventListener('click', () => closeModal(detailModal));
    document.getElementById('deleteCancelBtn').addEventListener('click', () => closeModal(deleteModal));
    document.getElementById('deleteConfirmBtn').addEventListener('click', handleDelete);

    // Close modals on overlay click
    [detailModal, formModal, deleteModal].forEach(modal => {
        modal.addEventListener('click', e => {
            if (e.target === modal) closeModal(modal);
        });
    });

    // Card click → detail
    plantsGrid.addEventListener('click', e => {
        const card = e.target.closest('.plant-card');
        if (!card) return;
        if (e.target.closest('button')) return;
        const id = parseInt(card.dataset.id, 10);
        const plant = plants.find(p => p.id === id);
        if (plant) showPlantDetail(plant);
    });

    // Issues/tips add buttons and enter key
    document.getElementById('addIssueBtn').addEventListener('click', () => {
        addListItem(document.getElementById('issueInput'), currentIssues, issuesItems);
    });
    document.getElementById('addTipBtn').addEventListener('click', () => {
        addListItem(document.getElementById('tipInput'), currentTips, tipsItems);
    });
    document.getElementById('issueInput').addEventListener('keydown', e => {
        if (e.key === 'Enter') {
            e.preventDefault();
            addListItem(e.target, currentIssues, issuesItems);
        }
    });
    document.getElementById('tipInput').addEventListener('keydown', e => {
        if (e.key === 'Enter') {
            e.preventDefault();
            addListItem(e.target, currentTips, tipsItems);
        }
    });

    // Image preview
    document.getElementById('plantImage').addEventListener('change', e => {
        const file = e.target.files[0];
        if (!file) return;

        const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
        if (!allowed.includes(file.type)) {
            showToast('Invalid image type. Use JPEG, PNG, WebP, or GIF', true);
            e.target.value = '';
            return;
        }
        if (file.size > 5 * 1024 * 1024) {
            showToast('Image must be under 5MB', true);
            e.target.value = '';
            return;
        }

        const reader = new FileReader();
        reader.onload = ev => {
            imagePreview.innerHTML = `<img src="${ev.target.result}" alt="Preview">`;
            imagePreview.classList.add('has-image');
        };
        reader.readAsDataURL(file);
    });

    // Escape key closes top modal
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            const activeModal = document.querySelector('.modal-overlay.active');
            if (activeModal) closeModal(activeModal);
        }
    });

    // --- Init ---
    loadPlants();
})();
