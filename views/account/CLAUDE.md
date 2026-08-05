# views/account

Sign-in and account page of the auth system. Unlisted private tool: never register it in
`components/project-data.js`, `index.html`, or the navbar. The admin dashboard is
[views/admin](../admin/), which also documents the site's authorization pattern.

Backend [app/controllers/auth-controller.php](../../app/controllers/auth-controller.php):
login (Google + password), logout, `me`, `config`, set-credentials, one-time reset
consumption, and the user's own sessions. Password logins are rate-limited via the
`login_attempts` table.

## Query parameters

- **`?redirect=<path>`**: where to send the user after a successful sign-in. This is what
  `loginUrl()` in [components/auth-gate.js](../../components/auth-gate.js) builds, and
  what plain-script views inline by hand.
- **`?reset=<token>`**: consumes a one-time password-reset link. Resets are
  **admin-driven only**, generated from the admin dashboard and delivered manually. There
  is no email sending anywhere in this codebase, so there is no "forgot password" flow to
  wire up.

## Visual language

The editorial paper theme shared with `views/admin`: paper/ink/clay palette, Fraunces +
IBM Plex Sans + Space Mono, matching the homepage's light editorial theme. Component
classes live in this view's own `style.css` because the Tailwind CDN cannot `@apply` in
linked stylesheets.
