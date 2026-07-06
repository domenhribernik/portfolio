# views/workout

Per-user workout tracker in the **read-only demo plus per-user rows** shape
(see root CLAUDE.md, "Authentication and Permissions"). Backend:
`app/controllers/workout-controller.php`, schema `app/models/workout-model.sql`,
tested by `tests/workout-controller.test.php` (integration) and
`tests/workout-logic.test.mjs` (unit tests for `logic.js`).

## Screen map

Single `index.html`, hash-routed screens (`.screen` + `.active`):
- `#/` workout list, `#/play/<id>` player, `#/history` session log, `#/library`
  exercise library. Workout editor and exercise form are modals.
- `script.js` is an ES module (imports `loginUrl` from `components/auth-gate.js`
  and everything testable from `logic.js`); `back-link.js` stays a plain script.
- All interaction is delegated through `data-action` attributes; there are no
  inline onclick handlers (module scope would not expose them anyway).

## Data model contracts (invariants the UI and controller both rely on)

- **Exercise `type` is immutable** after creation (`reps`, `weighted`, `time`,
  `distance`). The controller rejects type changes with 400; the edit modal
  disables the select. To change a type, soft-delete and create a new exercise.
- **Soft delete** (`deleted_at`) applies to `workouts` and `workout_exercises`
  only. Every controller read filters `deleted_at IS NULL` and the
  `fetchOwn*` helpers 404 on soft-deleted rows. Sessions are hard-deleted on
  request (reset mid-run, removing a history row).
- **`workout_items` are rewritten wholesale on every save** (recipes pattern),
  so item ids are unstable: nothing may reference them. Session sets key on
  `(session_id, exercise_id, round_number)` with a UNIQUE constraint, which
  makes `action=log` an idempotent upsert.
- An exercise **cannot be soft-deleted while a non-deleted workout uses it**
  (400); the library UI disables the button using `used_by_workouts`.
- `workout_sessions` **snapshots `workout_name` and `rounds`** at start so
  history stays truthful after edits. Rounds are workout-level: one round =
  every item once, in `position` order.

## Session lifecycle (player)

- No session row exists until the first done-toggle: the player lazily POSTs
  `?resource=sessions` then logs each toggle (`action=log` / `unlog`).
- On load the player probes `?resource=sessions&open=1&workout_id=N` and
  resumes the newest unfinished session started within 12 h (using the
  session's snapshot rounds, not the workout's current rounds).
- `action=finish` stamps `finished_at` and 400s on an empty session; Reset
  DELETEs the open session outright.
- **Demo mode runs the player entirely in memory** (no session fetches);
  create/edit/delete stay locked. On a mid-run 401 the player does NOT reload
  (that would wipe the run): it flips to local-only mode and toasts.

## Styling

Iron-and-chalk theme: Tailwind CDN with custom colors (`iron`, `plate`,
`seam`, `chalk`, `steel`, `ember`) and the Big Shoulders Display/Text fonts.
`style.css` holds only the grain overlay, hazard-stripe progress, keyframes
(`stamp`, `rise-in`, `count-pulse`, `hazard-slide`) and JS-toggled state
classes, per the root styling rules.
