# SEAM (views/seam)

Connect four on a board that eats its own floor. Three ways in, one section:

- **local** (`mode = 'local'`): pass-the-plate, two people on one device.
- **solo** (`mode = 'solo'`): the alpha-beta bot in [logic.js](logic.js).
- **room** (`mode = 'room'`): a plate each over a four-letter code, built on the
  parlour's multiplayer base. See [../parlour/CLAUDE.md](../parlour/CLAUDE.md)
  for the polling rationale, the event-log cursor and the outbox contract,
  none of which is repeated here.

`showScreen(id)` takes a raw element id and toggles `.is-open`. Spy's takes an
id and toggles `.active`, the parlour's takes a logical name and toggles `.on`.
Do not mix the three.

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

The parlour's server guards state but never computes it, because a stroke is
public and harmless. Spy's server owns the *deal*, because a role is a secret.
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

## The animation

One orchestrated gesture, in `paintSection(state, edge)`:

hold the core above the rim (`holdCore`, `HOLD_MS`) &rarr; the fault rips
across the trench and the section settles a bed (`CAVE_MS`) &rarr; the held
core drops into the freed surface (`dropIn`).

- `--cell` is measured from the rendered grid by `measureCell()` and every
  translate is expressed in it. Re-measure after any layout change.
- `painting` locks the plate for the duration. A poll landing mid-animation
  sets `painted = null` so the next paint snaps to truth rather than fighting.
- Events give the **edge** worth animating, the snapshot gives the **truth**.
  More than one `move` op in a page (a phone coming back from the background)
  deliberately snaps instead of animating.

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
- **A flex title block swallows its own `::after` rule.** `body.is-playing
  .titleblock` is a flex row, so the double-rule pseudo-element becomes a flex
  item and shoves the metadata off the paper. It is `flex: 1 0 100%` for that
  reason.
- **`join` starts the match**, in the same transaction that seats the second
  player, with the room row locked. There is no host tap between a shared link
  and a live section; that is the one place this diverges from spy.
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
- **A new user-facing string is a row in `i18n/ui.json`, never a literal**,
  and the controller reads the same file. `tests/seam-i18n.test.mjs` fails on a
  half-filled language and on any `refuse.*` code the controller can send
  without a matching row.

Accepted limits, inherited from the base: no rate limit on `create`/`join`
beyond the caps, 160k guessable codes, no join once a match is under way
(the seat picker covers a phone that lost its session), and no per-turn clock.
