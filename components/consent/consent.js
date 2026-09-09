/* ============================================================
   Cookie consent, in one classic script.

   ePrivacy (ZEKom-2 here) wants active opt-in before anything
   non-essential touches the visitor's device. Analytics and the
   chat widget both do, so neither may load until asked.

   LOAD ORDER: plain classic <script src>, in <head>, BEFORE
   google-analytics.js and tawk-chat.js. Those two register their
   intent against window.portfolioConsent and do nothing at all if
   this file is missing, so a page that forgets it fails closed
   (no tracking) rather than open. tests/legal.test.mjs asserts the
   pairing so the two can never drift apart.

       <script src="../../components/consent/consent.js"></script>
       <script src="../../components/google-analytics.js"></script>

   The banner only appears on pages that actually asked for a gated
   purpose. A page with no analytics and no chat sets nothing, so it
   shows nothing: a banner that governs no cookie is just clutter.
   ============================================================ */
(function () {
    'use strict';

    var KEY = 'portfolio_consent';

    //? Bump when the purposes change meaning, which re-prompts everyone.
    //? The privacy page prints this same number so a visitor can tell
    //? which version of the policy they answered.
    var VERSION = 1;

    var PURPOSES = ['analytics', 'chat'];

    //? Every page sits at a different depth (/, /views/x/, /views/x/y/),
    //? so the privacy link is derived from this script's own URL rather
    //? than hardcoded. Keeps the local XAMPP path (/portfolio/...) working
    //? without a build step.
    var SITE_ROOT = (function () {
        var self = document.currentScript && document.currentScript.src;
        if (!self) return '/';
        return self.replace(/components\/consent\/consent\.js.*$/, '');
    })();

    var STYLE_ID = 'pc-consent-style';

    // ---------------------------------------------------------- state

    function read() {
        try {
            var raw = window.localStorage.getItem(KEY);
            if (!raw) return null;
            var parsed = JSON.parse(raw);
            if (!parsed || parsed.version !== VERSION) return null;
            return parsed;
        } catch (e) {
            //? Private mode and "block site data" both throw on access.
            //? No stored decision means no consent, which is the safe read.
            return null;
        }
    }

    function write(choices) {
        var record = {
            version: VERSION,
            timestamp: new Date().toISOString(),
            analytics: !!choices.analytics,
            chat: !!choices.chat,
        };
        try {
            window.localStorage.setItem(KEY, JSON.stringify(record));
        } catch (e) {
            //? Storage refused. The decision still applies to this page
            //? view; the visitor is simply asked again next time.
        }
        return record;
    }

    var state = read();

    //? Purposes this page actually uses. Populated by require() from the
    //? gated loaders, and the reason a page with neither shows no banner.
    var used = {};

    //? Callbacks parked until their purpose is granted.
    var waiting = { analytics: [], chat: [] };

    function granted(purpose) {
        return !!(state && state[purpose]);
    }

    function flush() {
        PURPOSES.forEach(function (purpose) {
            if (!granted(purpose)) return;
            var queue = waiting[purpose];
            waiting[purpose] = [];
            queue.forEach(function (cb) {
                try {
                    cb();
                } catch (e) {
                    if (window.console) console.error('consent callback failed', e);
                }
            });
        });
    }

    function apply(choices) {
        state = write(choices);
        close();
        flush();
        document.dispatchEvent(
            new CustomEvent('portfolio-consent-changed', { detail: Object.assign({}, state) })
        );
    }

    // ------------------------------------------------------------ CSS

    var CSS = [
        '.pc-banner{position:fixed;z-index:2147483000;left:1rem;right:1rem;bottom:1rem;',
        'max-width:34rem;margin:0 auto;background:#1c1a17;color:#f6f2ea;border-radius:.5rem;',
        'box-shadow:0 12px 40px rgba(0,0,0,.35);padding:1.25rem;',
        "font-family:'IBM Plex Sans',system-ui,-apple-system,Segoe UI,sans-serif;",
        'font-size:.9rem;line-height:1.55;text-align:left;}',
        '@media (min-width:768px){.pc-banner{left:1.5rem;right:auto;bottom:1.5rem;margin:0;}}',
        '.pc-banner h2{margin:0 0 .4rem;font-size:1rem;font-weight:600;color:#f6f2ea;',
        "font-family:'IBM Plex Sans',system-ui,sans-serif;letter-spacing:0;}",
        '.pc-banner p{margin:0 0 .9rem;color:#cfc7b8;}',
        '.pc-banner a{color:#f2b705;text-decoration:underline;}',
        '.pc-actions{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;}',
        '.pc-btn{flex:1 1 8rem;appearance:none;border:1px solid transparent;border-radius:.3rem;',
        'padding:.55rem .9rem;font:inherit;font-weight:600;cursor:pointer;text-align:center;}',
        //? Accept and reject are deliberately the same size and weight.
        //? A quiet "reject" next to a loud "accept" is not free consent.
        '.pc-btn--accept{background:#f6f2ea;color:#1c1a17;}',
        '.pc-btn--reject{background:transparent;color:#f6f2ea;border-color:rgba(246,242,234,.45);}',
        '.pc-btn:hover{opacity:.88;}',
        '.pc-btn:focus-visible,.pc-link:focus-visible{outline:2px solid #f2b705;outline-offset:2px;}',
        '.pc-link{flex:0 0 auto;background:none;border:0;padding:.55rem .25rem;font:inherit;',
        'color:#cfc7b8;text-decoration:underline;cursor:pointer;}',
        '.pc-choices{margin:.9rem 0 0;padding:.9rem 0 0;border-top:1px solid rgba(246,242,234,.18);}',
        '.pc-choice{display:flex;gap:.6rem;align-items:flex-start;margin-bottom:.7rem;}',
        '.pc-choice input{margin:.25rem 0 0;flex:0 0 auto;width:1rem;height:1rem;accent-color:#f2b705;}',
        '.pc-choice span{display:block;color:#cfc7b8;font-size:.85rem;}',
        '.pc-choice strong{display:block;color:#f6f2ea;font-weight:600;}',
        '.pc-banner[hidden]{display:none!important;}',
    ].join('');

    function injectStyles() {
        if (document.getElementById(STYLE_ID)) return;
        var style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    // ----------------------------------------------------------- view

    var node = null;
    var lastFocus = null;

    function close() {
        if (!node) return;
        node.remove();
        node = null;
        if (lastFocus && lastFocus.focus) lastFocus.focus();
        lastFocus = null;
    }

    function render(expanded) {
        injectStyles();
        if (node) node.remove();

        node = document.createElement('div');
        node.className = 'pc-banner';
        node.setAttribute('role', 'dialog');
        node.setAttribute('aria-modal', 'false');
        node.setAttribute('aria-label', 'Cookie choices');

        var privacy = SITE_ROOT + 'views/privacy/#cookies';
        var rows = '';
        if (expanded) {
            rows =
                '<div class="pc-choices">' +
                (used.analytics
                    ? choiceRow(
                          'analytics',
                          'Analytics',
                          'Google Analytics, so I can see which pages people actually read. Off by default.'
                      )
                    : '') +
                (used.chat
                    ? choiceRow(
                          'chat',
                          'Live chat',
                          'Tawk.to, the chat bubble. Loads only if you want to message me.'
                      )
                    : '') +
                '</div>';
        }

        node.innerHTML =
            '<h2>A quick cookie question</h2>' +
            '<p>This site needs nothing but a login cookie to work. ' +
            'Analytics and chat are optional and load only if you say yes. ' +
            '<a href="' + privacy + '">What gets stored</a>.</p>' +
            '<div class="pc-actions">' +
            '<button type="button" class="pc-btn pc-btn--accept" data-pc="accept">Accept</button>' +
            '<button type="button" class="pc-btn pc-btn--reject" data-pc="reject">Reject</button>' +
            (expanded ? '' : '<button type="button" class="pc-link" data-pc="choose">Choose</button>') +
            '</div>' +
            rows +
            (expanded
                ? '<div class="pc-actions" style="margin-top:.9rem"><button type="button" ' +
                  'class="pc-btn pc-btn--accept" data-pc="save">Save choices</button></div>'
                : '');

        node.addEventListener('click', onClick);
        document.body.appendChild(node);

        var first = node.querySelector('button');
        if (first) first.focus();
    }

    function choiceRow(purpose, label, blurb) {
        var on = granted(purpose) ? ' checked' : '';
        return (
            '<label class="pc-choice">' +
            '<input type="checkbox" data-pc-purpose="' + purpose + '"' + on + '>' +
            '<span><strong>' + label + '</strong>' + blurb + '</span>' +
            '</label>'
        );
    }

    function onClick(event) {
        var button = event.target.closest('[data-pc]');
        if (!button) return;
        var action = button.getAttribute('data-pc');

        if (action === 'choose') return render(true);
        if (action === 'accept') return apply({ analytics: true, chat: true });
        if (action === 'reject') return apply({ analytics: false, chat: false });
        if (action === 'save') {
            var choices = {};
            //? Purposes this page never declared keep whatever they had, so
            //? saving on a page without chat cannot silently revoke chat.
            PURPOSES.forEach(function (purpose) {
                choices[purpose] = granted(purpose);
            });
            node.querySelectorAll('[data-pc-purpose]').forEach(function (input) {
                choices[input.getAttribute('data-pc-purpose')] = input.checked;
            });
            return apply(choices);
        }
    }

    function maybePrompt() {
        //? Nothing gated on this page, or the visitor already answered.
        if (state || !Object.keys(used).length) return;
        lastFocus = document.activeElement;
        render(false);
    }

    function ready(fn) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', fn);
        } else {
            fn();
        }
    }

    // ------------------------------------------------------------ API

    window.portfolioConsent = {
        VERSION: VERSION,

        granted: granted,

        decided: function () {
            return !!state;
        },

        /* Declare that this page uses a gated purpose. Only a declared
           purpose can raise the banner or appear in its toggle list. */
        require: function (purpose) {
            used[purpose] = true;
        },

        /* Run cb once the purpose is granted: immediately if it already is,
           otherwise when the visitor grants it, without a reload. */
        whenGranted: function (purpose, cb) {
            if (granted(purpose)) return cb();
            waiting[purpose].push(cb);
        },

        /* Re-open the settings. Used by the footer's "Cookie settings" link. */
        open: function () {
            //? Reached from the footer, which is on every page including ones
            //? that gate nothing. Offer both purposes there so the link is
            //? never a dead end.
            if (!Object.keys(used).length) {
                used.analytics = true;
                used.chat = true;
            }
            lastFocus = document.activeElement;
            ready(function () {
                render(true);
            });
        },
    };

    ready(maybePrompt);
})();
