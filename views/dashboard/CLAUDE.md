# views/dashboard (Dashboard launcher)

Installable PWA app launcher, branded **Dashboard**. Unlisted private tool: never
register it in `components/project-data.js`, `index.html`, or the navbar.

Formerly `views/hub`. That directory was deleted outright with no redirect stub, so any
still-installed Hub PWA 404s and must be reinstalled from here.

The manifest `scope` resolves to the **site root**, which is what lets tiles open other
views chrome-free inside the standalone window. Don't narrow it to this directory.

Backend [app/controllers/dashboard-controller.php](../../app/controllers/dashboard-controller.php),
schema [app/models/dashboard-model.sql](../../app/models/dashboard-model.sql)
(`dashboard_apps`, `dashboard_user_apps`, `dashboard_folders`).

## The shelf is personal in two senses

**1. Each user picks their own tiles** in the picker overlay (`?manage=1` list,
POST/DELETE `?shelf=1`), limited to what they are permitted to see via the projects
registry: a NULL project means any signed-in user, otherwise they need a role in the
tile's project. Admins may pick anything but still curate their own shelf. A row that is
picked but not (or no longer) permitted lies **dormant**: kept, not shown.

**2. Each user arranges their own shelf.** "Arrange" mode (also entered by a touch
long-press) turns the grid into a drag surface: tiles reorder, a "New folder" tile
creates a one-level-deep personal folder (named inline), and dropping a tile on a folder
files it. Drag a tile out past an open folder's edge to remove it. A folder left empty on
exit auto-dissolves, **unless it still holds dormant rows**.

That layout lives in `dashboard_folders` (per user, one level) plus `folder_id` /
`position` on `dashboard_user_apps`, saved as one debounced `PUT ?layout=1` carrying the
whole arrangement. The response echoes a `created` map so client-side temp folder ids
reconcile to real ids.

`dashboard_apps.sort_order` is admin-controlled and demoted to **catalog order only**: it
orders the picker and decides where a freshly picked tile first lands. The per-user
layout always wins on the shelf.

## Where the logic lives

The DOM-free brain (normalize, reorder, file, eject, dissolve, the save payload, drag
geometry) is [logic.js](logic.js), tested by
[tests/dashboard-logic.test.mjs](../../tests/dashboard-logic.test.mjs). Controller
behaviour is pinned by
[tests/dashboard-controller.test.php](../../tests/dashboard-controller.test.php).

## Admin side

Tiles are managed from the `#dashboard` tab of [views/admin](../admin/) (see
[views/admin/CLAUDE.md](../admin/CLAUDE.md)). Tiles marked `is_default` there are seeded
onto every **new** user's shelf at signup by
[app/services/dashboard-shelf-service.php](../../app/services/dashboard-shelf-service.php).
Existing users are never backfilled.
