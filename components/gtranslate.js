/* GTranslate, loaded on demand.
 *
 * Translation is a service the visitor explicitly requests, so it needs no
 * consent toggle. What it must not do is phone cdn.gtranslate.net on every
 * page view for the majority who never touch the language picker, so the
 * widget script is fetched on the first interaction with the picker instead
 * of at page load.
 *
 * A visitor who already picked a language carries the `googtrans` cookie.
 * For them the widget loads immediately, otherwise the page would render
 * untranslated despite their choice.
 *
 * Gotcha kept from before: main-navbar.js renders only the picker shell with
 * an empty .gtranslate_wrapper, and this file injects the actual links. Omit
 * it and the dropdown renders but does nothing. The navbar's MutationObserver
 * picks the links up whenever they arrive, so arriving late is fine.
 */
(function () {
    'use strict';

    //? currentScript is only readable while this script is executing, so the
    //? per-page accent colour is captured now, not inside the loader.
    var color =
        (document.currentScript && document.currentScript.getAttribute('data-color')) || '#66aaff';

    window.gtranslateSettings = {
        default_language: 'en',
        languages: ['en', 'sl', 'de', 'es', 'fr', 'zh-CN'],
        globe_color: color,
        wrapper_selector: '.gtranslate_wrapper',
        flag_size: 24,
        alt_flags: { en: 'usa' },
        globe_size: 40,
    };

    var loaded = false;

    function load() {
        if (loaded) return;
        loaded = true;
        document.removeEventListener('click', onFirstUse, true);
        document.removeEventListener('keydown', onFirstUse, true);

        var s = document.createElement('script');
        s.src = 'https://cdn.gtranslate.net/widgets/latest/fn.js';
        s.defer = true;
        document.head.appendChild(s);
    }

    function onFirstUse(event) {
        //? Capture phase and a closest() test, because the navbar is a module
        //? and may not have rendered the picker when this script runs.
        if (!event.target.closest) return;
        if (event.target.closest('#langPicker, .gtranslate_wrapper')) load();
    }

    if (/(^|;\s*)googtrans=/.test(document.cookie)) {
        load();
    } else {
        document.addEventListener('click', onFirstUse, true);
        document.addEventListener('keydown', onFirstUse, true);
    }
})();
