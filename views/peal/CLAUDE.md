# views/peal

English change ringing in the browser: place notation is ground out into a plain course,
each bell is synthesised from the partials a founder tunes, and a visitor can take one
rope and be scored on their striking in milliseconds.

## Its own world, not the house style

This view is on the list in [DESIGN.md](../../DESIGN.md) of showcase projects that commit
to their own world, so it loads no Tailwind and no `components/editorial` theme. Do not
apply the house palette here, and do not lift these tokens back into the house system.

The world is **three inks and nothing else**, declared in [style.css](style.css) `:root`:
patina floods the sheet (with a deeper patina for recessed wells and a lighter one for
raised faces), everything drawn is knocked out of it in warm bone, and pour orange is the
single hot ink.

Two rules hold the whole thing together, and both are easy to break by accident:

- **Pour means sound, and nothing else.** A bell striking, the row sounding now, the rope
  in your hands, your own line through the rows. When nothing is sounding there is no pour
  anywhere on the page. A bell being *traced* at rest is told from the treble by stroke
  weight, never by a second colour, which is how a draughtsman does it.
- **Three stroke weights only** (`--w-hair` 0.75px, `--w-thin` 1px, `--w-thick` 2px).
  Everything ruled on the sheet is one of those. A new in-between weight is a bug.

Four token values look arbitrary and are not, so don't "tidy" them:

- `--pour-lit` exists because `#ff6a1f` measures 3.07:1 on patina; small type on pour has
  to use the lightened form to clear 4.5:1.
- `--on-pour` is the only ink dark enough to sit **on** pour and still clear the floor.
- `--bone-3` sits at 0.72 alpha because that is exactly where it clears 4.5:1 on patina.
  It is the small-label floor.
- `--bone-faint` (0.4) is for construction geometry only, never for type.

Because both text tones must clear the contrast floor on this ground, **hierarchy between
them is carried by size and tracking, not by opacity.** Reaching for a fainter bone to make
something recede is how this sheet goes illegible.

Faces are Bevan (cast lettering), Barlow Condensed (draughting labels) and Azeret Mono
(every figure), self-hosted via `assets/fonts/fonts.css` like everywhere else on the site.

**Gotcha: Azeret Mono turns place notation into arithmetic.** Its contextual alternates
substitute a multiplication sign for an `x` between two digits, and `x` is a change in
place notation, not a times sign, so `&x16x16x16,12` silently renders as a sum. Every
figure-bearing selector opts out with `font-feature-settings: "calt" 0`. A new selector
that prints notation, a row of digits or a frequency must join that list.

**Gotcha: the narrow-sheet rules live at the foot of the stylesheet on purpose.** An
earlier version had a media block sitting *above* the base rule it needed to beat, and at
equal specificity the later base rule won, so the phone's partials list rendered
zero-height while looking perfectly correct in the source. Add responsive rules to the
existing blocks at the bottom, never next to the component they override.

## Where a fact goes

Three modules, and the split is load-bearing rather than cosmetic:

- [logic.js](logic.js) is DOM-free and holds everything decidable: place notation parsing
  (including implicit places), grinding a course out until it comes home to rounds, bell
  paths, the major-scale tuning of a ring, the partials a founder tunes, laying rows on a
  clock with the real open handstroke gap, and striking scoring. New decisions go here so
  they can be tested.
- [tower.js](tower.js) owns the Web Audio graph and the ringing clock and knows nothing
  about the page. Its two testing seams exist deliberately: `Ringing.start()` takes
  `{ auto: false }` so a test can drive `tick()` against a fake clock instead of a real
  timer, and `defer()` is overridable for the same reason. Don't inline either back.
- [methods.js](methods.js) is a curated library where **every entry is a factual claim**.
  [tests/peal-methods.test.mjs](../../tests/peal-methods.test.mjs) rings all of them from
  rounds and fails the file if a course does not come home true at the stated length, so a
  mistyped notation fails the build rather than ringing something else under a famous name.
  Adding a method means adding a real one.

`script.js` is the wiring: it may read state and draw, but a decision that lives in it is
a decision nobody can test.

Suites: `node --test tests/` picks up `peal-logic`, `peal-methods` and `peal-ringing`.
