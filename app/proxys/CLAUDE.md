# app/proxys

External API proxies (to hide API keys from the client) and small server-side endpoints.

Anything here that authenticates by cookie must **not** send `Access-Control-Allow-Origin: *`
(invalid with credentials, and dangerous). All consumers are same-origin.

## The catalogue

| File | What it does |
|---|---|
| `apod-proxy.php` | NASA Astronomy Picture of the Day |
| `otd-proxy.php` | On This Day |
| `tabs-proxy.php` | Songsterr tab search for [views/music](../../views/music/); Songsterr has no CORS. 30-day cache in `app/cache/tabs-cache.json` |
| `stats-proxy.php` | Codebase line/file counts for the homepage stat |
| `vrata.php` | Backend for the private `vrata` door/camera tool |
| `tarok.php`, `flowers.php` | Share-link stores for the tarok scorekeeper and the flowers bouquets |
| `download.php` | Backend for the unlisted [views/download](../../views/download/) ripper |
| `contact.php` | Public homepage contact form |
| `store.php` | Everbloom founding waitlist for [views/store](../../views/store/) |

## Per-endpoint notes worth knowing before you edit

**`stats-proxy.php`** excludes dev tooling (`.claude/`, `tests/`, `tools/`) so the public
number means "code the site is built from". It is cached **per day AND per counting-rules
version**, so changing the rules corrects the public number on the first request after
deploy instead of waiting out the day. Bump the version stamp when you change what counts.

**`tarok.php` / `flowers.php`** store each item as a JSON file under `app/cache/<name>/`
and prune anything older than 7 days on every save. **No auth**, share links are public
by design.

**`download.php`** shells out to yt-dlp/ffmpeg, writing media plus JSON sidecars to
`app/cache/download/`, pruned after 3 hours. That directory **must pre-exist
world-writable**: Apache's daemon user cannot create directories under `app/cache/`.

**`contact.php`** validates a POSTed name/email/message mirroring
`views/homepage/contact-logic.js`, stores a durable row in `contact_messages`, and fires a
best-effort Telegram alert via `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`. No auth; a
hidden `website` honeypot silently drops bots. Delivery is **intentionally
Telegram-not-email**, the host has no MTA. Page logic:
`views/homepage/contact-form.js`.

**`vrata.php`**'s `snapshot` action captures a still server-side because the Tesla browser
only paints video while parked. **Tuya allocates the HLS URL on port 8080, and prod's
egress firewall refuses it**, so a capture that works locally can fail on the server with
what looks like a broken ffmpeg. The `diag` action (same auth as the rest, POST
`{"action":"diag"}`) reports DNS, both TCP probes, both curl fetches and the ffmpeg
version separately, which is the only way to tell those apart on a host with no shell.
Do **not** reach for Tuya's `/v1.0/cameras/{id}/actions/capture` as a way around it: it
returns a command `sn` and delivers the image asynchronously over Pulsar, which needs a
long-lived consumer on a nonstandard port (7285) that the same firewall blocks.

**`store.php`** mirrors the `contact.php` shape (honeypot, Telegram alert), one row per
email in `store_waitlist` upserted on duplicate, plus `GET ?action=count` for the
storefront's founding-spots line.

## Privacy convention

Endpoints that record a submitter's IP store only `ip_hash` (daily-salted sha256), never a
raw address, and never return it to any client. Precedents: `contact_messages`,
`store_waitlist`, `pricing_quotes`.

## Tests

`flowers-share.test.php`, `download.test.php`, `stats-proxy.test.php`, `contact.test.php`,
`vrata.test.php`. See [tests/CLAUDE.md](../../tests/CLAUDE.md).
