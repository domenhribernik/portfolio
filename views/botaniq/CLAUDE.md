# views/botaniq

Public plant shelf (listed in `project-data.js`, linked from the homepage), and the
repo's **reference example of the "read-only demo plus per-user rows" shape**. If you are
building a view with that shape, read this one first.

## The shape

- **Signed out:** visitors see the site owner's plants with all action buttons grayed
  out, plus a sign-in button top right. Nothing is hidden, the page is a live demo.
- **Signed in:** any user gets their own private shelf (`plants.user_id`). **No project
  role needed**, so there is no `projects` row to register and nothing to grant.

## Backend

[app/controllers/plants-controller.php](../../app/controllers/plants-controller.php):

- **Reads are public.** The demo shelf is the first active admin's, resolved by
  `showcaseUserId()`; `shelfUserId()` returns the viewer or falls back to the showcase.
- **Writes sit behind `Auth::requireLogin()`** and every query carries `AND user_id = ?`
  so a signed-in user can only touch their own rows.

Those two helpers are duplicated verbatim in each demo-shaped controller
(`sourdough-controller.php`, `jeger-controller.php`, `workout-controller.php`). That
duplication is accepted; only the `Auth` class itself is a shared include.

## Frontend

The payload carries `demo: true` when the viewer is seeing someone else's shelf. The page
uses that to show the read-only banner and disable its action controls. Sign-in links go
through `loginUrl()` imported from
[components/auth-gate.js](../../components/auth-gate.js), which builds
`../account/?redirect=<path>`.

Pure logic is [logic.js](logic.js), tested by
[tests/botaniq-logic.test.mjs](../../tests/botaniq-logic.test.mjs).

The back arrow is upgraded by [components/back-link.js](../../components/back-link.js), a
plain (non-module) script that must load **before** this view's own script tag.
