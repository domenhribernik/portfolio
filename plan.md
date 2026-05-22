# Sourdough Tracker — Plan v2 (changes only)

Three additions to what's already built. No new files; edits only to the model, controller, and the `views/sourdough` view.

---

## 1. Take the starter OUT of the fridge

Right now the starter has only **Fed** and **Put in fridge**. Add a third action so it can come back to the counter without resetting the feed timer.

- **Controller** — new action `?resource=starter&action=unfridge`: sets `in_fridge = 0`, leaves `last_fed_at` untouched.
- **Frontend** — when `in_fridge = 1`, the starter card swaps the "Put in fridge" button for **"Take out of fridge"**. **Fed** is always visible.
- No SQL change.

## 2. "Go back" on bread phases

Every forward transition becomes reversible — a misclick on "Into fridge" or "Lid off" shouldn't trap the loaf in a wrong phase.

- **Controller** — new action `?resource=bread&id=N&action=back`. Walks one step backward in `PHASE_ORDER` and `NULL`s the timestamp of the phase being *left* (not the destination's). Refuses when already at `bulk_fermentation`.
  - `bake_lid` → back → `cold_proof`, sets `bake_lid_at = NULL`. The original `cold_proof_at` stays, so the cold-proof timer resumes where it was.
  - `finished` → back → `bake_no_lid`, sets `finished_at = NULL`. (No phase is permanent.)
  - Folds and `folds_done_at` are preserved when stepping back into `bulk_fermentation`.
  - Re-advancing forward stamps the new phase with a fresh `NOW()`. So if the user wants a clean timer reset they can deliberately back-then-forward.
- **Frontend** — small **↶ back** icon button in the card header next to the phase stamp on every card except those in `bulk_fermentation`. On `finished` cards it sits next to "forget this loaf". When backing out of a phase, the client clears that phase's bell-fired keys so re-entering can ring again.

## 3. New phase: `bench_rest` — out of the fridge, waiting to bake

Take-out and bake aren't the same moment. The user might score, finish preheating, walk away. Insert a new phase between `cold_proof` and `bake_lid` with no fixed timer — just elapsed time.

- **SQL** — you run this manually in phpMyAdmin (per CLAUDE.md):
  ```sql
  ALTER TABLE sourdough_breads
      MODIFY COLUMN phase ENUM('bulk_fermentation','cold_proof','bench_rest','bake_lid','bake_no_lid','finished') NOT NULL DEFAULT 'bulk_fermentation',
      ADD COLUMN bench_rest_at DATETIME DEFAULT NULL AFTER cold_proof_at;
  ```
  I also update `app/models/sourdough-model.sql` so a fresh install matches.
- **Controller**:
  - `PHASE_ORDER` becomes `['bulk_fermentation','cold_proof','bench_rest','bake_lid','bake_no_lid','finished']`.
  - `match` in `advanceBread` gets `'bench_rest' => 'bench_rest_at'`.
  - SELECT lists in `listBreads`/`getBread` add the new `bench_rest_at` column.
- **Frontend**:
  - New stamp class `stamp-bench` — warm earthy tone, visually between cold-proof (blue) and bake (red).
  - Phase body shows: "Out of the fridge for [elapsed]" + small hint "Score, preheat the rest of the way, take your time" + button **🔥 INTO THE OVEN** (advances → `bake_lid`).
  - The button on `cold_proof` is relabeled from "OUT & INTO OVEN" to **"OUT OF FRIDGE"** (it now advances → `bench_rest`, not → `bake_lid`).
  - Live timer for `bench_rest` added to the `tick()` loop.

---

## Build order

1. SQL `ALTER` (you run it) + update `app/models/sourdough-model.sql`.
2. Controller: add `unfridge` for starter, `back` for bread, extend `PHASE_ORDER` + the `match`, include `bench_rest_at` in SELECTs.
3. Frontend: starter button swap, per-card back button, `bench_rest` phase body/stamp/timer, copy tweak on `cold_proof` button.
