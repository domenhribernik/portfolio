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
takes a logical name and toggles `.on`, do not mix them). It also drives the
top-left EXIT, which **leaves the room or the game and stops at the title
screen**, and hides itself there. It used to be a link to the site root, which
is nobody's intention mid-party: people reaching for it want out of the lobby,
not off the site.

## The secrecy inversion

The parlour's server guards state but never computes it, because a stroke is
public. **A role is a secret, so here the server owns the deal.** That single
difference drives the schema, the controller and the tests:

- `spy_rooms.location_key`, `spy_players.role` and the `spy_ballots` rows are
  the secrets. None may ever be written into an event, because the log is
  handed to every player in the room on their next poll.
- They leave `spy-controller.php` in exactly two places: the `you` block of a
  poll response (the caller's own role and own ballot, plus the location
  **only** when that caller is a citizen) and the `reveal` block, which the
  controller adds only once **the host has called the round**, not merely once
  the room reaches the debrief. See "The host's call" below.
- `players[]` deliberately does not select `role` at all, and counts ballots
  rather than reading them.

`tests/spy-controller.test.php` pins this and nothing else should be allowed
to weaken it. The load-bearing case is "THE LOCATION NEVER APPEARS ANYWHERE
IN A SPY PAYLOAD", which greps the spy's raw response body for the string a
citizen was told. If that ever goes red, the gamemode is broken, not the test.

## Phases and events

`lobby -> brief -> round -> vote -> debrief`, held in `spy_rooms.status`.
Event types: `deal`, `ready`, `start`, `pause`, `resume`, `callvote`,
`end`, `castvote`, `closevote`, `verdict`, `reveal`, `again`, `settings`,
`host`. Host-only: `deal`, `start`, `pause`, `resume`, `end`, `closevote`,
`reveal`, `again`, `settings`. Anyone may `ready`, `callvote` and `castvote`.

The debrief is the one phase with two states inside it, which is why
`revealed` is a column and not a status: `verdict` gets the room there,
`reveal` is the host calling it.

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

**A ballot carries one name per spy.** With two in play everybody names two,
because the rule the phase turns on is that the agents win only by putting
*every* spy in the top n: catching one of two means the other walked out with
the round. One name per spy cannot be expressed in a column, which is why the
ballots are a table (`spy_ballots`, one row per accusation) rather than the
`spy_players.voted_for` this started as.

How many names that is comes from `picksNeeded(spies, seated)`, mirrored in
[logic.js](logic.js) and the controller, and it is **capped at the number of
people a voter can actually name**. Without that cap a room that loses players
mid-vote asks for more names than there are candidates, no ballot can ever be
completed, and the vote hangs with nothing to free it.

A ballot is replaced wholesale rather than diffed: the phone sends the entire
set every time, so no order of operations can leave half a change readable.
Row id order is pick order, which is what lets a phone that reloaded drop the
same oldest name the one before it would have. `castvote` targets must be
seated in the room, must not be the voter, and must not repeat.

**The ballot never enters the event log**, because the log is public: the log
records only that a player voted, and the rows leave the controller in exactly
two places, `you.ballot` (your own) and the debrief tally. That is what makes
the phase worth having, since nobody has to accuse anyone first.

On the phone, tapping a name when you already hold your limit **drops your
oldest pick** rather than doing nothing. A control that swallows a tap reads as
broken, and with one spy in play the behaviour is exactly the "switch your
vote" the ballot has always had.

**A ballot is an answer, not a commitment.** It stays changeable until the
vote actually closes, and the room counts the last one: `castvote` deletes the
voter's rows and writes the set it was handed. That is only worth anything because the last ballot
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
and would otherwise never auto-close. `closeVote()` settles `accused_ids`
**once, at that moment**, rather than recomputing it whenever the debrief is
read, so it cannot drift as players come and go afterwards.

The accused are **the top n of the tally**, and only what clears the cut line
outright: the first name that missed it sets the bar, and anyone level with
that name is tied for last place and cannot be told from the people who missed
out. So `accused_ids` can come back SHORT of n, or empty, and that is the
honest answer rather than a coin toss. Accusing four people of being two spies
is not something the table said.

