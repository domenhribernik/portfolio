/* Homepage colophon contact form. Validates with the shared pure module,
   POSTs to app/proxys/contact.php, and reflects state in the status line and
   per-field error slots. Delivery is a DB row + a Telegram ping to the owner;
   the form only needs a 200 {ok:true} back. */

import { validateContact } from './contact-logic.js';

const ENDPOINT = 'app/proxys/contact.php';

const form = document.getElementById('contactForm');
if (form) {
    const fields = {
        name: form.querySelector('#cf-name'),
        email: form.querySelector('#cf-email'),
        message: form.querySelector('#cf-message'),
    };
    const errSlots = {
        name: form.querySelector('[data-err="name"]'),
        email: form.querySelector('[data-err="email"]'),
        message: form.querySelector('[data-err="message"]'),
    };
    const honeypot = form.querySelector('#cf-website');
    const submit = form.querySelector('.colophon__submit');
    const submitLabel = form.querySelector('.colophon__submit-label');
    const status = form.querySelector('.colophon__status');

    function showErrors(errors) {
        for (const key of Object.keys(fields)) {
            const msg = errors[key];
            const slot = errSlots[key];
            fields[key].classList.toggle('is-invalid', Boolean(msg));
            if (slot) {
                slot.textContent = msg || '';
                slot.hidden = !msg;
            }
        }
    }

    function clearError(key) {
        fields[key].classList.remove('is-invalid');
        if (errSlots[key]) {
            errSlots[key].textContent = '';
            errSlots[key].hidden = true;
        }
    }

    function setStatus(text, kind) {
        status.textContent = text || '';
        status.className = 'colophon__status' + (kind ? ` colophon__status--${kind}` : '');
    }

    // Clear a field's error as soon as the visitor starts fixing it.
    for (const key of Object.keys(fields)) {
        fields[key].addEventListener('input', () => clearError(key));
    }

    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const { valid, errors, clean } = validateContact({
            name: fields.name.value,
            email: fields.email.value,
            message: fields.message.value,
        });

        showErrors(errors);
        if (!valid) {
            setStatus('Please fix the highlighted fields.', 'error');
            const firstBad = Object.keys(fields).find((k) => errors[k]);
            if (firstBad) fields[firstBad].focus();
            return;
        }

        submit.disabled = true;
        submitLabel.textContent = 'Sending…';
        setStatus('Sending…', 'sending');

        try {
            const res = await fetch(ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...clean, website: honeypot ? honeypot.value : '' }),
            });

            if (res.ok) {
                form.reset();
                showErrors({});
                setStatus("Thanks, your message is on its way. I'll be in touch soon.", 'ok');
            } else if (res.status === 422) {
                const data = await res.json().catch(() => ({}));
                showErrors(data.errors || {});
                setStatus('Please fix the highlighted fields.', 'error');
            } else {
                throw new Error(`HTTP ${res.status}`);
            }
        } catch (err) {
            setStatus('Something went wrong sending that. Email me directly at contact@domenhribernik.com.', 'error');
        } finally {
            submit.disabled = false;
            submitLabel.textContent = 'Send message';
        }
    });
}
