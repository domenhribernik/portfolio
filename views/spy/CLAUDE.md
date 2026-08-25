# Spy (views/spy)

Two gamemodes, one set of screens:

- **one phone** (`mode = 'solo'`): the original pass-and-play game. No
  network at all beyond fetching `locations.json` once.
- **room** (`mode = 'room'`): a phone each, over an anonymous four-letter
  code. Built on the parlour's multiplayer base, see
  [../parlour/CLAUDE.md](../parlour/CLAUDE.md) for the polling rationale,
  the event-log cursor and the outbox contract, none of which is repeated
  here.

Both modes share `briefScreen`, `roundScreen` and `debriefScreen`; they
differ only in which controls are visible and where the data comes from.
That is deliberate: it is what keeps the two modes looking like one game.
`showScreen(id)` takes a raw element id and toggles `.active` (the parlour's
takes a logical name and toggles `.on`, do not mix them).

## The secrecy inversion

The parlour's server guards state but never computes it, because a stroke is
public. **A role is a secret, so here the server owns the deal.** That single
difference drives the schema, the controller and the tests:

- `spy_rooms.location` and `spy_players.role` are the secrets. They may never
  be written into an event, because the log is handed to every player in the
  room on their next poll.
- They leave `spy-controller.php` in exactly two places: the `you` block of a
  poll response (the caller's own role, plus the location **only** when that
  caller is a citizen) and the `reveal` block, which the controller adds only
  once `status = 'debrief'`.
- `players[]` deliberately does not select `role` at all.

`tests/spy-controller.test.php` pins this and nothing else should be allowed
to weaken it. The load-bearing case is "THE LOCATION NEVER APPEARS ANYWHERE
IN A SPY PAYLOAD", which greps the spy's raw response body for the string a
citizen was told. If that ever goes red, the gamemode is broken, not the test.

## Phases and events

`lobby -> brief -> round -> debrief`, held in `spy_rooms.status`. Event types:
`deal`, `ready`, `start`, `pause`, `resume`, `end`, `again`, `settings`,
`host`. All but `ready` are host-only; `deal` runs from `lobby` or `debrief`
(so "new round" skips the lobby, the way the one-phone game's PLAY AGAIN
always has), while `again` returns to the lobby so settings can change and
newcomers can be seated.

Accusation and voting are **verbal**, off-app, exactly as in the one-phone
game. There is no vote phase, which is why the dossier can safely ride along
in the poll from the moment the round ends.

## Two transitions nobody presses a button for

There is no cron on the host, so `pollRoom()` carries both, each behind a
guarded `UPDATE` whose `rowCount()` decides who announces it. That is what
stops twenty phones polling the same second from writing twenty events:

1. **The clock running out** (`expireRound()`): flips `round` to `debrief`
   and appends one `end` event.
2. **Host handover** (`handOverHost()`, called from `heartbeat()`): only the
   host can deal or start, so a room whose host walked out would be stuck
   forever. The longest-seated player still present inherits it. The parlour
   accepts this gap; here it would end the party.

## The clock

Server-authoritative so every phone shows the same number.
`round_ends_at` holds the deadline and `paused_seconds` the frozen remainder;
`secondsLeft` is computed by **MySQL** (`TIMESTAMPDIFF` against `NOW()`), not
PHP, so it agrees with the `NOW()` that set the deadline and no clock skew
creeps in. Clients interpolate locally between polls off that number, which
is why the round polls lazily (3s) without the countdown stuttering.

## Things that will bite

- **`locations.json` is the canonical list**, read by the controller with
  `file_get_contents` and by the browser with one `fetch`. Do not paste the
  array back into either; that is the drift this file exists to prevent.
- **Constants are duplicated on purpose**: `MIN_ROUND_SECONDS`,
  `MAX_ROUND_SECONDS`, `ROUND_STEP_SECONDS` and the `spyMax` rule live in
  both [logic.js](logic.js) and `spy-controller.php`. Change them in both.
- **The session lives in `localStorage`, not `sessionStorage`** (the parlour
  uses the latter). Phones lock and browsers discard tabs mid-party, and
  "two tabs on one device are one player" is the right answer for spy.
- **Rosters are reconciled by id, never rebuilt** (`syncById`). Rows carry a
  one-shot deal-in animation and the lobby polls about once a second, so
  re-creating the nodes leaves the list twitching.
- **The brief card only repaints when its signature changes**, for the same
  reason: rewriting `.brief-role` every poll restarts its entry animation
  under the player's nose while they are reading it.

Accepted limits: anyone holding a room code can take over a seat whose phone
has been quiet for 20 seconds (there is no per-seat secret to prove ownership
with), nobody can join once roles are dealt, and there is no rate limit on
`create`/`join` beyond the caps.
