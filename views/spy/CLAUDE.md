# Spy (views/spy)

Two gamemodes, one set of screens:

- **one phone** (`mode = 'solo'`): the original pass-and-play game. No
  network at all beyond fetching the two `i18n/` tables once.
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

- `spy_rooms.location_key`, `spy_players.role` and `spy_players.voted_for`
  are the secrets. None may ever be written into an event, because the log is
  handed to every player in the room on their next poll.
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

`lobby -> brief -> round -> vote -> debrief`, held in `spy_rooms.status`.
Event types: `deal`, `ready`, `start`, `pause`, `resume`, `callvote`,
`end`, `castvote`, `closevote`, `verdict`, `again`, `settings`, `host`.
Host-only: `deal`, `start`, `pause`, `resume`, `end`, `closevote`, `again`,
`settings`. Anyone may `ready`, `callvote` and `castvote`.

`deal` runs from `lobby` or `debrief` (so "new round" skips the lobby, the
way the one-phone game's PLAY AGAIN always has), while `again` returns to the
lobby so settings can change and newcomers can be seated.

**One phone mode has no vote phase.** It ends at the debrief and the table
argues it out loud, exactly as it always did. Everything below is room mode.

### The call to vote

Anyone can say "let us vote" during a round; `callvote` is a **toggle**, so a
caller can change their mind. The tally is deliberately public (`endVotes` /
`endVotesNeeded` in the poll): watching agreement form is the entire point,
and it replaces one person having to insist out loud. A simple majority of
the seated players carries it, which is `endVoteThreshold()` in both
[logic.js](logic.js) and the controller. The host's END ROUND still works
instantly, and so does the clock running out; all three land in `openVote()`.

### The ballot

`castvote` names a target. The target must be seated in the room and may not
be the voter. **The ballot never enters the event log**, because the log is
public: the log records only that a player voted, and `voted_for` leaves the
controller in exactly two places, `you.votedFor` (your own) and the debrief
tally. That is what makes the phase worth having, since nobody has to accuse
anyone first.

**A ballot is an answer, not a commitment.** It stays changeable until the
vote actually closes, and the room counts the last one: `castvote` is a plain
overwrite of `voted_for`. That is only worth anything because the last ballot
does not close the room. It arms a **grace countdown** (`VOTE_GRACE_SECONDS`,
mirrored in [logic.js](logic.js)) held in `round_ends_at`, and any ballot
arriving while it runs disarms it so `advancePhase()` re-arms it with the full
period a moment later. Otherwise whoever happened to vote last would be the
one player at the table who could never change their mind, and every other
player's switch would race a room already in the debrief.

`round_ends_at` is therefore the deadline of **whichever phase is running**,
which is why one `expired` flag in `advancePhase()` both ends a round and
closes a vote. It reaches the client as `graceLeft`, deliberately a separate
field from `secondsLeft`: the round clock drives a progress bar scaled to
`roundSeconds`, and the ballot screen keys off `secondsLeft` staying null.

The vote closes when that countdown runs out, or when the host taps CLOSE THE
VOTE, which is also the escape hatch for a table that keeps changing its mind
and would otherwise never auto-close. `closeVote()` settles `accused_id` and
`outcome` **once, at that moment**, rather than recomputing them whenever the
debrief is read, so the verdict cannot drift as players come and go
afterwards. The most-voted player is the accused; if they are a spy the agents
win. A tie, or nobody voting, means the table failed to agree, and that is a
win for the spies.

## Translation

Two tables in [i18n/](i18n/), both shaped the same way and both read by the
browser **and** the controller, so nothing can drift between them:

| file | one row per | columns |
|---|---|---|
| `i18n/ui.json` | interface string | `en`, `sl`, ... |
| `i18n/locations.json` | place (plus a stable `key`) | `en`, `sl`, ... |

That shape is the whole system, and it is why there is no array of English
words sitting next to an array of Slovenian ones. **Adding a language is a
new column on every row plus an entry in `languages`; adding a word or a
place is one row.** A column left empty falls back to English rather than
rendering blank, so a half-finished language is safe to ship.

- `spy_rooms.location_key` stores the **key**, never a display string, so a
  room survives a wording change and reads correctly in any language.
- `spy_rooms.lang` is chosen once, by whoever opens the room, and every
  joiner inherits it. Joiners are never asked; the picker only appears on the
  create gate.
- The page marks its static text with `data-i18n="key"` (and
  `data-i18n-placeholder`), so the markup itself is the list of what needs
  translating. `applyLang()` repaints those, then re-runs the render
  functions for anything assembled from a count or a name.
- `locations.json` carries a `category` on every row. Nothing reads it yet;
  it is there so themed decks do not need a migration later.

One-phone mode uses whichever language was last picked, since it has no room
to inherit one from.

## Two transitions nobody presses a button for

There is no cron on the host, so `pollRoom()` carries both, each behind a
guarded `UPDATE` whose `rowCount()` decides who announces it. That is what
stops twenty phones polling the same second from writing twenty events:

1. **The clock running out** (`expireRound()`): flips `round` to `vote` and
   appends one `end` event.
2. **Host handover** (`handOverHost()`, called from `heartbeat()`): only the
   host can deal or start, so a room whose host walked out would be stuck
   forever. The longest-seated player still present inherits it. The parlour
   accepts this gap; here it would end the party.

`advancePhase()` is the third, and it runs **on the poll path too**, not
only after a `callvote` or `castvote`. Both its thresholds count the players
still seated, so leaving can carry a call or arm the vote's countdown exactly
as tapping can; without the poll-path check a room whose last voter walked out
would sit in `vote` with nothing to free it, and the countdown itself expires
under a poll rather than a tap. It funnels into `openVote()` and `closeVote()`,
the only two functions that may move a room into `vote` or `debrief`, and
`closeVote()` settles the phase and the verdict in a single guarded write so no
poll can ever read a debrief that has not decided who won yet.

## The clock

Server-authoritative so every phone shows the same number.
`round_ends_at` holds the deadline and `paused_seconds` the frozen remainder;
`secondsLeft` is computed by **MySQL** (`TIMESTAMPDIFF` against `NOW()`), not
PHP, so it agrees with the `NOW()` that set the deadline and no clock skew
creeps in. Clients interpolate locally between polls off that number, which
is why the round polls lazily (3s) without the countdown stuttering.

## Things that will bite

- **The i18n tables are canonical**, read by the controller with
  `file_get_contents` and by the browser with one `fetch` each. Do not paste
  a list back into either; that is the drift they exist to prevent.
- **A new user-facing string is a row in `ui.json`, never a literal.** The
  page has no English in its JavaScript at all; if you find yourself typing a
  sentence into `script.js`, it belongs in the table with a `data-i18n` hook
  or a `t()` call.
- **Constants are duplicated on purpose**: `MIN_ROUND_SECONDS`,
  `MAX_ROUND_SECONDS`, `ROUND_STEP_SECONDS`, `VOTE_GRACE_SECONDS` and the
  `spyMax` rule live in both [logic.js](logic.js) and `spy-controller.php`.
  Change them in both.
- **The session lives in `localStorage`, not `sessionStorage`** (the parlour
  uses the latter). Phones lock and browsers discard tabs mid-party, and
  "two tabs on one device are one player" is the right answer for spy.
- **Rosters are reconciled by id, never rebuilt** (`syncById`). Rows carry a
  one-shot deal-in animation and the lobby polls about once a second, so
  re-creating the nodes leaves the list twitching.
- **The brief card only repaints when its signature changes**, for the same
  reason: rewriting `.brief-role` every poll restarts its entry animation
  under the player's nose while they are reading it. The debrief's
  `.tally-chart` is signature-guarded too, and is deliberately **not**
  animated: the debrief keeps polling, so an entry animation on a figure
  people are reading replays every couple of seconds forever.

- **The secrecy rule now covers ballots too.** `spy_players.voted_for` is as
  secret as `role` until the vote closes, and for the same reason: the whole
  point of the phase is that nobody has to commit out loud first.

- **A tap is held over the next snapshot, not just painted.** `handlePoll()`
  replaces `you` wholesale, so a poll already in flight when a player taps
  answers with the state from *before* the tap and lands after it. Without
  `pendingBallot` / `pendingCall` (the same shield `pendingSettings` gives the
  host's steppers) a changed ballot or a retracted call visibly snaps back to
  the old answer, which reads as the game ignoring the player. Each clears the
  moment the server agrees.

Accepted limits: anyone holding a room code can take over a seat whose phone
has been quiet for 20 seconds (there is no per-seat secret to prove ownership
with) **and reads that seat's role and location in the process**, nobody can
join once roles are dealt, and there is no rate limit on `create`/`join`
beyond the caps. The reclaim leak is the one worth fixing first.
