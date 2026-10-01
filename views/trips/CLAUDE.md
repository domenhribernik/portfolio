# views/trips

Travel photo albums on a map: a trip is a line, a place is a station on it,
each station holds photos pinned where they were taken. Open to anyone signed
in; signed-out visitors see the one showcase trip read-only. Backend:
`app/controllers/trips-controller.php`, `app/services/trips-service.php`,
schema `app/models/trips-model.sql`. Tests: `tests/trips-logic.test.mjs`,
`tests/trips-controller.test.php`. Visual world and its rules: the surface
brief, `.impeccable/surfaces/views-trips.md`.

## Rules that bite

- **Photos are never public files.** They live in `assets/uploads/trips/`,
  which `ImageService::protectFolder()` denies to the web with a `.htaccess`
  written at runtime (the folder is gitignored and outside the deploy, so a
  committed one would never arrive). Bytes go out only through
  `?resource=photo`, after the same access check as the trip. The shared
  `images-controller.php` treats `trips` as a `PRIVATE_FOLDERS` entry: it must
  not list, rename or delete them. Do not add a direct `assets/uploads/trips/`
  URL anywhere.
- **Every delete goes through `TripsService`.** A photo is one `trips_photos`
  row plus two `images` rows plus two files, and the foreign keys cascade from
  `images` to the photo, not the other way. A plain `DELETE FROM trips` strands
  the images rows and the files. Account deletion calls
  `TripsService::purgeUser()` before `DELETE FROM users` for the same reason.
- **Creates are idempotent by the phone's uuid, and deletes leave tombstones.**
  The offline outbox retries until it hears back. A replay returns the existing
  row (200), a deleted uuid returns 410, and nothing is ever processed twice.
  Keep that order in any new create: tombstone, replay, parent, then work.
- **Every `(status, code)` the controller sends needs an outcome** in
  `classifyResponse()` and the `OUTCOMES` table in the logic test. A drift test
  fails otherwise. Add the code there when you add a `sendError`.
- **The service worker's `SHELL` must list every module `script.js` imports**,
  including the cross-view ones (`../nebo/geo.js`). A drift test walks the
  import graph. Bump `trips-shell-vN` when the list changes.
- **No Tailwind here, deliberately.** The page must open offline and the CDN
  cannot. Fonts come from `assets/fonts/fonts.css` and are precached.
- **Leaflet lives in `lib/`, never `vendor/`** (gitignored and skipped by the
  deploy, which once shipped trails without its map).
- **Marker icons must not get `position: relative`.** Leaflet positions
  `.leaflet-marker-icon` absolutely; a relative override drops every marker
  into normal flow, each pushed down by the ones before it.
- **Invite links live in the URL fragment** (`#join=<token>`), never the query
  string: analytics records the full query string. The token is stashed in
  `sessionStorage` across sign-in.
- **Station steps, the map/grid toggle and the next photo use
  `history.replaceState({...history.state}, ...)`**; real screen changes set
  `location.hash`. That split is what lets `back-link.js` walk the screens.

## Location of a photo

`resolvePhotoLocation()` in `logic.js`: the photo's own EXIF GPS, else where
the phone is now if the photo was just taken (and the fix is fresh and tight),
else the place's own pin with `loc_source = 'place'`, shown as approximate.
Mobile pickers strip GPS (Android 13+, iOS unless opted in), so the fallback is
the common case, not the edge. `'manual'` is set when someone moves a pin.
