# views/music

Guitar backing tracks app with three screens sharing one retro tape-deck design system:

- `index.html`: the player (tracklist, wavesurfer decks, synced chord/lyrics songbook)
- `editor/`: chord + lyrics sync editor (timeline tapping, word anchoring, import/export)
- `analysis/`: MP3 upload, Python-powered musical analysis, library of saved runs

## Styling contract

`style.css` here is the shared design system: palette vars, `.screen-nav`, `.chordsheet`, and the `.panel` / `.field` / `.btn-flat` / `.btn-mini` / `.status-line` primitives. Both subpages link it (plus `base-style.css`) before their own `style.css`, which holds only page-specific pieces. Subpages reach the repo root with `../../../` paths. wavesurfer.js 6.6.3 (CDN) powers the player decks and the editor timeline, both created with `backend: 'MediaElement'`: the 50/75/90/100% practice speed control relies on the media element's pitch preservation, so do NOT switch back to the WebAudio backend (rate changes would detune the song). The `ready` handlers also set `preservesPitch` explicitly.

**MediaElement event-order gotcha:** with this backend, `'ready'` fires on the media element's `canplay`, while `'loading'` progress events come from a *separate* full-file fetch used only to draw the waveform, so `'loading'` routinely fires *after* `'ready'` (and `'error'` can fire for a failed waveform decode while playback works fine). Any spinner/disabled-state driven by `'loading'` or `'error'` must bail out once the player is ready (see the `isLoaded` guards in the player's handlers) or the UI wedges in a permanent loading state.

## Chord cards, tabs, suggestions

- [chord-card.js](chord-card.js) (plain script, loaded by all three screens before their `script.js`) renders a popover with an SVG fretboard diagram and a Karplus-Strong strum via Web Audio. It is **fully local**: open voicings for common chords plus movable E/A barre shapes for every other root. Clickable chord elements get a `data-chord-anchor` attribute (the card's outside-click dismissal depends on it). API: `ChordCard.show(name, anchorEl)`, `.parse(name)`, `.findVoicing(pc, quality)`.
- Tab links come from [app/proxys/tabs-proxy.php](../../app/proxys/tabs-proxy.php) (Songsterr search, 30-day cache in `app/cache/tabs-cache.json`); the player prefetches per track on first deck open and shows a "Tab" button only on a hit.
- The editor's "next chord ideas" strip is a local theory engine (key inference over the chords used, then degree-transition lookups), not an API call.
- **Dead/blocked APIs, do not retry:** Uberchord (`api.uberchord.com`) is dead (no HTTP response, service shut down) and the Scales-Chords embed JS returns 403 server-side. That is why diagrams and chord sounds are implemented locally. Hooktheory's API requires an account (no credentials in `.env`), hence the local suggestion engine.

## Backend

- Controller: [app/controllers/music-controller.php](../../app/controllers/music-controller.php), `?resource=sync` (chord/lyrics CRUD) and `?resource=analysis` (audio upload -> Python -> JSON, optional DB save via `save=0/1` POST field). Accepted uploads: `.mp3`, plus `.webm/.ogg/.m4a/.mp4/.wav` for the analysis page's in-browser mic recordings (MediaRecorder output varies by browser); each format is magic-byte sniffed. The audio file itself is never persisted, only the result JSON.
- Tables: [app/models/music-model.sql](../../app/models/music-model.sql) (`music_sync`, `music_analyses`). Run manually via phpMyAdmin like all models.
- Analyzer: [app/scripts/analyze_audio.py](../../app/scripts/analyze_audio.py), invoked by the controller through `exec()`. Decodes via the system `ffmpeg` binary, all DSP is plain numpy (no librosa). Analyzes the first 180s. Every stage is wrapped independently: failed stages return `null` plus an entry in `warnings`, so partial results still render.
- The controller sets `serialize_precision=-1`; without it PHP re-encodes the analyzer's floats as `87.900000000000006`.

## Data contract (the part that bites)

- `track_key` = `"<category>/<file>"` exactly as listed in `assets/music/tracks.json`, e.g. `acoustic/Wonderwall - Oasis.mp3`. The PHP side validates `^(acoustic|electric)/...\.mp3$`.
- `chords` JSON: `[{ "time": 12.4, "chord": "Am", "line": 2, "word": 3 }]`, kept sorted by time. `line`/`word` are optional 0-based anchors into the lyrics, where lines = `lyrics.split('\n')` and words = `line.split(/\s+/).filter(Boolean)`. Player and editor must keep using that exact tokenization or anchors drift.
- `words` JSON (word syncs from the editor's Sync tab): `[{ "time": 13.1, "line": 2, "word": 4 }]`, chord-less timestamps for single words, sorted by time. The API exposes `chords` and `words` as separate arrays, but the DB stores both in the single `chords` column: a plain array when there are no word syncs (legacy rows) or an `{ "events": [...], "words": [...] }` envelope once there are. Only `formatSync()`/`saveSync()` in the controller may know about the envelope.
- A chord event is "active" from its `time` until the next event. Chord name `N.C.` (also `NC`, `-`) is an explicit gap: the player badge shows an em-dash-style `—` and nothing is highlighted.
- **Player rendering of events:** anchored chords render above their word. Runs of *unanchored* chords render as `.cs-instrumental` rows (assumed instrumental passages), inserted after the last anchored line that precedes them in time; an explicit gap event ends a run. Word syncs are invisible in the player; they only feed the sweep.
- **Karaoke sweep (`updateWordSweep`):** the sweep runs over a unified, time-sorted list of *anchors* = anchored chord events + word syncs. Between two consecutive anchors moving forward through the text the highlight interpolates linearly, so densely word-synced passages don't guess at all. An anchor with no forward successor sweeps out the rest of its own line: to the time of the next unanchored chord event (instrumental/gap) when one interrupts first, or at the song's average words-per-second pace for the final anchor; `releases[k]` records when anchor k's highlight must be dropped. Nothing sweeps during an unanchored run itself.
- The player fetches sync data lazily on first deck open: 404 renders the empty state linking to `editor/?track=<key>`; a network error renders an "offline" note instead.

## Editor specifics

- **Timeline zoom:** the zoom buttons multiply wavesurfer's px-per-second (`applyZoom`, 1x-8x); the wave then scrolls horizontally, which requires `hideScrollbar: false` in the editor's WaveSurfer config. `#markers` is the `.editor-markers__rail`: when zoomed, its width is set to the wave wrapper's `scrollWidth` and it is translated by `-scrollLeft` (`syncMarkerRail`) so the percentage-positioned flags stay glued to the wave. Breaking that sync makes marker flags drift from their spot on the waveform. `loadTrack` resets zoom (and practice speed) before loading, otherwise the new track inherits the old `minPxPerSec`.
- **Lyrics panel modes:** Edit (textarea) / Anchor (pin selected chord to a word) / Sync (tap words to stamp them at the playhead). In Sync mode, Enter stamps the outlined "next" word (`syncNext`), clicking a stamped word again without moving the playhead removes it, and `syncHistory` backs the Undo button. Number keys 1-0 tap the first ten `QUICK_CHORDS` at the playhead in any mode.
- **Docked transport bar:** `#transportBar` (back 5s / play / forward 5s) is fixed full-width at the viewport bottom with an opaque background; `body.has-transport` reserves its height via `.music-app` bottom padding so it never overlaps content. Keep it to those three buttons.
