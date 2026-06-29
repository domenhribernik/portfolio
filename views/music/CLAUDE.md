# views/music

Guitar backing tracks app with three screens sharing one retro tape-deck design system:

- `index.html`: the player (tracklist, wavesurfer decks, synced chord/lyrics songbook)
- `editor/`: chord + lyrics sync editor (timeline tapping, word anchoring, import/export)
- `analysis/`: MP3 upload, Python-powered musical analysis, library of saved runs

## Styling contract

`style.css` here is the shared design system: palette vars, `.screen-nav`, `.chordsheet`, and the `.panel` / `.field` / `.btn-flat` / `.btn-mini` / `.status-line` primitives. Both subpages link it (plus `base-style.css`) before their own `style.css`, which holds only page-specific pieces. Subpages reach the repo root with `../../../` paths. wavesurfer.js 6.6.3 (CDN) powers the player decks and the editor timeline.

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
- A chord event is "active" from its `time` until the next event. Chord name `N.C.` (also `NC`, `-`) is an explicit gap: the player badge shows an em-dash-style `—` and nothing is highlighted.
- **Player rendering of events:** anchored chords render above their word. Runs of *unanchored* chords render as `.cs-instrumental` rows (assumed instrumental passages), inserted after the last anchored line that precedes them in time; an explicit gap event ends a run. Between two *consecutive* anchored events the word highlight interpolates linearly with playback time (karaoke sweep, see `updateWordSweep`); a run of unanchored events between two anchors suppresses the sweep for that stretch by design.
- The player fetches sync data lazily on first deck open: 404 renders the empty state linking to `editor/?track=<key>`; a network error renders an "offline" note instead.
