# views/battleship

Two-seat battleship with a salvage economy and an unlock ladder. Room mode over
an anonymous four-letter code, plus a solo bot. Built on the same base as
[views/spy](../spy/) and [views/seam](../seam/); read
[views/spy/CLAUDE.md](../spy/CLAUDE.md) first for the polling rationale, which is
not repeated here.

## What is different about this game

Spy has secrets and no board. Seam has a board and no secrets. Battleship has
both, so it inherits a rule from each, and the two rules are the whole feature:

1. **The server owns both plots** (seam's rule). A client sends a coordinate.
   It never sends a hit, a sink, a salvage total or an outcome. `postAction()` in
   `battleship-controller.php` reads `kind`, `at`, `dir` and `ship`, and nothing
   else in the body is looked at.
2. **A fleet is a secret** (spy's rule). `fleet`, `decoys` and every sonar
   reading leave the controller in exactly one place: the `you` block of their
   own owner's poll.

`youPayload()` and `enemyPayload()` are the **only** two functions that turn a
seat into JSON. `enemyPayload` is built up from the shot record rather than
filtered down from the row, so a column added to `battleship_players` later
cannot leak by being forgotten in a blacklist. If you add a field there, you are
disclosing it on purpose. `tests/battleship-controller.test.php` section 1 greps
the raw bytes of every payload for the other fleet, during placement, mid battle
and after the verdict.

Sonar readings live in their own table (`battleship_intel`) rather than as a
column or an event. That is structural, not stylistic: a private result cannot
reach the public event log if the public log has nowhere to put it.

## The design, and why it is what it is

The complaint this variant answers is that classic battleship is mostly luck and
that whoever finds a hull first runs away with it. Three rules do the work, and
each of them replaced something that measurably did not:

- **No "a hit buys another shot".** That variant is the snowball itself. Accuracy
  is paid in salvage instead of in free turns.
- **Area fire neither refuels nor surveys.** A barrage or a charge pays the fleet
  it lands on and pays the gunner nothing, and the water it churns is *not*
  plotted as missed. The second half is the load-bearing one: the bottleneck in
  battleship is the search, not the damage, so a weapon that cleared nine cells
  of the search for one turn was a pure rate multiplier. Before this,
  `tests/battleship-balance.test.mjs` had a depth-charge policy taking 83% of its
  games against a plain gunner.
- **The heavy tools are gated on YOUR OWN wrecks, not bought with a lead.**
  `UNLOCK` in `logic.js`. This is the comeback engine and the salvage economy is
  not: paying the losing side more currency turned out to be worthless, because
  both sides own the same tools and the winning side has the better plot to aim
  them at. Over 400 simulated games the toolbox made comebacks *less* likely,
  26.8% against 30.1%. Access is the rubber band; salvage is only the pacing.

**A sweep is public.** Sonar buys you a count and pays for it by telling the
fleet underneath where you looked. Without that, reposition had nothing to react
to and the counter-loop that stops any one tool dominating did not actually
exist. It moved reposition from 33% to 45% against a plain gunner.

### Changing a constant

`tests/battleship-balance.test.mjs` is the arbiter and it is deterministic: fixed
seeds, no clock, no `Math.random`. A failure there is exactly reproducible and
means a price moved, not that the suite got unlucky. Retune against it rather
than against intuition; every intuition in this list was wrong the first time.

The suite deliberately does **not** claim a snowball measurement between two
equal bots. Both simulated players are the same near optimal density hunter, so
an early lead between them is mostly a fact about where the fleets landed, and
no rule set shows a snowball under that microscope. The comeback claim is
measured by handicapping a fleet outright (`playOut({ handicap: [0, 2] })`) and
asking whether the toolbox lets it fight: 11.8% against 8.0% without.

## The files

| File | What it owns |
|---|---|
| `logic.js` | The rules, DOM free. Placement, firing, salvage, the five tools, the two fog projections, codes and names, the event reducer, poll pacing. |
| `bot.js` | Probability density targeting and the ability policies, plus `playOut()`, the simulation the balance suite runs. Decides from the two projections only, never from the match. |
| `script.js` | Screens, transport, the outbox, the poll loop, the placement editor, rendering. Decides nothing. |
| `i18n/ui.json` | One row per string, one column per language. Every `refuse.*` code the controller can send has a row, and a test fails if one does not. |

Constants are mirrored in `app/controllers/battleship-controller.php`. **Change
them in both**; `tests/battleship-logic.test.mjs` reads the PHP and compares.

## The Plot Table

A costume view: it declares its own palette inline rather than loading
`components/editorial/theme.js`, which is what [DESIGN.md](../../DESIGN.md)
licenses a showcase project to do. The direction contract is at the top of
`style.css`. Olive drab ground, chalk type, International Code of Signals colour
(signal red for damage, signal yellow for the tote, signal blue for enemy
water), corner registration brackets instead of boxes, zero radius. Depth is
lamplight and cast shadow, never a glow: spy owns glow and the house owns the
hard offset.

**Two gotchas in `style.css`:**

- The plot's tracks are pixel snapped with `round()` over a **container** unit,
  not a percentage. A percentage in a *row* track resolves against the grid's
  height rather than its width, so the expression that sizes the columns
  correctly collapses the rows. There is an `@supports (width: 1cqw)` layer over
  an `aspect-ratio` fallback.
- `site-footer` is self styled and its dark skin is the retired navy one. It is
  recoloured from the outside here rather than forked.

**Chrome.** Unlike spy, this view does load `back-link.js` and does end its boot
screen on `<site-footer>`. The navigational screens carry a real hash so the
Android back button and `back-link.js` walk them; the game screens are entered
with `replaceState`, because pressing back mid match must never land on the
placement screen of a match already at sea.

## Modes

`room` is the only mode that touches the server. `solo` is entirely in the tab,
which is why a solo result posted to `?action=record` is self reported and the
record card labels those games practice. Room results are written server side at
the verdict, for whichever seats happened to be signed in.
