# views/compass

Strictly personal self-development tracker built on Dr. Robert Glover's book "No More Mr.
Nice Guy". Unlisted private tool: never register it in `components/project-data.js`,
`index.html`, or the navbar.

Four parts: six daily practices logged as **one check-in row per local day**, a catch log
of the book's eight Nice Guy patterns, the 46 Breaking Free exercises as a status-tracked
workbook, and a progress tab (streak, day wall, per-practice rates).

## Authorization: single owner, not per-user

[app/controllers/compass-controller.php](../../app/controllers/compass-controller.php) is
gated by `Auth::requireAdmin()` on **EVERY** branch, **reads included**. This is not the
usual demo shape: there is one owner, so rows carry no `user_id` column at all. If you
add an endpoint here, gate it the same way, a public read would expose the owner's
personal log.

Schema: [app/models/compass-model.sql](../../app/models/compass-model.sql).

## logic.js

The DOM-free brain (practice/pattern/activity data, day keys, streaks, windows) is
[logic.js](logic.js), tested by
[tests/compass-logic.test.mjs](../../tests/compass-logic.test.mjs).

Day keys come from **local** time, not `new Date().toISOString().slice(0, 10)`: the UTC
form is a day behind for the first hours of every CET/CEST morning, which would file an
early-morning check-in under yesterday and break the streak.

Controller behaviour is pinned by
[tests/compass-controller.test.php](../../tests/compass-controller.test.php).
