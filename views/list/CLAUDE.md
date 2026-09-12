# views/list

Shared lists, used on phones. Unlisted private tool: never register it in
`components/project-data.js`, `index.html`, or the navbar.

Slovenian UI (`lang="sl"`). Installable as a PWA (`manifest.json` plus a three-line
`sw.js` that caches nothing on purpose: a stale shopping list is worse than a slow one).

The design is its own small world (Space Grotesk, amber `#d97706`, warm paper), not the
editorial house theme, and `base-style.css` is deliberately not linked so its navy body
gradient cannot sit over the paper ground. DESIGN.md lists this view in the house scope;
that is known drift, kept because the owner asked for this look.

Backed by [list-controller.php](../../app/controllers/list-controller.php), schema in
[list-model.sql](../../app/models/list-model.sql). Decision logic is in
[logic.js](logic.js), tested by [tests/list-logic.test.mjs](../../tests/list-logic.test.mjs);
the API by [tests/list-controller.test.php](../../tests/list-controller.test.php).

## Two layers of access, both server-side

Membership in the `list` project admits you to the app; `list_collection_access` decides
which collections you actually see. The full pattern is in
[views/admin/CLAUDE.md](../admin/CLAUDE.md). Two things specific to here:

- **A missing collection answers 403, not 404.** Whether a list exists is itself private;
  a 404 would let any member probe for other people's list names.
- **Attribution comes from the session, never the body.** `added_by` / `checked_by` are
  derived from the cookie. The suite spoof-tests this on both create and patch.

## Labels

Exactly two kinds, and the set is closed: `section` (where it sits in the shop) and `shop`
(where to buy it). An item has **0 or 1 section and 0 or many shops**, enforced in
`applyItemLabels()`, not in the client.

Labels belong to a **collection**, so two lists never share a vocabulary and a label from
one can never be attached to an item in another. Any member of a collection may add,
rename or delete its labels; deleting one detaches it from items but leaves them alone.

`DEFAULT_LABELS` (the trgovina vocabulary) lives in **both** the controller and `logic.js`,
and `list-logic.test.mjs` greps the PHP so the two cannot drift. Nothing seeds it into a
database: it is applied per collection from the app's own "Dodaj privzete oznake", so a
second grocery list gets it the same way the first did.

**Sections are stored in store-walk order, and that order is the list's sort order.** The
page reads like a route through the shop rather than like the order things were typed.

## The three rules the UI rests on

1. **A shop filter also shows items with no shop.** An item with no shop means "anywhere",
   and hiding it while you are standing in Hofer is exactly how you get home without it. A
   section filter has no such reading, so it is exact. `applyFilter()` in `logic.js`.
2. **Only labels an open item actually uses become filter chips.** Nineteen permanent chips
   above a four-line list is the overstimulating version this was designed against.
   `usedLabels()`.
3. **Labels on a row are muted text, never chips.** Colour is reserved for the filter row,
   where it means *active*. If every row wore pills too, nothing would read as selected.

A row is also not signed with your own initials. You know what you added; the information
is who else did (`isMine()`).

## Checking is not deleting, and deleting is not buying

- Ticking an item stamps `checked_at` / `checked_by`. Unticking clears them, so an item
  that comes back on the list carries no stale claim that somebody bought it.
- **"počisti" archives**: the checked half becomes rows in `list_purchases` and then
  leaves `list_items`. Deleting an item records nothing.
- Anything checked more than 24 hours ago is archived on the next read. Production has no
  cron, so housekeeping rides the poll path; a cheap `SELECT` guards it so a 2-second poll
  does not write every tick.
- A purchase stores its labels and both names as **text snapshots**, never foreign keys, so
  history still reads correctly after somebody renames or deletes a label.

## Two gotchas that cost real bugs

**The poll version must be millisecond-precision.** It is `COUNT` plus `MAX(updated_at)`
over items *and* labels. When `updated_at` was a second-granular `DATETIME`, a check
landing in the same second as the previous write produced a byte-identical version, every
poller short-circuited past it, and the checkmark never reached the other phone. Hence
`DATETIME(3)`. `list-controller.test.php` pins this.

**The remembered filter must not be pruned before the items arrive.** `pruneFilter()` takes
a `loaded` flag for exactly this: on the first paint after a reload every label looks
unused, and pruning there wipes the filter the person deliberately left running.

## Production

`app/models/seeds/list-rework-2026-09.sql` migrates an existing database in place and must
be applied by hand in phpMyAdmin. Until it is, every read 500s, because the controller
joins on `list_items.collection_id`. A fresh install runs `list-model.sql` instead.
