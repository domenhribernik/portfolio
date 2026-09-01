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

**2. Each user arranges their own shelf.** "Arrange" mode turns the grid into a drag
surface: tiles reorder, a "New folder" tile creates a one-level-deep personal folder
(named inline), and dropping a tile on a folder files it. Drag a tile clear of an open
folder's panel to remove it. A folder left empty on exit auto-dissolves, **unless it
still holds dormant rows**.

On touch, a hold both enters arrange mode and picks the tile up in one gesture, so the
finger that held is the finger that drags. See "Touch drag" below.

That layout lives in `dashboard_folders` (per user, one level) plus `folder_id` /
`position` on `dashboard_user_apps`, saved as one debounced `PUT ?layout=1` carrying the
whole arrangement. The response echoes a `created` map so client-side temp folder ids
reconcile to real ids.

`dashboard_apps.sort_order` is admin-controlled and demoted to **catalog order only**: it
orders the picker and decides where a freshly picked tile first lands. The per-user
layout always wins on the shelf.

## Touch drag

Three rules keep this working on a phone. Each was a live bug, and each looks like
harmless tidying from the outside.

**Never rebuild a tile while a press is in flight.** Touch events are dispatched for the
whole gesture against the node that was under the finger at `touchstart`. Destroy it and
the browser stops sending `touchmove`, so the non-passive `preventDefault()` that holds
the gesture never runs, the compositor claims it as a scroll, and `pointercancel` kills
the drag exactly one slot in. So a drag-time reorder **moves** the existing `<li>` nodes
(`reorderShelf` / `reorderFolderTray`), and `enterArrange()` called mid-press only appends
the "New folder" tile. The full `renderShelf()` rebuild is for idle moments. `boot()`
rebuilds unconditionally, so it aborts any live drag first.

**`touch-action` on a tile must stay `pan-y`, and must never be toggled.** Safari latches
it at `touchstart`, so flipping it to `none` when the hold fires does nothing for that
gesture. The shelf is almost entirely tiles, so the browser has to keep vertical panning
or the page cannot scroll at all. What separates a scroll from a drag is the hold in
`logic.js` (450ms cold, 160ms once arranging); a swipe that beats the hold releases the
press back to the page.

**Tiles are `<a href>`, so iOS offers to preview and share them.** That callout fires at
roughly the same moment as the hold and steals the pointer.
`-webkit-touch-callout: none` (plus `user-select: none`, both prefixed) is load-bearing,
not cosmetic. The `contextmenu` handler covers the same thing off iOS.

A stale `data-folder-id` is the other way filing silently breaks: `folderHitTest` reads
the id off the DOM, so `adoptCreatedIds()` has to patch the attribute in place when a
save reconciles a temp folder id. Patch, never re-render, for the reason above.

## Where the logic lives

The DOM-free brain (normalize, reorder, file, eject, dissolve, the save payload, drag
geometry, and the press/move/release gesture reducer) is [logic.js](logic.js), tested by
[tests/dashboard-logic.test.mjs](../../tests/dashboard-logic.test.mjs). Controller
behaviour is pinned by
[tests/dashboard-controller.test.php](../../tests/dashboard-controller.test.php).

## Admin side

Tiles are managed from the `#dashboard` tab of [views/admin](../admin/) (see
[views/admin/CLAUDE.md](../admin/CLAUDE.md)). Tiles marked `is_default` there are seeded
onto every **new** user's shelf at signup by
[app/services/dashboard-shelf-service.php](../../app/services/dashboard-shelf-service.php).
Existing users are never backfilled.
