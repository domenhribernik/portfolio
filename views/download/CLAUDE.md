# views/download

YouTube to mp3/mp4 downloader. Unlisted private tool: never register it in
`components/project-data.js`, `index.html`, or the navbar.

Also excluded from the CI upload (`views/download/**` and `app/proxys/download.php` are
in the deploy workflow's `exclude` list), so it is a local-only tool by default.

## Contract

Backend [app/proxys/download.php](../../app/proxys/download.php). **No auth by design.**

It shells out to `yt-dlp`, which must be installed on the host; the install and update
commands are in the proxy's header comment. Where the binary is absent, e.g. the shared
prod host, it answers a clear **503** rather than failing obscurely. Keep that graceful
path when touching the proxy, it is the difference between "this host can't do it" and a
500.

Media plus JSON sidecars land in `app/cache/download/`, pruned after 3 hours. That
directory **must pre-exist world-writable**: Apache's daemon user cannot create
directories under `app/cache/`.

Page logic is [logic.js](logic.js). Backend covered by
[tests/download.test.php](../../tests/download.test.php), which stubs yt-dlp and ffmpeg
entirely, so no network and no real binaries are needed to run it.
