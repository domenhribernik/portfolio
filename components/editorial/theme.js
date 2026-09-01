/* ============================================================
   The editorial theme, in one place.

   Assigns `tailwind.config` for every page in the editorial family
   (the public spine plus the signed-in tools). Before this file the
   same palette was retyped in 22 inline <script> blocks, so changing
   a colour meant 22 edits and the copies had already drifted.

   LOAD ORDER GOTCHA: this must be a plain classic <script src>
   placed immediately AFTER the Tailwind Play CDN tag. A
   `type="module"` script is deferred and would run after Tailwind's
   first pass, so the theme would silently not apply:

       <script src="https://cdn.tailwindcss.com"></script>
       <script src="../../components/editorial/theme.js"></script>

   The CSS half of the palette lives in theme.css. The two are kept
   honest by tests/editorial-theme.test.mjs, which fails if they
   disagree, so neither can drift again.
   ============================================================ */
(function () {
  'use strict';

  //? The canonical palette. theme.css mirrors these as CSS custom
  //  properties for hand-written CSS; the parity test asserts a match.
  var COLORS = {
    paper: '#f6f2ea',
    'paper-2': '#efe9dd',
    'paper-3': '#f0e2cf',
    card: '#fffdf8',
    ink: '#1c1a17',
    stone: '#6b6256',
    faint: '#a49a8a',
    clay: '#d4451f',
    'clay-dk': '#b8371a',
    pine: '#2f5b53',
    cobalt: '#1f35e0',
    'cobalt-dk': '#1226c0',
    marigold: '#f2b705',
    danger: '#b3261e',
    //? Not a hex: every divider and quiet rule, tinted from ink rather
    //  than a neutral grey. 0.12 is the value DESIGN.md documents. Five
    //  tool pages drifted to 0.14 and override it on their own line
    //  rather than being changed silently.
    hairline: 'rgba(28, 26, 23, 0.12)',
  };

  //? Two spellings of the same two colours are in the markup today:
  //  the spine writes bg-paper-2 / bg-clay-dk, the tools write
  //  bg-paper2 / text-claydk. Both are shipped so neither has to be
  //  rewritten. `paper-2` and `clay-dk` are the canonical form; the
  //  unhyphenated aliases are frozen, do not add more.
  COLORS.paper2 = COLORS['paper-2'];
  COLORS.claydk = COLORS['clay-dk'];

  //? Bricolage is the display face of the whole public site. The
  //  signed-in tools override `display` to Fraunces on their own line
  //  (see editorialTheme below); nothing else varies.
  var FONTS = {
    display: ['"Bricolage Grotesque"', 'sans-serif'],
    serif: ['"Bricolage Grotesque"', 'sans-serif'],
    sans: ['"IBM Plex Sans"', 'sans-serif'],
    mono: ['"Space Mono"', 'monospace'],
  };

  function assign(colors, fonts) {
    window.tailwind = window.tailwind || {};
    //? Assigning `tailwind.config` wholesale is what makes the Play CDN
    //  rebuild. Mutating a nested key in place does not, so extension
    //  pages must go through editorialTheme() rather than poking at
    //  tailwind.config.theme.extend.colors directly.
    window.tailwind.config = {
      theme: { extend: { colors: colors, fontFamily: fonts } },
    };
  }

  /* Pages needing a few extra tokens (or the Fraunces display face)
     call this after loading the file:

       editorialTheme({ colors: { gain: '#177d5b', loss: '#d4451f' } });
       editorialTheme({ fonts:  { display: ['Fraunces', 'Georgia', 'serif'] } });
  */
  window.editorialTheme = function (extra) {
    extra = extra || {};
    var colors = Object.assign({}, COLORS, extra.colors || {});
    var fonts = Object.assign({}, FONTS, extra.fonts || {});
    assign(colors, fonts);
    return window.tailwind.config;
  };

  window.editorialTheme.COLORS = COLORS;
  window.editorialTheme.FONTS = FONTS;

  assign(COLORS, FONTS);
})();
