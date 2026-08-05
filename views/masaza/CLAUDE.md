# views/masaza

Slovenian quick-reference and guided 60-minute timer for the classical full-body massage
routine from the VITAL course. Unlisted private tool: never register it in
`components/project-data.js`, `index.html`, or the navbar.

Two modes:

- **Reference timeline** of the 10 body segments with per-segment technique cues.
- **Guided session**: a drift-free wall-clock timer, segment chimes, a flip callout at
  the 30-minute turn, skip and pause, and a screen wake lock.

"Drift-free" means the timer derives elapsed time from a wall-clock anchor rather than
accumulating `setInterval` ticks, which drift badly over an hour and stall entirely in a
backgrounded tab. Keep it that way.

**No backend.** Pure schedule/session logic in [logic.js](logic.js), tested by
[tests/masaza-logic.test.mjs](../../tests/masaza-logic.test.mjs).
