---
version: 1
slug: "views-wishlist"
primary_target: "views/wishlist"
related_targets: ["views/wishlist/index.html","views/wishlist/style.css","views/wishlist/script.js","views/wishlist/logic.js"]
---

Scope: views/wishlist, the whole surface (the list, the claim flow, the editor
sheet, the one-time registry import, signed-out and signed-in states). Visitor
mode: Operate.

Audience: friends and family of one person furnishing their first single
household, opening a shared link on a phone (often a German or Slovenian
browser, English page), deciding what to buy, and coming back to check. Two
or so editors (site admin, project role `write`) add and edit items. Job: see
what the home still needs, read the owner's note on what would do, say "I'll
bring this" so nobody doubles up. Proof/content: the owner's 24 registry items
and their own notes, verbatim. Constraints: brief pinned "very modern minimal,
functional", mobile first; English; unlisted, noindex; no navbar or portfolio
chrome; ends on site-footer; pictures are served from this server only.

Unresolved: none. Direction round seed a6cb6333, re-rolled once (plain); the
user kept the dealt lead of round two. No image generation on this machine,
so the build is code-led.

## Direction contract

THESIS  The wish list as a well-kept store shelf: every gift stands on a white
shelf over its clip-on tag, and saying you'll bring one punches that tag. It
refuses the registry card grid with a Reserve button, and its opposite, the
cosy cream-and-serif "home" mood.

OWN-WORLD  Shelf-edge signage. Warm shelf white ground, ink near-black, and one
fixed neutral ramp (no off-ramp greys) for rails, rules and small print. A
pale rail strip runs under every product as the shelf edge; tags hang from it
as clean white rectangles, flat, square-cornered, no shadow at rest. One
accent: tag yellow, only for the reserved flag. Barlow Condensed for item
numbers and names, Barlow for the small print, tabular figures. Every photo
sits in one fixed square on white. A claimed tag is punched (a round hole
through its top corner) and carries the yellow flag.

STORY  A guest sees how much is still needed, scans products with the owner's
notes, taps I'll bring this, and the tag punches with an Undo. An editor adds
an item by pasting a link, then edits names and notes in place.

FIRST VIEWPORT  Phone 390: an ink aisle sign with the list name large and one
plain line under it (17 of 24 still needed, tap I'll bring this); then the first bays, each a product square
standing on its rail with the tag below: name large, note, shop link left,
I'll bring this key right. Editors get Add item pinned in the thumb zone.

FORM  Shelf-edge tag system, position 6 on the ordered list; seed key
a6cb6333 (re-roll 1). Signature interaction: the punch, the tag dips 2px, a
hole is cut through its corner and the yellow flag drops over the rail edge
in one shared duration, reversed by Undo. Raises: a claim punches the tag
(orienteering control card); one fixed tonal ramp (exposure record); one fixed
square on one white ground for every photo (streaming wall); every tag hangs
from one shared shelf baseline (botanical folio). No article numbers on tags and no big-number tally: the craft floor refuses both, so names carry the tag.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
