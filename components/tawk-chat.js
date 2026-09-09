/* Tawk.to live chat, behind consent.
 *
 * The widget sets its own cookies and tracks the visitor across the
 * session, so it waits for the "chat" purpose. Same fail-closed rule as
 * google-analytics.js: no consent.js on the page means no chat.
 *
 * Do NOT add this to new views (see components/CLAUDE.md).
 */
(function () {
    'use strict';

    var consent = window.portfolioConsent;
    if (!consent) return;

    consent.require('chat');

    consent.whenGranted('chat', function () {
        window.Tawk_API = window.Tawk_API || {};
        window.Tawk_LoadStart = new Date();

        var s1 = document.createElement('script');
        var s0 = document.getElementsByTagName('script')[0];
        s1.async = true;
        s1.src = 'https://embed.tawk.to/6a154d3fbc77081c353c6579/1jphjbgp4';
        s1.charset = 'UTF-8';
        s1.setAttribute('crossorigin', '*');
        s0.parentNode.insertBefore(s1, s0);
    });
})();
