# SEAM (views/seam)

Connect four on a board that eats its own floor. Three ways in, one section:

- **local** (`mode = 'local'`): pass-the-plate, two people on one device.
- **solo** (`mode = 'solo'`): the alpha-beta bot in [logic.js](logic.js).
- **room** (`mode = 'room'`): a plate each over a four-letter code, built on the
  repo's multiplayer base. See [../spy/CLAUDE.md](../spy/CLAUDE.md) for the
  polling rationale, the event-log cursor and the outbox contract, none of
  which is repeated here.

The boot screen offers both room doors: `doorRoom` opens a section, `doorJoin`
opens the same gate with the code field shown. Joining used to be reachable
only by following a shared link, which left two people in one room with a code
read aloud and nowhere to type it.

`showScreen(id)` takes a raw element id and toggles `.is-open`. Spy's takes an
id and toggles `.active`. Do not mix the two.

## The section, and why the twist is one line

The board is a **42-character string, row-major, ROW 0 IS THE SURFACE** and row
5 the basement. That encoding exists for exactly one reason:

```js
cave(board) === '.'.repeat(COLS) + board.slice(0, COLS * (ROWS - 1))
```

Cut the basement bed, everything settles one bed down. Any other orientation
turns that into a loop. `caveBoard()` in the controller is the same line in
PHP, and `tests/seam-logic.test.mjs` greps the PHP for it.

## The authority inversion

A shared-canvas server can guard state without ever computing it, because a
stroke is public and harmless. Spy's server owns the *deal*, because a role is
a secret.
**Here the server owns the whole board**, because the board is the game: a
client that could send its own would forge a cave or claim a seam.

- A move request carries a shaft number. **Everything else in the body is
  ignored**, and `tests/seam-controller.test.php` section 5 posts a forged
  board, permit count, turn, move count and outcome to prove it.
- `applyMove()` / `moveError()` / `findSeam()` exist in **both**
  [logic.js](logic.js) and `seam-controller.php`. The browser needs them to
  grey out a dead shaft and to run the bot; the controller needs them because
  it is the only thing allowed to decide what happened. Change them in both.
- `COLS`, `ROWS` and `CHARGES` are duplicated the same way, and the constants
  test in `tests/seam-logic.test.mjs` is what turns "change them in both" from
  a comment into a guarantee.

## Only the seat that just cut can ever strike

A cave translates every surviving core by the same vector, so it cannot line
four up for anyone. The only new piece is the mover's own. Therefore:

- **a cave can never hand the opponent the win**, and
- **the both-seats-struck draw is unreachable in play**.

That branch is still written, in both languages, because the server must never
depend on that reasoning being right. The property test
(`random play always settles...`) pins the invariant across 400 games, and the
PHP suite re-derives every frozen verdict from the section it was struck in.

The practical consequence, worth knowing before anyone "fixes" it: drawing the
bottom carries **no immediate risk**, only positional and resource cost. It
destroys your own basement cores too, it spends a scarce permit, and it can
open the section for the other seat. If the cave ever needs real teeth, the
rule to change is the whole-row cave, not this branch.

## The anti-spam rule, and why the game always ends

A full shaft is playable only by **drawing the bottom**, which costs one of
`CHARGES` permits and may never happen on two of a seat's own cuts running.
Both halves are in `moveError()`.

That bounds the game: at most `2 * CHARGES` caves, so at most `2 * CHARGES *
COLS` beds ever removed, so at most `COLS * ROWS + 2 * CHARGES * COLS` cuts
before the section is permanently full with no permits left, which is a
stalemate draw. Spending permits early genuinely costs you the endgame.

## Block caving, and the readout that must NOT renumber

The plate is a block-cave working, and that fiction is load-bearing:

- **The drawpoint does not move**, so the depth scale is fixed at 5..30 m. An
  earlier version renumbered it on every cave, which told the exact opposite
  story to the one the cores tell as they settle. If the rock falls, the scale
  holds.
- **The overburden caves in behind the drawn bed**, so `.beds__bands` carries
  one extra band resting a bed above the window (`translateY(-1 cell)`) and
  slides to `translateY(0)` during the animation. That is why there are
  `ROWS + 1` bands and not `ROWS`.
- What grows instead is `DRAWN {n} M` in the title block, derived as
  `caveCount(charges)` from the permits already spent. The server sends no
  cave counter and does not need to.

## The collar, and why the plate has a lane above the datum

`.collar` is 1.2 beds of drawn ground between the shaft heads and the datum.
It is not decoration and it is not spacing:

- Every core is **released at the top of it** and crosses the datum in view,
  which is what gives a drop a cause you can watch. `.stack` carries a
  `clip-path` opened by exactly `--collar` above and `--trench-h` below;
  `overflow` cannot express that, since it clips four sides or none.
