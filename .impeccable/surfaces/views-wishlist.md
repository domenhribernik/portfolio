---
version: 1
slug: "views-wishlist"
primary_target: "views/wishlist"
related_targets: ["views/wishlist/index.html","views/wishlist/style.css","views/wishlist/script.js","views/wishlist/logic.js"]
---

Scope: views/wishlist, the whole surface (the welcome note, the list, the claim
flow, the editor sheet, the one-time registry import, signed-out and signed-in
states). Visitor mode: Operate.

Audience: friends and family of Iliana, furnishing her first single household,
opening a shared link on a phone (often a German or Slovenian browser, English
page), reading her note, deciding what to buy, and coming back to check. Two or
so editors (site admin, project role `write`) add and edit items. Job: read
what she asks of everyone, see what the home still needs, read her note on
each item, say "I'll bring this" so nobody doubles up. Proof/content: the
owner's registry items and notes, and her welcome note, verbatim apart from
spelling fixes. Constraints: mobile first; English; unlisted, noindex; no
navbar or portfolio chrome; ends on site-footer; pictures are served from this
server only.

Unresolved: none. Restyled 2026-11-11 at the owner's request from the earlier
shelf-edge signage world to blush, to match views/iliana.

## Direction contract

THESIS  Iliana's own page: the blush of views/iliana, a personal note before
the list, and every gift as one clean white card. Refuses the store-signage
look it replaced, and the over-decorated pastel registry.

OWN-WORLD  Near-white pink ground #fdf7f8, a fuller blush #ffc2cc for the
header band and every button (hover #ffb3c1), white cards with a #f3dde2
hairline and 16px radius, photos multiplied into a #fdf1f3 well, ink #1a1416
for all text and #4a3d41 for notes. One deep rose #b23a57 only for the
Taken / Yours flag and the signature heart. Barlow Condensed 600 in sentence
case for the title and item names, Barlow for prose and keys, Dancing Script
only for "Mwaaah, Iliana". Flat cards at rest; the welcome note is the one
card with a soft rose shadow.

STORY  A guest reads the note, scans cards with the owner's notes, taps I'll
bring this, the card dips and the rose flag drops in with an Undo. Claimed
items move to a compact "Already taken" run of short rows. An editor adds an
item by pasting a link, then edits names and notes in place.

FIRST VIEWPORT  Phone 390: the blush band with the title and the tally line,
then the welcome note card overlapping its lower edge. Desktop: the note in two
columns (greeting and signature left, letter right), cards in three columns
below.

FORM  Signature interaction: the claim, one shared 260ms duration (FEED_MS),
card dips 2px and the rose pill flag drops into the top left corner, reversed
by Undo. No kicker above the title, no big-number tally.
