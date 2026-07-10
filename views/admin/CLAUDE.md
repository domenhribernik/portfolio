# CLAUDE.md (views/admin)

Admin dashboard of the auth system, backed by [app/controllers/admin-controller.php](../../app/controllers/admin-controller.php) (resources: `users`, `projects`, `roles`, `resets`, `sessions`; every endpoint is admin-only). This file also documents the site's authorization pattern, because this dashboard is where the coarse half of it is managed.

## Dashboard frontend

- The dashboard is split into three hash-routed tabs (`#users`, `#projects`, `#hub`) so the page never grows into one long scroll; `script.js` is an ES module.
- DOM-free decision logic (tab routing, list filters, hub form payload, tile reorder plan) lives in [logic.js](logic.js), unit-tested by [tests/admin-logic.test.mjs](../../tests/admin-logic.test.mjs) via `node --test tests/`. Put new pure logic there, test-first, rather than inline in script.js. Use the `.js` extension for browser-imported modules, never `.mjs`: Apache has no MIME mapping for `.mjs` and module scripts get blocked (the root package.json's `"type": "module"` is what lets node parse these `.js` files as ESM).
- Tile reordering (the up/down buttons) is disabled while the tile filter is active, because reorder indices refer to the full list.
- Visual language: the editorial paper theme shared with `views/account` (paper/ink/clay palette, Fraunces + IBM Plex Sans + Space Mono), matching the homepage's light editorial theme, with the "Control Room" / "Access Terminal" voice kept on purpose. Component classes live in each view's own style.css because the Tailwind CDN cannot `@apply` in linked stylesheets.
- Hub tile visibility semantics are pinned by [tests/hub-controller.test.php](../../tests/hub-controller.test.php); run it after touching `hub-controller.php` (see the root CLAUDE.md "Testing" section).

## Authorization pattern: RBAC for membership, ACL for rows

Access control is layered. Both layers are enforced server-side in controllers, and site admins implicitly pass both (see `Auth::hasProjectRole`).

**Layer 1, app membership (role-based access control).** The `projects` + `user_project_roles` tables from [auth-model.sql](../../app/models/auth-model.sql) answer "may this user use this feature at all". A controller opts in with a single gate at the top:

```php
require_once __DIR__ . '/../config/auth.php';
$user = Auth::requireProjectRole('<project_key>');            // any role
$user = Auth::requireProjectRole('<project_key>', 'editor');  // exact role
```

Roles are granted from this dashboard. Use this layer alone when the whole feature has one audience (everyone with access sees the same data). Precedents: `images-controller.php` (public GETs, role-gated writes), hub tiles (`hub_apps.project_id` decides tile visibility).

**Layer 2, row-level access (access control list).** When different users must see different rows of the same table (one list for family, another for friends), add a per-feature ACL join table. Naming convention: `<feature>_<resource>_access`.

```sql
CREATE TABLE IF NOT EXISTS <feature>_<resource>_access (
    id INT AUTO_INCREMENT PRIMARY KEY,
    <resource>_id INT NOT NULL,
    user_id INT NOT NULL,
    granted_by INT DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_resource_user (<resource>_id, user_id),
    INDEX idx_user (user_id),
    CONSTRAINT ... FOREIGN KEY (<resource>_id) REFERENCES <resource_table>(id) ON DELETE CASCADE,
    CONSTRAINT ... FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT ... FOREIGN KEY (granted_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

Do NOT store row grants in `user_project_roles.permissions` JSON: it cannot be joined or indexed, so every list query would degrade into PHP-side filtering. The JSON column is only for small per-user feature flags.

First integration of the full pattern: the list view (`list_collection_access` in [list-model.sql](../../app/models/list-model.sql), enforced by [list-controller.php](../../app/controllers/list-controller.php), managed from an admin-only sheet inside `views/list` itself).

## Recipe: wiring row-level access into a view

1. **Model:** seed a `projects` row and create the ACL table in `app/models/<feature>-model.sql` (run manually via phpMyAdmin, like all SQL).
2. **Gate every endpoint** with `Auth::requireProjectRole('<project_key>')`. The ACL refines the audience; it never replaces the membership gate.
3. **Filter reads** with a JOIN or EXISTS against the ACL table for non-admins; admins skip the filter and see everything.
4. **Check the grant before every row mutation.** Resolve the row's parent resource first (e.g. item id to collection), then verify access. Never trust a client-sent resource name alone on writes to other rows.
5. **Grant management endpoints** live in the feature's own controller (list users with a `granted` flag, grant, revoke), each behind `Auth::requireAdmin()`. Granting row access also auto-inserts a `member` role in the feature's project (with `ON DUPLICATE KEY UPDATE role = role`, so an existing better role is never downgraded). This keeps the admin flow one-stop: one toggle both admits the user and shows them the row.
6. **In-app manage UI:** an admin-only control inside the view itself (the list header button opens a bottom sheet: pick a collection, toggle users). The dashboard here stays generic; per-resource grants are managed where the resource lives.
7. **Creator auto-grant:** when a non-admin creates a resource, insert their own ACL row in the same request, otherwise they create things they cannot see.

## Frontend contract for gated views

- Cookie-authed controllers must send `Cache-Control: no-store` and must NOT send `Access-Control-Allow-Origin` (see root CLAUDE.md gotchas).
- Use [components/auth-gate.js](../../components/auth-gate.js)'s `gatedFetch()` on the view's own boot-time fetch instead of hand-rolling the branching: 401 -> render a sign-in gate linking to `loginUrl()` (`../account/?redirect=<path>`), 403 -> render a "no access yet" gate. The gate's markup and styling are the view's own (see root CLAUDE.md styling rules), only this classification logic and the redirect URL are shared. No current consumer (`views/botaniq` moved to a public read-only demo with per-user rows and now uses only `loginUrl()`); the helper stays for the next whole-page-gated view.
- Reveal admin-only UI only when `me.user.is_admin` is true (the server re-checks anyway; the flag is cosmetic).
- Handle 401 on background polls by showing the signed-out gate, sessions expire.
