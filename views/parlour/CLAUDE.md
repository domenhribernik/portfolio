# The Drawing Room (views/parlour)

Anonymous multiplayer rooms with a shared canvas. This view doubles as the
repo's **multiplayer base**: the room/guest/event-log machinery is generic,
and drawing is just the first game built on it.

## Why polling, not WebSockets

The production host runs PHP under Apache with no way to keep a socket
daemon alive (and the repo bans npm dependencies and background services).
Realtime therefore rides an **append-only event log in MySQL plus adaptive
short polling**: 450ms while ink is flying, 1s in the lobby, 1.6s when idle,
3s in hidden tabs, exponential backoff (capped 10s) on failures; pacing
lives in `pollDelay()` in [logic.js](logic.js). The transport is isolated in
`post()`/`pollOnce()`/`pumpOutbox()` in [script.js](script.js), so a
WebSocket could replace it without touching game logic.

## Files

- [../../app/models/parlour-model.sql](../../app/models/parlour-model.sql):
  `parlour_rooms` (4-letter `code`, `status` lobby|live), `parlour_guests`
  (secret token stored as SHA-256 `token_hash`, palette index `ink`,
  presence in `last_seen`/`left_at`), `parlour_events` (the log; `id` is the
  sync cursor). Run manually in phpMyAdmin like every model file.
- [../../app/controllers/parlour-controller.php](../../app/controllers/parlour-controller.php):
  every endpoint. Deliberately does NOT include `auth.php`: rooms are
  anonymous and throwaway, a guest is only its token.
- [logic.js](logic.js): DOM-free decisions (codes, names, stroke packing,
  the event reducer, poll pacing), unit-tested by
  `node --test tests/` (`tests/parlour-logic.test.mjs`).
- [script.js](script.js): screens, poll loop, outbox, canvas renderer.
- Integration tests: `/opt/lampp/bin/php tests/parlour-controller.test.php`
  (local scratch DB only; applies the model SQL itself and deletes every
  room it created).

## Wire protocol

Every endpoint is a JSON **POST** to
`parlour-controller.php?action=<create|join|poll|event|leave>`; tokens ride
in the body so they never hit access logs. `create`/`join` return
`{code, token, you:{id,host,ink}, room:{code,status}}`. `poll` takes
`{code, token, since}` and returns `{room, you, guests[], events[], last,
more}`; clients resend `last` as the next `since`, and `more:true` means
poll again immediately (pages of 400). Polling doubles as the presence
heartbeat: online = `last_seen` within 25s, guests silent 15+ minutes are
swept (`left_at`), rooms idle 12+ hours are purged on the next `create`.
There is deliberately no unload beacon: a refresh must resume (session in
`sessionStorage`), so closure is left to presence timeouts.

Event types today: `stroke` (anyone, only while `live`), `start` and
`clear` (host only; `clear` also **compacts** the log by deleting older
stroke rows, so late joiners never replay invisible ink). Strokes are
chunked while the pen is down; chunks share a client-minted `sid` of the
form `<guestId>.<n>` and the server rejects a `sid` not prefixed with the
sender's own guest id, so nobody can append to someone else's stroke.
Coordinates live on a fixed logical sheet (1500x1000, integers, clamped
server-side); every client letterboxes that sheet, which is what keeps all
canvases pixel-identical. `SHEET_W/H`, the chunk cap (600 points), and the
palette size are duplicated between `logic.js` and the controller on
purpose; change them in both.

The ink palette: hex values exist only in `logic.js` (`INKS`, 10 entries);
the server stores and validates just the index (`INK_COUNT`), and `-1` is
the eraser (paints with `PAPER`, so erasing replays like any stroke).

## Building another game on this base

1. New event type: a `case` in `postEvent()` (authorization + payload
   validation, canonical re-encode) and a branch in `applyEvents()` in
   logic.js (state change + an op for the UI). Unknown types are ignored by
   old clients and still advance their cursor, so additions are forward
   compatible.
2. Per-room game state beyond the log (scores, turn order) belongs as
   columns on `parlour_rooms` or a sibling table, snapshotted into the
   `poll` response next to `room`/`guests`.
3. The client outbox (`queueEvent`) guarantees your events arrive in order;
   4xx rejections drop with a toast, network errors retry forever.

Known limits, accepted for a parlour: no host handover when the host walks
away (nobody can ring the bell or clear), room codes are guessable-ish
(4 letters from 20, no rate limit beyond caps), and strokes send no
pressure. The tests pin everything above; start there before changing the
protocol.
