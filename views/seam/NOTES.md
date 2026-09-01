# SEAM: what you should know

Decisions taken while building that you did not sign off on, findings that
change how the game actually plays, and the one thing standing between this
branch and a working page. Written for you, not for the next agent: the
mechanics and the gotchas live in [CLAUDE.md](CLAUDE.md).

## Before it works at all

**Run [../../app/models/seam-model.sql](../../app/models/seam-model.sql) in
phpMyAdmin.** The served controller talks to the production database, so
`/views/seam/` will 500 with "Table 'seam_rooms' doesn't exist" until you do.
Everything else is already wired.

Pass-the-plate and the bot work without it. Only room mode needs the tables.

Two more, both optional and both already run once:

- `seam-model.sql` now also seeds the `projects` row, so the section is listed
  in the admin dashboard's projects tab. It grants nobody anything, and the
  controller has no Auth gate to grant against; it is a registry entry.
- **Run
  [../../app/models/seeds/dashboard-tile-seam.sql](../../app/models/seeds/dashboard-tile-seam.sql)**
  for the Dashboard launcher tile. It is public and opt-in (`project_id` NULL,
  `is_default` 0), the same shape as Spy Game and the Drawing Room, so it
  writes nothing to anyone's shelf: pick it yourself from the launcher's tile
  picker. Do not point that tile at the `seam` project row, or the only person
  who can see it is you.

## The four bugs you reported, and what was actually wrong

All four were real, and three of them had a cause worth knowing about.

**You could only click the numbers.** Now the whole column is a hit area, and
hovering or focusing it shows a dashed ghost core in the exact bed the piece
will land in. The numbered heads are still the keyboard and screen-reader
control, so a shaft still has one tab stop rather than two.

**The drop wasn't nice.** Two separate faults. The distance was written as a
percentage, which CSS reads as a fraction of *the core's own height* rather
than of a bed, so every row fell short by a different amount and the top row
travelled almost nothing in 0.18s. And the piece it animated was the **lowest**
core in the column, not the one you just played: from the second piece in any
column onward, you were watching somebody else's core fall from the sky. Cores
now launch from a drawn collar above the datum, fall under one constant
acceleration, and land with a compression and a survey tick.

**The row removal didn't look nice.** Everything moved at once, so a hole never
appeared: the basement and the overburden travelled together and it read as
"the colours scrolled" while the bottom row dissolved in place. It is now three
beats, cut then void then collapse, so you see the floor leave, see the gap it
leaves, and then watch the rock fall into it.

**The line wasn't connected.** This was the sharpest bug of the four. The seam
used `stroke-dasharray: 200` against a non-scaling stroke, which makes the dash
**200 screen pixels** rather than 200 units of board. A horizontal seam on a
phone is 191px, so it just squeaked under and looked fine; a diagonal is 271px
and a horizontal on a desktop plate is 338px. Both painted 200 pixels of line
and stopped in mid-air. **You were almost certainly seeing this on a laptop or
on a diagonal, and it would have looked fine to me on a phone.** Nothing
computes a dash from a literal any more.

While fixing it I also changed what a struck seam looks like, because a heavy
stroke through four centres reads as a row being *crossed out*, which is the
opposite of finding something. It is now a hatched corridor of ore running
behind the four cores, ticked like a fault, with the winning four ringed and
the rest of the plate drained.

## Three more I found while in there

Not reported, but they would have bitten a real player.

1. **The i18n table was fetched `force-cache`.** That serves a stale copy
   without ever asking, so any string added after someone's first visit would
   render as a raw key on their device forever. `views/spy/CLAUDE.md` documents
   this exact trade as a mistake; SEAM shipped with it anyway. Now `no-cache`,
   which still costs only a bodyless 304 when nothing changed.
2. **A tap during the drop was silently swallowed.** The plate refuses input
   while it animates, and the lock was held through the landing squash as well
   as the fall. It now lifts the moment the core is in its bed.
3. **"DRAWING THE BOTTOM" outlived the cave** on the opponent's plate by about
   a second, because only the next poll rewrote that line.

## The black bar you saw, and the bigger one it was hiding

**The bar under a landing core was the landing mark, drawn far too heavy.**
`.core--fresh::after` is meant to be the reading the plate takes where a core
comes to rest. Every offset on it is a percentage of the *core*, which is 78%
of a bed, so the numbers were smaller than they looked: at `bottom: -16%` the
mark landed a fraction of a pixel **below** the cell's own border instead of
resting inside the bed, and at `left/right: -38%` it ran to 176% of the core's
width and crossed into the neighbouring shafts. In 2px of graphite, the same
ink as the heaviest rules on the plate. On the basement bed it was worst: that
row's cells carry no bottom border, so the mark fell straight onto the trench's
2px graphite lip and the two read as one black bar flashing across the foot of
the plate. It is now a 1px slate hairline that sits inside its own bed and
starts fading the moment it is drawn.

**Chasing it turned up something worse: the cave was moving the rock and
leaving every core behind.** `core--fresh` was added on each drop and never
removed, and `paintCores` reuses a core element whose seat has not changed, so
the class accumulated until every core on the plate carried it. `coreFall`
fills `both`, and a filled animation outranks a plain declaration in the
cascade, so the collapse rule could not move a single one of them: measured
mid-collapse, all five surviving cores sat at `translateY(0)` while the strata
travelled a full bed under them, and then snapped into register when the
repaint rebuilt the grid. That is why a cave read as "the colours moved" rather
than "the ground fell", which is the exact thing the three-beat sequence was
built to fix. `caveIn()` now strips the class before beat three.

