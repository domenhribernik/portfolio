---
version: 1
slug: "views-trips"
primary_target: "views/trips"
related_targets: ["views/trips/index.html","views/trips/style.css","views/trips/script.js","views/trips/logic.js","views/trips/map.js"]
---

Scope: views/trips, the whole surface (atlas, trip, place, photo lightbox, join,
signed-out showcase). Visitor mode: Experience when looking back, with Operate
rules on the capture flow.

Audience: anyone with a Google account, mostly on a phone while travelling
(sunlight, one hand, patchy or roaming signal), and later on a couch or desk
looking back with whoever they travelled with. Portfolio visitors who will not
sign in see one showcase trip read-only. Job: chain places onto a trip as you
go, fill each place with photos, and later see everywhere you went on one map.
Action: add a place, take or add photos. Proof: the user's own trips and photos;
the showcase trip for visitors. Constraints: no build step and no Tailwind (the
view must open offline); Leaflet vendored under lib/; CARTO tiles; Overpass and
Overpass Mono self-hosted; photos are served only through the controller.

Unresolved: none. Direction round seed 92ce4a49: the user chose the pick card
(transit diagram) over the dealt lead (postcards). No image generation on this
machine, so the build is code-led by the only path available.

## Direction contract

THESIS  Your travels drawn as a transit network. A trip is a line in its own
colour, every place is a station on it, the atlas is the network map of
everywhere you have been. It refuses the category page (white map, dotted
route, carousel of step cards) and its opposite (dark night map, glowing pins).

OWN-WORLD  The printed network diagram. Warm diagram-white ground, never pure
white; warm near-black ink for station names and rules; a quiet water blue in
the basemap. Each trip owns one line colour from a fixed set of ten transit
colours, and that colour is the only accent on its screens. Thick lines, tick
stations, a white-filled black-ringed interchange circle for the selected
station, trip bullets as a filled circle with the trip's initials. Overpass
bold for station names in wayfinding sentence case, Overpass Mono for times,
dd.mm.yyyy dates, coordinates and counts. Square ends on lines and strips; round
only on bullets and stations. Hollow or dashed means not real yet: photos
waiting for signal, places created offline, the dashed next-stop stub that adds
a place. Each always carries a text label too.

STORY  See your travels as one network, open a line, walk its stations, and
inside a station see where every photo was taken. On the road, extend the line
by one station and fill it, with or without signal.

FIRST VIEWPORT  Phone, signed in, atlas: full-bleed pale map fitted to the whole
network, every trip a thick coloured line through its stations with names
beside the ticks. A bottom sheet peeks with the network key; a count line
(trips, places, photos, countries). New trip sits in the thumb zone. Desktop:
the map takes about the left 68%, the key and detail panel the right.

FORM  Transit network diagram, position 1 on the ordered list (chosen as
IMPECCABLE'S PICK; the dealt lead was position 7, postcards). Seed key 92ce4a49.
Signature interaction: the station strip, an in-car line diagram across the top
of a place screen; the current station stays under a fixed you-are-here marker
and the strip snaps one station per swipe or arrow with one short overshoot
while the map flies there in sync.

RAISE (from the destination blind, competitive)  Nothing glides: station to
station is a discrete snap under a fixed marker.
RAISE (from the civic prospectus, declined)  Colour is spent in one place:
photos are the only full-colour images; one line colour per screen except the
network map.
RAISE (from the VU-meter bridge, declined)  The network key is identical rows
side by side, read by sweeping down it.
RAISE (from the cyclorama, declined)  Time is an axis: the grid groups photos by
day with hh:mm in mono, like a timetable.
RAISE (from the postcards, unchosen lead)  Sync has its own vocabulary: hollow is
waiting, filled is sent, and a service-status line reads Good service or N
photos waiting for signal.

FINISH  unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.