- It is where a core **waits during a cave** (`.held`) and where the ghost
  goes when the shaft is full (`.ghost--rim`). Both used to hang above the
  shaft heads, outside the plate, where they collided with the away HUD.
- `--gutter` is shared by `.shafts`, `.collar__gutter` and `.scale`. Three
  rows have to agree about where the depth gutter ends; it was three literals.

## The cave, in three beats

`caveIn()`, and the beat structure is the point:

1. `HOLD_MS` the core waits in its collar, `board.drawing` on the status line
2. `CUT_MS` the fault rips and the **basement alone** shears out through the
   floor (`.is-cutting`); nothing above it moves, which is what opens a void
3. `VOID_MS` one beat of empty drawpoint, held, so the hole is actually seen
4. `COLLAPSE_MS` the overburden drops into it and the plate takes the hit
   (`.is-collapsing` + `jolt`)

This used to be one simultaneous move, and a void never appeared: the
basement and the overburden travelled together and the read was "the strata
scrolled" while the bottom row quietly dissolved in place. **Do not merge the
beats back.** `.is-cutting` stays on through beat 4 so the drawn bed keeps
travelling; `.beds` is backed with `--trench` so the void is drawpoint rather
than paper, and `.band--drawn` is the last band, which is the one covering the
basement bed.

## The drop

- **The fresh core is the TOPMOST occupied bed in the shaft** (`topRow`), not
  the lowest. Scanning up from the basement animated the wrong piece on every
  drop after a shaft's first, and after a cave it fell the opponent's core.
- **Fall distance is quoted in beds, never in percentages.** A percentage of a
  core is a fraction of its own 78%-of-a-bed height, so it came up short by a
  different amount on every row and was invisible on the top one.
- One acceleration for every row, so time follows `sqrt(distance)` off
  `FALL_MAX_MS`. The basement is 4.5x as far as the surface and takes 2x as
  long, which is the whole reason the fall reads as gravity.
- **`painting` lifts when the core reaches its bed**, not when the landing
  squash has finished playing. `cut()` refuses everything while the plate
  animates, so every millisecond held past the end of the move is a tap
  silently swallowed.

- `--cell` is measured from the rendered grid by `measureCell()` and every
  translate is expressed in it. Re-measure after any layout change.
- `painting` locks the plate for the duration. A poll landing mid-animation
  sets `painted = null` so the next paint snaps to truth rather than fighting.
- Events give the **edge** worth animating, the snapshot gives the **truth**.
  More than one `move` op in a page (a phone coming back from the background)
  deliberately snaps instead of animating.

## Two hit areas, one control

The numbered heads are 33px tall on a phone, and people reach for the column
they want a core in. `.lanes` lays seven transparent buttons over the grid;
both surfaces call `cut(c)` and both feed `setHot`.

- The lanes are **deliberately not focusable** (`tabindex="-1"`,
  `aria-hidden`). The heads stay the labelled control, so a shaft still has
  exactly one tab stop.
- `setHot` records only **where the pointer is**; `paintHot` decides on every paint
  whether that is worth lighting. A pointer resting on a shaft sends no new
  event when the turn passes or an animation ends, so a hot column latched at
  event time went dark after your own move and stayed dark until you moved the
  mouse.
- On a shaft with room the ghost is the landing bed. On a **full** one it is
  `.ghost--rim`, in the collar, and `.doomed` marks the basement: the plate
  states both ends of the trade rather than drawing a ghost on top of a core
  that is still there.
- **`.doomed` darkens toward the trench, it does not wash in fault red.** The
  five bands roll, so a red marking disappeared entirely on the one cave in
  five where the basement was sitting on the red bed.

## Things that will bite

- **The served controller talks to the production database.** `app/.env`
  points there, so `http://localhost/portfolio/views/seam/` will 500 with
  "Table 'seam_rooms' doesn't exist" until the model SQL is run in phpMyAdmin.
  To drive room mode locally, serve the docroot yourself with the scratch DB:
  ```
  DB_HOST=127.0.0.1 DB_NAME=portfolio DB_USER_W=... DB_PASS_W=... \
  DB_USER_R=... DB_PASS_R=... PHP_CLI_SERVER_WORKERS=8 \
  /opt/lampp/bin/php -d variables_order=EGPCS -S 127.0.0.1:8099 -t .
  ```
  The `variables_order=EGPCS` is what makes `database.php` skip `app/.env`,
  the same guard the PHP suite uses.
- **An SVG given only a width takes its height from its viewBox ratio.**
  `.strike` states both, and lives inside `.stack` so it matches the grid
  exactly. Given only a width it drew every seam below the clipped grid.