## The three multiplayer bugs, and the race behind the worst one

**The player list looked like it was looping.** `rowIn` is a one-shot entrance
animation, but `renderRoster()` clears the list and rebuilds both rows on every
poll, so it replayed a couple of times a second and read as a loop. The
animation is gone from `.roster__row`.

**There was no way to type a code.** The join gate already existed, complete
with its code field, its title and its own strings; the only thing missing was
a door to it, so it could be reached only by following a shared link. Two
people sitting in the same room had nowhere to type the code they were reading
out. `TYPE A CODE` is now the second door on the boot screen and opens the
gate that was already there.

**The match would not start, and this one was a real race.** Your section SMZN
is still in the database and it tells the whole story: `deal` and `abandon`,
both at 10:15:42, two surveyors seated, status `lobby`.

`joinRoom` locks the room row, inserts the second player, deals, and commits.
While it held that lock, the other plate's poll ran `reopenIfAbandoned()`,
which counted seats **without taking the lock**. The insert was still
uncommitted and therefore invisible to it, so it counted one seat, concluded
the section had been abandoned, and went to write `status = 'lobby'`. That
write blocked on the lock `join` was holding. `join` committed `play`; the
waiting write then re-read the row, found `status <> 'lobby'` was true, and put
the section straight back into the lobby with both seats full.

That is a dead end, because `startMatch()` can only be reached from `join` at
the moment the second seat is taken, or from `again` on a finished section.
Neither can ever happen to a full room sitting in the lobby, and there is no
start button because there was never meant to be one.

Two fixes. `reopenIfAbandoned()` now takes the room lock before it counts, so
it runs strictly before the join or strictly after it, never through the middle
of it. And the poll now re-checks the rule it used to trust: both seats filled
means the section is dealt, whatever got it into the lobby. A section stranded
the way yours was recovers on the next poll from either plate.

I hammered twelve rooms with six concurrent pollers across the join: all twelve
came out dealt, with no spurious `abandon`. The regression test fails against
the old controller and passes against the new one.

## The finding that changes the game

**A cave can never hand the win to your opponent, and two seams at once cannot
happen.**

I did not expect this and the plan assumed otherwise. The reason is simple
once you see it: drawing the bottom moves every surviving core down by exactly
one bed, so every distance between cores is preserved. A cave cannot create a
line that was not already there, and the game ends the moment a line appears,
so there never was one. The only new piece on the board is the mover's own.
Only the seat that just cut can strike.

Two consequences:

1. **The both-players-win draw you chose is unreachable in play.** I kept the
   branch anyway, in both the JS and the PHP, because the server should not
   depend on that reasoning being correct. It is a guard, not a rule anyone
   will meet.
2. **Drawing the bottom carries no immediate risk.** Its real cost is
   positional: it destroys your own basement cores as well, it spends a scarce
   permit, and it often opens the section for the other seat. But you can
   never lose on the spot by caving.

`tests/seam-logic.test.mjs` pins this across 400 random games, and the PHP
suite re-derives every frozen verdict from the section it was struck in. If
either ever goes red, the rules changed, not the test.

**If you want the cave to bite harder**, the rule to change is the whole-row
cave itself, not that guard. The cheapest option that restores real risk:
draw the basement of the *cut shaft only* rather than the whole row. Column
heights then stop moving in lockstep, so a cave can genuinely line four up for
either player. It contradicts "removes the bottom row" as you described it,
which is why I did not do it.

## Three things I changed from the plan

**The depth scale does not renumber.** The plan had it counting deeper on
every cave. Built, it was incoherent: the cores fall downward while the
numbers claim the window is descending, which are opposite stories. A
block-cave drawpoint does not move, the rock moves through it, so the scale
holds at 5 to 30 m, the strata roll as the overburden caves in behind, and
what grows instead is a `DRAWN 10 M` tally in the title block. Same payoff,
on the readout that can honestly carry it.

**The bot's hardest setting is depth 5, not 6.** Measured across a full
self-play game, worst position: depth 2 costs 12ms, depth 4 costs 47ms, depth
5 costs 174ms, depth 6 costs 673ms. The search runs on the main thread, so
depth 6 is a visible stall on a phone. `DEPTHS` in `logic.js` carries the
numbers if you ever want to move it into a worker and go deeper.

**The result is stamped on the plate, not shown on its own screen.** The first
version swapped the board out for a results screen, which hid the seam you had
just struck at the exact moment it was worth looking at. The section now stays
put and the verdict is ruled off underneath it.

## Calls that are yours to overrule

- **Homepage rank.** I put `seam` at rank 2 in `FEATURED`, behind Tells. That
  list is hand-ranked and `tests/projects-index-logic.test.mjs` pins the exact
  order, so moving it means editing both.
- **The name.** "Seam" is the win condition (four in a line is a seam) and the
  whole vocabulary is built on it: shafts, beds, cores, permits, drawing the
  bottom. Renaming means retranslating `i18n/ui.json`, not just a title.
- **No per-turn clock.** A player who wanders off leaves the other waiting
  until the 15 minute sweep voids the section. Spy's server-authoritative
  clock is the pattern to copy if that turns out to be annoying in practice.
- **The section is void when someone leaves mid-match.** The room drops back
  to the lobby so the same link still works for whoever turns up next, rather
  than freezing the board. No result is recorded either way.

## Known limits, inherited and accepted

Anonymous rooms, no accounts. Four consonants from twenty gives 160k codes,
guessable-ish, with no rate limit on create or join beyond the caps. Nobody
can join once a match is under way, though the seat picker covers a phone that
lost its session. Rooms idle for six hours are purged by the next create.
