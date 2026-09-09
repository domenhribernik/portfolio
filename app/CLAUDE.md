# app/

PHP backend (API proxying and database CRUD) plus a few standalone Python scripts
(scheduled data jobs and Telegram alerts).

## Layout

- [config/](config/): database access and other configuration (`database.php`,
  `dev-mode.php`, `auth.php`)
- [models/](models/): SQL / data storage definitions, one `<name>-model.sql` per feature.
  Run-once data scripts (backfills, tile seeds, one-off migrations) go in
  [models/seeds/](models/seeds/) instead, so the schema files stay easy to scan
- [controllers/](controllers/): CRUD operations for the database
- [services/](services/): higher-level functions composing controllers
- [proxys/](proxys/): external API proxies (hiding API keys) and small endpoints.
  See [proxys/CLAUDE.md](proxys/CLAUDE.md)
- [cache/](cache/): cached proxy and script responses
- [data/](data/): static JSON. **Gitignored** (server-side data only), so any JSON a
  feature needs in version control must live in its view folder instead
  (e.g. `views/nebo/stars.json`)
- [admin/](admin/): internal HTML admin tools; not linked from the public site
- [scripts/](scripts/): standalone cron/CLI scripts. See [scripts/CLAUDE.md](scripts/CLAUDE.md)
- [vendor/](vendor/): Composer dependencies (phpdotenv)

**XAMPP `exec()` gotcha:** XAMPP's Apache exports `LD_LIBRARY_PATH=/opt/lampp/lib`, whose
bundled (ancient) libstdc++ breaks system binaries launched from PHP (`ffmpeg` fails with
`CXXABI` / `GLIBCXX` errors). Any `exec()` of a system tool must strip it:
`exec('env -u LD_LIBRARY_PATH ...')`. Precedent: `controllers/music-controller.php`.

When developing locally without XAMPP running, requests through PHP proxies/services will fail.

## Authentication and Permissions

Global user accounts with Google Sign-In as the primary login (GSI ID token verified
server-side in [services/google-auth-service.php](services/google-auth-service.php)) plus
an optional backup username/password set after the first Google login. Sessions are
DB-backed: an opaque token in an httpOnly `portfolio_sid` cookie, stored only as a
SHA-256 hash in `sessions` (30 days, sliding). Schema:
[models/auth-model.sql](models/auth-model.sql) (`users`, `sessions`, `projects`,
`user_project_roles`, `password_resets`, `login_attempts`). The admin account
self-bootstraps: a Google login matching `ADMIN_EMAIL` in `.env` gets `is_admin = 1`.

[config/auth.php](config/auth.php) is the **single shared auth include**. Do NOT
copy-paste auth checks the way other controller helpers are copied, a drifted copy is a
security bug. Gates, each denying with a JSON 401/403 and exiting:

```php
Auth::requireLogin();
Auth::requireAdmin();
Auth::requireProjectRole($key, $role);   // site admins implicitly pass all project checks
```

**Wiring a view in:** register the project (from the admin dashboard, or a seed `INSERT`
into `projects`), then gate the controller with two lines,
`require_once __DIR__ . '/../config/auth.php';` and the gate call. Role names are
free-form per project (`editor`, `viewer`, `player`).

**Four backend shapes**, pick by audience:

| Shape | Reads | Writes | Reference |
|---|---|---|---|
| Public catalog, role-gated writes | public | `requireProjectRole` | `images-controller.php` |
| Read-only demo + per-user rows | public (viewer's own, else the owner's as a demo) | `requireLogin()` scoped `AND user_id = ?` | `plants-controller.php` ([views/botaniq](../views/botaniq/)) |
| Public catalog + login-gated own rows | public, listing everyone's rows | `requireLogin()` scoped `AND user_id = ?` | `recipes-controller.php` |
| Private audience | `requireProjectRole` | `requireProjectRole` | `stocks-controller.php` |

The demo shape's helpers are duplicated per controller (`showcaseUserId()` = first active
admin, `shelfUserId()` = viewer or showcase); every write query carries `AND user_id = ?`.
Other users of it: `sourdough-controller.php`, `jeger-controller.php`,
`workout-controller.php`. When a feature needs per-user visibility of *individual rows*,
layer a `<feature>_<resource>_access` ACL table on top of the project gate; that pattern
is documented in [views/admin/CLAUDE.md](../views/admin/CLAUDE.md).

**Soft delete** (`deleted_at DATETIME NULL`, every read filtering `deleted_at IS NULL`) is
the convention where analytics history must survive deletion. Precedent:
`workout-controller.php`.

On the frontend, a whole-page-gated view turns a 401/403 into a "please sign in" / "no
access yet" state via `gatedFetch()`. A demo-shaped view instead loads data for everyone,
shows a sign-in button plus a read-only banner when the payload says `demo: true`, and
greys its action controls.

**Gotchas:** cookie-authed controllers must NOT send `Access-Control-Allow-Origin: *`
(invalid with credentials and dangerous; all consumers are same-origin). Auth/admin
responses send `Cache-Control: no-store`. The session cookie's `Secure` flag comes from
`!$DEV_MODE`, so prod must be https. Password resets are admin-driven only (the dashboard
generates a one-time link, delivered manually); there is no email sending anywhere.