- **Never write a dash length as a literal.** `.strike` used
  `stroke-dasharray: 200` with `vector-effect: non-scaling-stroke`, which
  makes the dash 200 **screen pixels**: every diagonal (271px on a phone) and
  every horizontal on a plate wider than a phone (338px) painted 200 pixels of
  line and then stopped in mid-air. The viewBox is now `700 600`, 100 units
  per bed against a grid locked to `7/6`, so the mapping is uniform in both
  axes and stroke widths are quoted in beds; `drawOn()` reads the dash length
  back off the element with `getTotalLength()`.
- **The seam is a band the cores sit ON, not a line struck THROUGH them.**
  `.strike` sits before `.grid` in the markup for that reason. A stroke across
  four centres reads as a row being cancelled, which is the opposite of
  finding something.
- **Losing cores are drained with a `filter`, never faded with `opacity`.**
  A translucent core lets the band behind it through and the two mix into a
  colour belonging to neither seat: azurite over the olivine bed came out
  teal. The same rule governs `.ghost`, which is opaque linen under a veil of
  the seat's ink.
- **A finished fall still pins its core's transform.** `coreFall` fills `both`
  and `core--fresh` is never removed by the paint, so the filled animation
  keeps winning over the plain declaration in `.stack.is-collapsing .core` and
  the collapse cannot move a single core: the strata travel a bed and every
  core stays where it was until the repaint snaps it into register. `caveIn()`
  clears the class before beat three, which is late enough that no fall or
  landing squash is ever cut short. It cannot be done in `paintCores`, which
  runs after `caveIn()`, nor left to `dropIn()`, which runs after that again.
- **The landing mark is quoted in percentages of the CORE, not of a bed.** The
  core is 78% of a bed, so `bottom: -16%` puts the mark *below* the cell's
  border rather than inside the bed, and on the basement row, whose cells carry
  no bottom border, it lands on the trench's graphite lip and the two read as
  one black bar. Keep it a hairline, inside its own shaft, clear of every rule.
- **`paintCores` reuses a core element whose seat has not changed**, so
  `paintStrike` clears `.core--struck` itself; otherwise a ring struck in one
  section survives into the next.
- **A flex title block swallows its own `::after` rule.** `body.is-playing
  .titleblock` is a flex row, so the double-rule pseudo-element becomes a flex
  item and shoves the metadata off the paper. It is `flex: 1 0 100%` for that
  reason.
- **`join` starts the match**, in the same transaction that seats the second
  player, with the room row locked. There is no host tap between a shared link
  and a live section; that is the one place this diverges from spy. The poll
  re-checks the rule through `startIfSeated()`, so both seats filled always
  ends up dealt even if something else got the room back into the lobby.
- **Anything that counts seats MUST take the room lock first.**
  `reopenIfAbandoned()` counted them without it and lost a race with `join`: the
  joiner holds the room row from its own `FOR UPDATE` until commit, so a poll
  arriving inside that window saw one seat (the INSERT was uncommitted, and
  invisible to a consistent read), decided the section was abandoned, and
  blocked on the UPDATE. `join` then committed `play`, the waiting UPDATE
  re-read the row, matched `status <> 'lobby'` and put it straight back. `deal`
  and `abandon` a second apart, both seats filled, in the lobby, permanently:
  `startMatch()` is reachable only from `join` at the moment the second seat is
  taken and from `again` on a finished section, so nothing could ever deal it.
  Both halves are fixed, and both are pinned by
  `tests/seam-controller.test.php` ("a section stranded in the lobby").
- **A match needs two seats.** Losing one (leaving, or being swept) voids the
  section and `reopenIfAbandoned()` puts the room back in `lobby`, so the
  shared link still works for whoever turns up next.
- **A rematch needs both seats to ask.** `wants_again` is a toggle, so either
  can change their mind; nobody gets the result wiped out while reading it.
- **The verdict is stamped on the plate, not on a screen of its own.** An
  earlier version swapped the board out for a results screen, which hid the
  struck seam at the exact moment it was worth looking at.
- **Bot depth is measured, not guessed.** Full self-play worst case: depth 2 =
  12ms, 4 = 47ms, 5 = 174ms, 6 = 673ms. The search runs on the main thread, so
  `DEPTHS.chief` stops at 5.
- **`i18n/ui.json` is fetched `no-cache`, and must stay that way.** That
  revalidates rather than skipping the cache, so an unchanged table still
  costs a bodyless 304. It shipped as `force-cache`, the exact trade
  `views/spy/CLAUDE.md` documents as wrong: a stale copy is served without
  ever asking, so every row added after a visitor's first load renders as its
  raw key on that device forever.
- **A new user-facing string is a row in `i18n/ui.json`, never a literal**,
  and the controller reads the same file. `tests/seam-i18n.test.mjs` fails on a
  half-filled language and on any `refuse.*` code the controller can send
  without a matching row.

Accepted limits, inherited from the base: no rate limit on `create`/`join`
beyond the caps, 160k guessable codes, no join once a match is under way
(the seat picker covers a phone that lost its session), and no per-turn clock.
