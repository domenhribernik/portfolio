// BATTLESHIP // the themes, DOM free.
//
// A theme is colour only, and each player's own: it is kept on their own
// device and never travels to the room, so the other side sees the game in
// whatever they picked. The colours themselves live in style.css, one token
// block per key below. tests/battleship-theme.test.mjs holds the three
// homes of a theme together: this list, its CSS block, its ui.json row.

/** In picker order. The first is the default. */
export const THEMES = ['ops', 'girlypop'];

export const DEFAULT_THEME = THEMES[0];

// The inline script in index.html's head reads the same key before the first
// paint, so a saved theme never flashes the default on the way in.
export const THEME_KEY = 'battleship:theme';

/** The theme to wear, given whatever storage handed back. */
export function resolveTheme(stored) {
    return THEMES.includes(stored) ? stored : DEFAULT_THEME;
}