`closeVote()` deliberately settles **no verdict at all**. That is the host's,
and the next section is why.

## The host's call

The vote closing is not the end of the round, it is the start of the argument.
The accused answers for what the tally says about them, and a spy who has been
caught can still take the round by naming the location, which is a thing that
happens out loud at a table and that the server has no way to see. So the app
does not guess:

- The debrief arrives in **two halves**. `ballot` (who was accused, the tally,
  and how many names were wanted) is public the moment the vote closes, because
  that is what the defence is answering. `reveal` (the location, who the spies
  were, the verdict) is **not in any payload** until the host calls it.
- The host's call is one tap on AGENTS or SPIES, and that tap does both jobs:
  it writes `outcome` and sets `revealed = 1`, so the dossier opens on every
  phone at once rather than each player uncovering it in their own time.
- It is repeatable on purpose. The host hears the defence before they call it,
  so calling it wrong is a live possibility, and tapping the other button fixes
  it without replaying the round.
- NEW ROUND and BACK TO THE SAFE HOUSE stay hidden until the call, so the host
  cannot skip past the moment everyone is waiting for.

This is what the earlier version got wrong: it computed a verdict from the
ballot and handed the whole dossier to every phone the instant the vote closed,
which ended the discussion before the accused had said anything. The top-n rule
above still decides who was *caught*, and the debrief prints it ("THE BALLOT
CAUGHT 1 OF 2"), but who *won* is a person's call.

## The deck

**A room never plays the same location twice.** `spy_rooms.used_location_keys`
is a comma separated list of everything it has already dealt, and the draw is
from what is LEFT rather than from the whole table. The same place turning up
twice in one evening is the single thing that makes a fresh round feel like a
rerun, and it is what the game was reported for after a night with a big group.

When the deck runs out it reshuffles minus the place just played, so a party
longer than the table can neither repeat nor dead-end. The list belongs to the
ROOM and outlives its rounds: a new deal keeps it and so does `again`, and only
deleting the room clears it. `dealLocation()` in the controller and
`pickUnusedLocation()` in [logic.js](logic.js) are the same function twice, the
second one because the one-phone game needs it for PLAY AGAIN (there it lives
in memory for the sitting, since a reload is a new party).

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

### Counting things is four rows, not an appended -s

Slovene needs four forms where English needs two, so **any string with a count
in it is a set of rows**, keyed `<base>.one|two|few|other`, and
`pluralString(t, table, base, n, vars)` picks one by the CLDR Slovenian rule
(`one` n%100=1, `two` n%100=2, `few` n%100=3-4, `other` everything else). The
English column fills all four and the same set answers both languages. The
tests refuse a half-filled set.

Two things a translator has to be told, both learned the hard way:

- **Sometimes the whole sentence has to be four rows, not the noun.**
  `brief.citizenFlavor` is, because Slovene agrees the verb of the trailing
  clause with the count too ("razkrinkaj vohuna, ki ne **sodi**" against
  "vohuna, ki ne **sodita**"), and no amount of substituting a noun fixes that.
- **A count next to a noun is not automatically broken.** `{n} / {total}
  ODDANIH GLASOV` reads as "n od total", and `od` governs the genitive plural
  whatever the numbers are, so those stay single rows. Splitting them would be
  busywork that invites a wrong form later. Likewise `lobby.theHost` is
  deliberately in the accusative (it is the fallback name inside `ČAKAMO NA
  {name}`) and looks like an inconsistency with `tag.host` but is not.

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
`closeVote()` settles the phase and the accusation in a single guarded write so
no poll can ever read a debrief whose tally and ACCUSED disagree. The verdict
is not settled there at all: see "The host's call".

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

- **A string only `t()` writes has no fallback, so guard it with
  `hasString()`.** `resolveString` answers a row it does not have with the key
  itself. That is the right answer for a `data-i18n` element, because the
  markup ships English and the reader never sees the miss. Text written into an
  element that starts empty has nothing to fall back on, so the same miss
  prints `vote.grace` at a player. This is not hypothetical: a tab holds the
  table it fetched at load for as long as it stays open, so the phones in one
  room can be running different vintages of `ui.json` and only the ones opened
  before the row existed break. Substitute something language-neutral (the bare
  number, for the countdown) rather than a key.

- **The i18n tables are fetched `no-cache`, and must stay that way.** That
  revalidates rather than skipping the cache, so an unchanged table still costs
  only a bodyless 304. They were once `force-cache`, which serves a stale copy
  without ever asking: every string added after a phone's first visit rendered
  as its raw key, forever. A translation table you cannot update is worth more
  than the request it saves.
- **Constants and rules are duplicated on purpose**: `MIN_ROUND_SECONDS`,
  `MAX_ROUND_SECONDS`, `ROUND_STEP_SECONDS`, `VOTE_GRACE_SECONDS`, the
  `spyMax` rule, `picksNeeded()` and the location deck (`pickUnusedLocation()`
  against `dealLocation()`) live in both [logic.js](logic.js) and
  `spy-controller.php`. Change them in both.
- **The session lives in `localStorage`, not `sessionStorage`** (the parlour
  uses the latter). Phones lock and browsers discard tabs mid-party, and
  "two tabs on one device are one player" is the right answer for spy.
- **A translated heading with `data-text` needs both written.** `.glitch`
  draws its two offset copies from `attr(data-text)` in CSS, so a heading whose
  `textContent` was translated and whose `data-text` was not renders the old
  language in red and cyan behind the new one. `applyLang()` writes both; it
  did not always, and TIME'S UP sat behind ČAS JE POTEKEL for a while.
- **This host runs PHP 8.0.** `array_is_list()` and anything else from 8.1 is
  not available (there is an `isList()` in the controller for exactly that).
- **The debrief and the ballot put their corner stamp in the FLOW**, not at an
  absolute offset like every other screen. Both sit above content that grows
  (a tally is a row per player, up to twenty), so an offset tuned against four
  players lands across the bars at twelve. Do not "fix" them back.
- **Rosters are reconciled by id, never rebuilt** (`syncById`). Rows carry a
  one-shot deal-in animation and the lobby polls about once a second, so
  re-creating the nodes leaves the list twitching.
- **The brief card only repaints when its signature changes**, for the same
  reason: rewriting `.brief-role` every poll restarts its entry animation
  under the player's nose while they are reading it. The debrief's
  `.tally-chart` is signature-guarded too, and is deliberately **not**
  animated: the debrief keeps polling, so an entry animation on a figure
  people are reading replays every couple of seconds forever.

- **The secrecy rule covers ballots too.** A `spy_ballots` row is as secret as
  a role until the vote closes, and for the same reason: the whole point of the
  phase is that nobody has to commit out loud first.
- **And it covers the dossier until the host calls the round.** A debrief that
  has reached `status = 'debrief'` is NOT a debrief that may be told where it
  was; `revealed` is the gate. The test that pins this greps an uncalled
  debrief's raw body for the location the citizens were given.

- **A tap is held over the next snapshot, not just painted.** `handlePoll()`
  replaces `you` wholesale, so a poll already in flight when a player taps
  answers with the state from *before* the tap and lands after it. Without
  `pendingBallot` / `pendingCall` (the same shield `pendingSettings` gives the
  host's steppers) a changed ballot or a retracted call visibly snaps back to
  the old answer, which reads as the game ignoring the player. Each clears the
  moment the server agrees, and a ballot is a LIST, so "the server agrees" is
  `sameAnswer()` comparing element by element rather than `===`.

Accepted limits: anyone holding a room code can take over a seat whose phone
has been quiet for 20 seconds (there is no per-seat secret to prove ownership
with) **and becomes that player: its role, its location while a round is
running, and its ballot while the vote is open**. Nobody can join once roles
are dealt, and there is no rate limit on `create`/`join` beyond the caps.

The one thing reclaim can NOT do is read the location during a debrief the host
has not called yet, which is `cardIsLive()` in the controller. That window is
when phones go down and seats go quiet, so it was the one where the leak paid:
a spy could take a citizen's seat, read the place, and "guess" it out loud to
steal a round they had already lost. Everything else about the reclaim leak is
still open, and it is still the thing worth fixing first.
