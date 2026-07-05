/**
 * Reusable login-wall behavior for any view gated by Auth::requireProjectRole().
 *
 * This is deliberately behavior-only, not a visual component: every view keeps
 * its own look (see CLAUDE.md), so the actual "sign in" markup lives in each
 * view's own HTML/CSS. This module just classifies a gated fetch response and
 * builds the redirect URL consistently, so that logic isn't hand-rolled per view.
 *
 * Usage (from a view two levels under views/, e.g. views/<name>/script.js):
 *   import { gatedFetch, loginUrl } from '../../components/auth-gate.js';
 *
 *   async function load() {
 *       await gatedFetch(API, {}, {
 *           onSignedOut: showSignin,   // render your own "please sign in" state
 *           onForbidden: showNoAccess, // render your own "no access yet" state
 *           onOk: (data) => { items = data; render(); },
 *           onError: showError,
 *       });
 *   }
 *
 *   function showSignin() {
 *       signinLink.href = loginUrl(); // -> ../account/?redirect=<current path>
 *       // ...toggle your own DOM states
 *   }
 */

// All views live at views/<name>/, so the account page is always one level up.
const ACCOUNT_PATH = '../account/';

/**
 * Build the sign-in URL that returns the user to this page after login.
 * @param {string} [redirectPath] Defaults to the current page's path.
 */
export function loginUrl(redirectPath = location.pathname) {
    return ACCOUNT_PATH + '?redirect=' + encodeURIComponent(redirectPath);
}

/**
 * Fetch a project-gated endpoint and dispatch to the matching handler based
 * on the response, so callers don't re-derive the same 401/403 branching.
 * @param {string} url
 * @param {RequestInit} options
 * @param {{onSignedOut: Function, onForbidden: Function, onOk: (data: any) => void, onError: (message: string) => void}} handlers
 */
export async function gatedFetch(url, options, handlers) {
    let response;
    try {
        response = await fetch(url, options);
    } catch {
        handlers.onError('Could not reach the server. Check your connection and try again.');
        return;
    }
    if (response.status === 401) {
        handlers.onSignedOut();
        return;
    }
    if (response.status === 403) {
        handlers.onForbidden();
        return;
    }

    const data = await response.json().catch(() => null);
    if (!response.ok) {
        handlers.onError((data && data.error) || `Request failed (${response.status})`);
        return;
    }
    handlers.onOk(data);
}
