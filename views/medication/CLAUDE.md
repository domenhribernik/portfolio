# views/medication

Private medication tracker. Unlisted private tool: never register it in
`components/project-data.js`, `index.html`, or the navbar.

Two tabs. **Today** lists what is scheduled for the day as tappable dose notches;
**Medications** is the shelf, with an inline add/edit form. Installable as a PWA
(`manifest.json` + a three-line `sw.js` that caches nothing on purpose, since a stale
medication log is worse than no log).

## Authorization: single owner, not per-user

[app/controllers/medication-controller.php](../../app/controllers/medication-controller.php)
is gated by `Auth::requireAdmin()` on **EVERY** branch, reads included. There is one
owner, so rows carry no `user_id` column at all. If you add an endpoint here, gate it the
same way: a public read would expose a personal medical record.

The `projects` row seeded by
[medication-model.sql](../../app/models/medication-model.sql) exists **only** so the
Dashboard launcher tile can be gated on it. A `dashboard_apps` row with a NULL
`project_id` is offered to every signed-in user, which is backwards here. Admins pass
project checks implicitly, so the two gates agree. Do not grant anyone a role.

## `ends_on` and `deleted_at` are not the same verb

`ends_on` finishes a course: the medication drops off Today from that date and **keeps**
its history. `deleted_at` removes it from every view, history included. That asymmetry is
deliberate, and it is what stops a day's `taken` count from outrunning its `planned`
count: both sides of the ledger are computed from the same non-deleted, active-on-that-day
set. Reads filter `deleted_at IS NULL` on **both** tables, via the join in `getState()`.

## The notch counter

The schedule is a count ("three times a day"), not clock times, so slots are
interchangeable. A row is therefore drawn as a **counter**: notch `i` is lit iff
`i < the number taken`. Tapping an empty notch takes the lowest free slot and tapping a
lit one releases the highest, so the display can never show a gap and quietly repairs one
left by an edited schedule. `medication_doses` holds a row **iff** that slot was taken;
there is no boolean, and un-taking is a `DELETE`.

Dose writes are `PUT ?resource=dose`, idempotent by construction (the unique key absorbs a
repeat take, a repeat release is a no-op). That is what lets `script.js` flip the notch
optimistically before the request lands.

## logic.js

The DOM-free brain (forms, dates, the notch pair, day progress, the history strip,
streaks, validation) is [logic.js](logic.js), tested by
[tests/medication-logic.test.mjs](../../tests/medication-logic.test.mjs). `script.js` only
wires it to the DOM.

Day keys come from **local** time, not `new Date().toISOString().slice(0, 10)`: the UTC
form is a day behind for the first hours of every CET/CEST morning, which would file an
early-morning dose under yesterday and break the streak.

`isActiveOn()` falls back to `created_on` when `starts_on` is unset. Without that the
14-day wall reports missed doses for every day before the medication existed, and a fresh
shelf can never build a streak.

`validateMed()` here and `validateMed()` in the controller enforce the same rules. The
client copy is a courtesy so the form fails fast; the server copy is the gate. Edit both.

Controller behaviour is pinned by
[tests/medication-controller.test.php](../../tests/medication-controller.test.php).
