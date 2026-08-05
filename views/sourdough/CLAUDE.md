# views/sourdough

Sourdough starter and loaf log in the **read-only demo plus per-user rows** shape (root
CLAUDE.md, "Authentication and Permissions"; the reference implementation of the shape is
[views/botaniq](../botaniq/)).

Backend [app/controllers/sourdough-controller.php](../../app/controllers/sourdough-controller.php).

## One portal per user

Signed out you see the owner's starter and loaves as a demo; signed in you get your own.
The usual helpers apply: `showcaseUserId()` is the first active site admin,
`shelfUserId()` is the viewer or the showcase. Writes are behind `Auth::requireLogin()`
and scoped `AND user_id = ?`.

Three resources:

| Query | Returns |
|---|---|
| `?resource=session` | `{demo, viewer}`, the flag the page uses to decide read-only mode |
| `?resource=starter` | The user's starter, **lazily created** on first access |
| `?resource=bread` | The user's loaves |

The starter is one-per-user and created on demand, so there is no "create starter" step in
the UI and no empty state to design for.

## Frontend

`script.js` is a **plain script**, not an ES module, so it cannot import from
`components/auth-gate.js`. The sign-in link is therefore inlined as
`../account/?redirect=<path>` rather than built by `loginUrl()`. Same for
[views/jeger](../jeger/). Keep them in sync with `auth-gate.js` if that URL shape ever
changes.

The back arrow is upgraded by [components/back-link.js](../../components/back-link.js),
loaded before this view's own script tag.
