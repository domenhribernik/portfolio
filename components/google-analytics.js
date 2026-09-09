/* Google Analytics 4, behind consent.
 *
 * Nothing here contacts Google until the visitor has granted the
 * "analytics" purpose. If consent.js has not been loaded, this file does
 * nothing at all: a page that forgets the consent tag gets no analytics
 * rather than unconsented analytics.
 *
 *     <script src="../../components/consent/consent.js"></script>
 *     <script src="../../components/google-analytics.js"></script>
 */
(function () {
    'use strict';

    var ID = 'G-YKL3ML3L5J';

    window.dataLayer = window.dataLayer || [];
    function gtag() { dataLayer.push(arguments); }
    window.gtag = gtag;

    //? Consent Mode v2 defaults, queued before the tag exists so they are
    //? the first thing it reads if it ever does load. Belt and braces: the
    //? real gate is that we simply never inject the script until granted.
    gtag('consent', 'default', {
        ad_storage: 'denied',
        ad_user_data: 'denied',
        ad_personalization: 'denied',
        analytics_storage: 'denied',
        functionality_storage: 'granted',
        security_storage: 'granted',
    });

    var consent = window.portfolioConsent;
    if (!consent) return;

    consent.require('analytics');

    consent.whenGranted('analytics', function () {
        gtag('consent', 'update', { analytics_storage: 'granted' });

        var s = document.createElement('script');
        s.async = true;
        s.src = 'https://www.googletagmanager.com/gtag/js?id=' + ID;
        document.head.appendChild(s);

        gtag('js', new Date());
        gtag('config', ID);
    });
})();
