# Bearing

A co-op radio-telemetry game for two. **Read [../spy/CLAUDE.md](../spy/CLAUDE.md)
first**: the event-log-plus-polling transport, the outbox, the cursor protocol and
the reasoning behind all of it are documented there and are not repeated here.
[../seam/CLAUDE.md](../seam/CLAUDE.md) covers the server-owns-the-world posture.

## What this one adds

**The co-op is structural, not thematic.** A bearing is a direction with no
distance, so one station's reading is a line across the plate and nothing more.
Only two bearings crossed from two *different* places give a position. There is
no version of this game one person can play, and that is geometry rather than a
rule, so no clever player can design around it.

**Lockstep, not turns.** A cycle resolves only when both seats have committed for
it, so there is no clock anywhere and nobody ever loses because they were slow.
The resolver is elected by `rowCount()` on a cycle-guarded UPDATE, so two pollers
landing in the same second cannot both advance the night. `pollRoom()` re-checks
the invariant every few seconds, because a commit that died after writing must
not strand the pair.

## The authority line, and the one hole that is deliberate

The server owns the valley, the animals and their movement, all derived from
`bearing_rooms.seed`. **An animal's position is a secret** and is published only
in the dawn report.

A sweep, though, hands back the whole 360-sample trace, and the true bearing is
the peak of it. That looks like a leak and is not. Reading the trace *is* the
game; reading it perfectly by script would only be cheating if there were an
opponent, and there is not. Both seats want the same outcome, so the trace goes
over honestly and the skill stays where it belongs. What never goes over is
distance, which is the thing the pair has to earn by crossing two bearings.

## Bracketing, and why the peak is the wrong thing to read

The top of the lobe is flat, so eyeballing its centre is imprecise no matter how
carefully you look. The flanks are steep, so the two angles where the trace
crosses a chosen level are sharply located and their midpoint is a much better
bearing. That gate is the instrument's one setting and it has a real optimum
around half power, which is the actual -3 dB point operators use.

`tests/bearing-logic.test.mjs` holds the curve: bracketing at half power must beat
naive peak-reading by 2x, and a badly set gate must be *worse* than not
bracketing at all. If either stops being true the instrument has stopped being a
skill and is back to being a dice roll, which is the whole reason those two tests
exist.

**A trace of pure hiss reports no bearing at all.** `lobePeak` will happily return
the loudest noise sample, so without the SNR gate in `readBearing` the instrument
sets its gate at half of a bump and reports a confident bearing off nothing. On
screen that was an orange ray whipping around the plate. Two tests guard it.

## Things that will bite

- **Constants are mirrored in the controller.** `N`, `CELL_M`, `CYCLES` and the
  noise function exist in both `logic.js` and `bearing-controller.php`. Change
  them in both.
- **`ui.json` is fetched `no-cache`, never `force-cache`.** A stale table is a
  page of key names. A new user-facing string is a row in that file, never a
  literal in the markup.
- **The database getter is `Database::write()`**, not `getWriteConnection()`.
- **Sweeping costs a cycle; bracketing is free.** `commit` takes the cycle
  action, `read` posts a bracketed bearing so your partner's plate shows your
  ray. Do not merge them: bracketing a trace you already hold is reading, not
  sweeping.
- The PHP suite pins **port 8964** and boots with `DB_*` overrides at the local
  scratch DB. Those overrides are what stop a test run writing to production.
