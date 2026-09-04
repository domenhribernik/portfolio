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

## The loop, and why it is shaped like this

The first version of this game was **"reduce your measurement error"**: animals
random-walked, fixes were graded against the truth, and the night's score was how
many came out tight. It tested cleanly and nobody wanted to replay it. Nothing
was anticipated, nothing pushed back, and three fixes in a row meant three
separate numbers rather than one picture.

The rework makes a fix **evidence rather than an answer**:

1. Each collar is dealt a hidden **behaviour profile** (`ridge`, `den`, `water`,
   `flight`) at seed time. It never leaves the server before dawn.
2. Fixes joined in cycle order draw a **track**, and a profile is a legible
   *shape* if and only if the fixes are tight. That is what buys bracketing its
   place in the game.
3. Read the shape, predict where she goes, and **call an intercept**: a cell and
   a future cycle. It scores only when the partner seconds it and one of you is
   standing within `INTERCEPT_RADIUS` when the night gets there.
4. Dawn draws her real track over the one the pair reconstructed and names the
   shape.

Both players can talk freely, usually in the same room, so hidden information
cannot be the engine: anything on one screen is read aloud in four seconds. The
engine is a hidden *behaviour* they deduce together, plus a decision that stays
hard with perfect communication (gather more, or start walking now).

## The authority line, and the one hole that is deliberate

The server owns the valley, the animals and their movement, all derived from
`bearing_rooms.seed`. **An animal's position, profile, den cell and track are
secrets** published only in the dawn report.

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
bracketing at all. `tests/bearing-sim.test.php` then holds the *consequence*: a
night played with half-power brackets lands measurably more intercepts than the
same night played by eyeballing the peak. If that second gap ever closes, the
instrument has stopped feeding the game and bracketing is decoration.

**A trace of pure hiss reports no bearing at all.** `lobePeak` will happily return
the loudest noise sample, so without the SNR gate in `readBearing` the instrument
sets its gate at half of a bump and reports a confident bearing off nothing. On
screen that was an orange ray whipping around the plate. Two tests guard it.

## Where the code lives

| File | What |
|---|---|
| `app/controllers/bearing/valley.php` | Terrain, line of sight, the sweep trace, weather. Pure |
| `app/controllers/bearing/movement.php` | The four profiles, the track features, the classifier. Pure |
| `app/controllers/bearing-controller.php` | Rooms, the lockstep, the intercept. Everything with a database in it |

The two modules under `bearing/` have **no side effects on include**, which is
what lets `tests/bearing-sim.test.php` run the physics thousands of times with no
server and no database. Keep it that way: a `header()` or a `Database::` call in
either of them silently costs the balance suite.

`N` and `CELL_M` live in `valley.php`, not the controller. `MOVE_MAX`, `CYCLES`,
`INTERCEPT_RADIUS`, `CONTACT_M` and `NEAR_M` live in the controller. Both sets are
mirrored in `logic.js` and greped by the JS suite.

## Things that will bite

- **The profile prototypes are measured, not chosen.** `PROTOTYPE` in
  `movement.php` holds class means and deviations taken off four hundred seeds.
  Change how an animal moves and they are stale, which the sim suite will say so
  in numbers. Re-measure rather than nudging them until it passes.
- **A room opens in `lobby`, not in a night.** `create` seats one player and
  stops; the second seat is what flips the room to `night`, with nothing to
  press. The view has a `#/lobby` screen for that gap, and **two** places route
  by room status: `seat()` reads the status out of the create/join response
  (there is no poll yet at that moment) and `absorb()` reads it out of every
  poll. A new status has to be handled in both. Sending the host straight to
  `#/night` on create, which is what the first build did, left them on a plate
  with one station and a cycle that could never resolve.
- **`ui.json` is fetched `no-cache`, never `force-cache`.** A stale table is a
  page of key names. A new user-facing string is a row in that file, never a
  literal in the markup.
- **The database getter is `Database::write()`**, not `getWriteConnection()`.
- **Sweeping costs a cycle; bracketing, posting, hunches and calls do not.**
  `commit` takes the cycle action; `read` posts a bracketed bearing, `note`
  toggles a hypothesis chip, `intercept` proposes or seconds a call. Do not fold
  the free ones into the lockstep: an intercept is paid for in *walking*, which
  is legible on the plate, and taxing it a cycle as well charges twice for one
  decision.
- **A ray expires after `RAY_LIFE` cycles.** Every bearing ever posted, drawn at
  full strength with its wedge, buried the plate in white by mid-night and hid
  the track. The track is the permanent record; a bearing is working material.
- The PHP suites pin **port 8964** and boot with `DB_*` overrides at the local
  scratch DB. Those overrides are what stop a test run writing to production.
