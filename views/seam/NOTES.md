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
