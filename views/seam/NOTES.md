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
