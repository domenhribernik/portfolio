/* Pure validation for the homepage contact form. DOM-free so it can be
   unit-tested (tests/contact-logic.test.mjs) and shared by contact-form.js.
   The PHP endpoint (app/proxys/contact.php) mirrors these same rules, since
   client checks are only a courtesy: the server is the real gate. */

export const LIMITS = { name: 120, email: 255, message: 4000 };

// Deliberately loose: one @, a dot in the domain, no spaces. Real address
// validity is proven by delivery, not by regex, so we only reject the
// obviously-wrong and cap the length.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateContact(input) {
    const clean = {
        name: String(input?.name ?? '').trim(),
        email: String(input?.email ?? '').trim(),
        message: String(input?.message ?? '').trim(),
    };
    const errors = {};

    if (!clean.name) {
        errors.name = 'Please add your name.';
    } else if (clean.name.length > LIMITS.name) {
        errors.name = `Keep your name under ${LIMITS.name} characters.`;
    }

    if (!clean.email) {
        errors.email = 'Please add an email so I can reply.';
    } else if (clean.email.length > LIMITS.email || !EMAIL_RE.test(clean.email)) {
        errors.email = 'That email looks off, mind checking it?';
    }

    if (!clean.message) {
        errors.message = 'Tell me a little about it.';
    } else if (clean.message.length > LIMITS.message) {
        errors.message = `That's over ${LIMITS.message} characters, trim it a touch.`;
    }

    return { valid: Object.keys(errors).length === 0, errors, clean };
}
