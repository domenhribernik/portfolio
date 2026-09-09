/* The "your current choices" box.
 *
 * Withdrawing consent has to be as easy as giving it, so the policy shows
 * what you actually chose and reopens the banner rather than telling you to
 * go and clear cookies yourself.
 */

const panel = document.querySelector('[data-consent-panel]');
const state = document.querySelector('[data-consent-state]');
const button = document.querySelector('[data-consent-open]');

function describe() {
    const consent = window.portfolioConsent;

    //? This page loads consent.js, so a missing API means the script was
    //? blocked. Say so rather than printing a confident wrong answer.
    if (!consent) {
        state.textContent =
            'The consent script did not load, so nothing optional is running and there is nothing to change.';
        button.hidden = true;
        return;
    }

    if (!consent.decided()) {
        state.textContent =
            'You have not answered the cookie question yet, so analytics and chat are switched off.';
        button.hidden = false;
        return;
    }

    const on = [];
    if (consent.granted('analytics')) on.push('analytics');
    if (consent.granted('chat')) on.push('live chat');

    state.textContent = on.length
        ? `You have allowed ${on.join(' and ')}. The login cookie is always on.`
        : 'You have turned everything optional off. Only the login cookie is used.';
    button.hidden = false;
}

if (panel) {
    describe();
    button.addEventListener('click', () => window.portfolioConsent.open());
    document.addEventListener('portfolio-consent-changed', describe);
}
