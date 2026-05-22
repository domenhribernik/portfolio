# Presence — Technical Build Plan

A private, unlisted single-page tool at `views/presence/` for tracking daily effort in a long-distance relationship, inspired by *No More Mr. Nice Guy*. PHP + MySQL backend, vanilla JS + Tailwind frontend, no build step.

> **Working name:** `presence`. If the owner picks a different name, find-and-replace `presence` everywhere (directory, table prefix, controller filename, fetch URLs).

---

## 1. Constraints & conventions (read before coding)

- Follow [CLAUDE.md](CLAUDE.md) at the repo root strictly.
- **Do NOT** register this project in [components/project-data.js](components/project-data.js) or add a `<project-card>` to [index.html](index.html). It is intentionally unlisted.
- **Do NOT** add a link to it in [components/main-navbar.js](components/main-navbar.js).
- Frontend styling: Tailwind via CDN. Only use `style.css` for what Tailwind can't express (keyframes, pseudo-elements, JS-toggled `display: none` defaults, `prefers-reduced-motion`).
- Database access pattern: copy [app/controllers/plants-controller.php](app/controllers/plants-controller.php). Must include `define('SECURE_ACCESS', true);` before requiring `database.php`. Use `Database::read()` and `Database::write()` PDO singletons.
- SQL is run **manually via phpMyAdmin**. Never execute migrations from code. The `.sql` file is the source of truth for the schema.
- All endpoints return JSON. Use the same `sendJson` / `sendError` helpers as plants-controller.
- All user-supplied strings go through a `sanitize()` helper (htmlspecialchars + trim).
- Charts: [Chart.js](https://cdn.jsdelivr.net/npm/chart.js) via CDN. No npm.
- Local dev runs through XAMPP (Apache + MySQL). Without XAMPP running, PHP endpoints will fail — expected.

---

## 2. File map

Create exactly these files. Nothing else.

```
views/presence/
  index.html
  script.js
  style.css
app/models/
  presence-model.sql
app/controllers/
  presence-controller.php
```

No new components, no service layer (logic is simple enough for the controller).

---

## 3. Database schema — `app/models/presence-model.sql`

Four tables. All `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`.

### 3.1 `presence_daily` — one row per calendar day

```sql
CREATE TABLE IF NOT EXISTS presence_daily (
    id INT AUTO_INCREMENT PRIMARY KEY,
    entry_date DATE NOT NULL UNIQUE,

    -- Concrete behaviors. TINYINT: 1 = yes, 0 = no, NULL = not applicable today.
    good_morning TINYINT DEFAULT NULL,
    good_night TINYINT DEFAULT NULL,
    voice_or_video TINYINT DEFAULT NULL,
    unprompted_thinking_of_you TINYINT DEFAULT NULL,
    present_when_we_talked TINYINT DEFAULT NULL,

    -- The honest counter. Lower is better.
    silent_leaves INT NOT NULL DEFAULT 0,

    -- NMMNG reflection fields.
    reflection TEXT DEFAULT NULL,
    covert_contract_noticed TEXT DEFAULT NULL,
    where_i_showed_up TEXT DEFAULT NULL,

    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

### 3.2 `presence_triggers` — many rows per day

```sql
CREATE TABLE IF NOT EXISTS presence_triggers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    entry_date DATE NOT NULL,
    occurred_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    situation TEXT NOT NULL,
    what_i_did TEXT NOT NULL,
    what_i_could_do_next_time TEXT DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_entry_date (entry_date)
);
```

### 3.3 `presence_she_mentioned` — running personal-CRM list

```sql
CREATE TABLE IF NOT EXISTS presence_she_mentioned (
    id INT AUTO_INCREMENT PRIMARY KEY,
    topic VARCHAR(255) NOT NULL,
    detail TEXT DEFAULT NULL,
    mentioned_on DATE NOT NULL,
    follow_up_by DATE DEFAULT NULL,
    followed_up TINYINT NOT NULL DEFAULT 0,
    followed_up_on DATE DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_follow_up_by (follow_up_by, followed_up)
);
```

### 3.4 `presence_weekly` — one row per ISO week

```sql
CREATE TABLE IF NOT EXISTS presence_weekly (
    id INT AUTO_INCREMENT PRIMARY KEY,
    year_week CHAR(7) NOT NULL UNIQUE,  -- e.g. '2026-W21'
    presence_score TINYINT DEFAULT NULL,       -- 1..10
    initiation_score TINYINT DEFAULT NULL,
    consistency_score TINYINT DEFAULT NULL,
    depth_score TINYINT DEFAULT NULL,
    what_she_said_she_needed TEXT DEFAULT NULL,
    where_i_made_her_chase_me TEXT DEFAULT NULL,
    next_week_one_thing TEXT DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

### 3.5 Settings (single-row config)

Use a tiny key/value table so the owner can change her timezone and next visit date from the UI without editing code.

```sql
CREATE TABLE IF NOT EXISTS presence_settings (
    setting_key VARCHAR(64) PRIMARY KEY,
    setting_value VARCHAR(255) NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

INSERT INTO presence_settings (setting_key, setting_value) VALUES
    ('her_timezone', 'Europe/Ljubljana'),    -- IANA tz, owner edits in UI
    ('next_visit_date', ''),                  -- 'YYYY-MM-DD' or empty
    ('last_visit_date', '')
ON DUPLICATE KEY UPDATE setting_value = setting_value;
```

---

## 4. Backend — `app/controllers/presence-controller.php`

One controller, route by `?resource=...&action=...`. Single file, same shape as plants-controller.

### 4.1 Routing table

| Method | resource         | action       | Behavior                                        |
| ------ | ---------------- | ------------ | ----------------------------------------------- |
| GET    | `daily`          | —            | Returns today's row (or empty defaults).        |
| GET    | `daily`          | `range`      | `?days=30` → last N days as array.              |
| POST   | `daily`          | —            | Upserts today's row from JSON body.             |
| GET    | `triggers`       | —            | `?date=YYYY-MM-DD` (default today) → list.      |
| POST   | `triggers`       | —            | Inserts a trigger row.                          |
| DELETE | `triggers`       | —            | `?id=` removes one.                             |
| GET    | `mentioned`      | —            | All rows ordered by `followed_up`, then date.   |
| POST   | `mentioned`      | —            | Create row.                                     |
| POST   | `mentioned`      | `followup`   | `?id=` marks followed_up=1, sets followed_up_on=today. |
| DELETE | `mentioned`      | —            | `?id=` removes one.                             |
| GET    | `weekly`         | —            | `?year_week=YYYY-Www` or current week.          |
| POST   | `weekly`         | —            | Upserts.                                        |
| GET    | `weekly`         | `range`      | `?weeks=12` → last N weeks.                     |
| GET    | `settings`       | —            | All key/values as `{key: value}` object.        |
| POST   | `settings`       | —            | JSON body `{key, value}`. Upserts.              |
| GET    | `metrics`        | —            | Aggregated payload for dashboard (see §4.4).    |

### 4.2 Request/response shape

All POST bodies are JSON (`Content-Type: application/json`). Read with `json_decode(file_get_contents('php://input'), true)`.

`POST /daily` body:
```json
{
  "entry_date": "2026-05-18",   // optional; defaults to today (server local)
  "good_morning": 1,
  "good_night": null,
  "voice_or_video": 0,
  "unprompted_thinking_of_you": 1,
  "present_when_we_talked": null,
  "silent_leaves": 0,
  "reflection": "...",
  "covert_contract_noticed": "...",
  "where_i_showed_up": "..."
}
```
All fields except `entry_date` are optional on each save (the endpoint upserts only the keys present — implement with a dynamic `INSERT ... ON DUPLICATE KEY UPDATE`).

Response: the full row after upsert.

### 4.3 Date / week helpers (PHP)

```php
function todayDate(): string { return (new DateTimeImmutable('now'))->format('Y-m-d'); }
function isoYearWeek(?string $date = null): string {
    $d = new DateTimeImmutable($date ?? 'now');
    return $d->format('o-\WW'); // ISO year + week, e.g. 2026-W21
}
```

### 4.4 `GET metrics` payload

This is the single fetch the dashboard uses on load. Returns:

```json
{
  "today": { ...presence_daily row, with defaults if missing... },
  "last_30_days": [ {entry_date, good_morning, good_night, voice_or_video, unprompted_thinking_of_you, present_when_we_talked, silent_leaves} ... ],
  "last_12_weeks": [ {year_week, presence_score, initiation_score, consistency_score, depth_score} ... ],
  "streaks": {
    "good_morning": 5,
    "good_night": 3,
    "voice_or_video": 0,
    "unprompted_thinking_of_you": 2,
    "present_when_we_talked": 4,
    "no_silent_leave": 7
  },
  "weekly_presence_index": 23,
  "mentioned_open_count": 4,
  "mentioned_overdue_count": 1,
  "trigger_count_last_7_days": 6,
  "settings": { "her_timezone": "...", "next_visit_date": "...", "last_visit_date": "..." }
}
```

**Streak rule per behavior**: longest current run of consecutive days ending on today (or yesterday if today is unrecorded) where the column is `1`. NULL breaks the streak only if today's row exists with NULL; missing rows (truly no entry) break the streak.

**`no_silent_leave` streak**: consecutive days ending today where `silent_leaves = 0` AND the row exists.

### 4.5 Weekly Presence Index formula

For the current ISO week, summed across its days in `presence_daily`:

```
WPI = sum_over_week(
        (good_morning==1) + (good_night==1) + (voice_or_video==1)
        + (unprompted_thinking_of_you==1) + (present_when_we_talked==1)
        - silent_leaves
      )
    + 2 * count(presence_she_mentioned rows where
                 followed_up=1
                 AND followed_up_on BETWEEN week_start AND week_end
                 AND (follow_up_by IS NULL OR followed_up_on <= follow_up_by))
```

NULL behavior values count as 0 (not applicable, not credit). Compute server-side, return as `weekly_presence_index`.

### 4.6 Security

- All writes use prepared statements with bound params (PDO).
- Sanitize all text inputs with `sanitize()` before storage.
- No auth in v1 — relies on URL being unlisted. If owner later wants a passcode, add a thin session-based gate as a separate step (out of scope for this build).

---

## 5. Frontend — `views/presence/`

### 5.1 `index.html` skeleton

- Standard `<head>` with viewport meta, FontAwesome CDN, Google Fonts, Tailwind CDN, Chart.js CDN.
- Inline `tailwind.config = { ... }` setting a calm palette (e.g. ink/charcoal background, warm muted accents — not the candy gradients used on the public homepage; this is a private, quiet tool).
- Import shared modules with `../../` paths if any (probably none — this view is fully standalone).
- Body structure (each section is a `<section>` with an `id`):

```
<header>           Title, current date, her local time, days-to-next-visit, days-since-last-visit, last-contact
<section id="her-right-now">     The "Her right now" strip (always visible at top, computed live in JS)
<section id="today">             Today: 5 behavior toggles, silent_leaves stepper, 3 reflection textareas
<section id="she-mentioned">     Quick-add input + list of open items (overdue items flagged)
<section id="triggers">          Quick-add form + today's trigger list
<section id="weekly-review">     Shown only Sun/Mon: 4 sliders + 3 textareas, save button
<section id="metrics">           Headline WPI number + 4 charts + streak grid
<section id="settings">          Hidden behind a small gear toggle: timezone, next_visit_date, last_visit_date
```

All sections are visible on one scrolling page (no SPA routing). Each section a `<section class="...">` with Tailwind-styled card UI.

### 5.2 Behavior toggle UI

Each of the 5 behaviors renders as a 3-state pill: ✓ (1) / ✗ (0) / — (NULL). Clicking cycles. Color: green / red / gray. Auto-save on change (debounced 500ms).

### 5.3 Reflection prompts (rotating)

`reflection` textarea placeholder cycles daily, deterministic by `entry_date` hash → index modulo array length. Array (hard-code in `script.js`):

```js
const NMMNG_PROMPTS = [
  "Where did I make her work to feel close to me today?",
  "What did I want from her today that I didn't ask for directly?",
  "When she reached out, did I receive her or manage her?",
  "Did I do the bare minimum and call it effort?",
  "What did I do today only because I'd feel guilty otherwise?",
  "If she described today to a friend, what would she say about me?",
  "Whose approval was I chasing — hers, mine, or someone else's?",
  "Where did I abandon myself to keep the peace?",
  "What truth did I soften today that she deserved straight?",
  "Did I show up as a partner or as a project manager?",
];
```

`covert_contract_noticed` placeholder: a fixed line — *"Did I do something 'nice' today expecting an unspoken return? Name it."*
`where_i_showed_up` placeholder: *"One thing — however small — that you did right today."*

### 5.4 "Her right now" strip

Computed in JS using `Intl.DateTimeFormat('en-GB', { timeZone: settings.her_timezone, hour: '2-digit', minute: '2-digit' })`. Refresh every 30s with `setInterval`.

Shows:
- `Her time: 14:23`
- `Next visit: in 12 days` (or `not scheduled`)
- `Last visit: 18 days ago` (or `—`)
- `Last contact: 3h ago • Last call: 2d ago` (computed from `presence_daily` rows — last day with any behavior=1 / last day with `voice_or_video=1`)

### 5.5 Metrics section — exactly these visualizations

1. **Headline number**: Weekly Presence Index (big), with the formula breakdown visible on hover.
2. **30-day behavior heatmap**: 5 rows (behaviors) × 30 cols (days). Each cell: green=1, red=0, gray=null, faintest gray=no entry. Pure HTML grid (`grid-cols-30`) — no Chart.js needed.
3. **Weekly score line chart**: Chart.js line chart, 4 lines (presence/initiation/consistency/depth), last 12 weeks on x-axis.
4. **Streak grid**: 6 cards (one per behavior + `no_silent_leave`) with big number + label.
5. **Trigger bar chart**: Chart.js bar chart, triggers per day over last 14 days. Caption beneath: *"Going up early on is a good sign — you're noticing more."*

### 5.6 `script.js` module structure

Single file, ES module (`<script type="module" src="script.js"></script>`).

```
config: API_BASE = '../../app/controllers/presence-controller.php'
state:  { today, settings, metrics, mentioned, triggers }

api.*  — thin fetch wrappers (getMetrics, saveDaily, addTrigger, ...).
render.* — one function per section that reads state and updates DOM.
handlers.* — event handlers wired in init().

init():
  1. fetch metrics (single call) + mentioned + triggers in parallel
  2. populate state
  3. render all sections
  4. wire event handlers
  5. start the 30s tick for "her right now"

debounce(saveDaily, 500ms) for auto-save on behavior/text changes.
After every mutating call, refetch metrics (single endpoint refreshes everything).
```

### 5.7 `style.css` — only what Tailwind can't do

- `@keyframes prompt-fade` for the rotating placeholder transition.
- `::before` content for the section headers (small marker).
- `.toggle-state-null` etc. if pseudo-element decoration is needed for the 3-state pill.
- Print styles: hide the trigger input, keep the metrics readable.
- `@media (prefers-reduced-motion: reduce)` to disable the placeholder fade.

That should be ~40 lines max.

---

## 6. Build order (with checkpoints)

Each step ends with a manual smoke test before moving on.

1. **Create the empty view skeleton** — `views/presence/{index.html,script.js,style.css}` with Tailwind + Chart.js CDNs wired. Load it in the browser at `http://localhost/portfolio/views/presence/` and confirm a blank styled page renders.
2. **Write `app/models/presence-model.sql`** with all five `CREATE TABLE` statements + the settings seed `INSERT`. Run it manually in phpMyAdmin. Confirm tables exist.
3. **Build `presence-controller.php`** — start with just the `daily` and `metrics` endpoints. Hit them via browser/curl. Confirm JSON returns.
4. **Today section (vertical slice)** — render 5 behavior toggles + 3 textareas + silent-leaves stepper. Wire to `POST /daily`. Reload page; values persist. **First real win.**
5. **`presence_she_mentioned` endpoints + UI** — quick-add input, list with "mark followed up" / "delete" buttons. Overdue rows get a red dot. This is the highest-impact feature; get it working early.
6. **Triggers** — endpoints + quick-add form + today's list.
7. **Weekly review** — endpoints + section. Only render the form if today is Sunday or Monday (`new Date().getDay() === 0 || 1`); otherwise show last week's saved review as read-only.
8. **"Her right now" strip** — settings GET/POST + the live clock + visit countdown.
9. **Metrics section** — heatmap (HTML grid), streak cards, then the two Chart.js charts. WPI headline last.
10. **Polish pass** — empty states, error toasts, mobile layout check, `prefers-reduced-motion` honoring.

---

## 7. Done criteria

The build is complete when **all** are true:

- [ ] Page loads at `http://localhost/portfolio/views/presence/` with no console errors.
- [ ] All five tables exist in the database with the seed settings row.
- [ ] Toggling a behavior auto-saves within ~500ms; reloading the page shows the saved state.
- [ ] Logging a trigger appears in the list immediately and is persisted across reload.
- [ ] Adding a "she mentioned" item with a `follow_up_by` date shows it in the list; marking it followed up moves it to the "done" group; an overdue item is visually flagged.
- [ ] On a Sunday/Monday the weekly review form is editable; on other days it shows last week's review read-only.
- [ ] The "Her right now" clock updates every 30 seconds and uses the timezone from `presence_settings`.
- [ ] The 30-day heatmap, streak grid, and both Chart.js charts render with real data.
- [ ] The Weekly Presence Index headline matches a hand-computed value from the database.
- [ ] No entry of the project exists in [components/project-data.js](components/project-data.js), [index.html](index.html), or [components/main-navbar.js](components/main-navbar.js).
- [ ] [CLAUDE.md](CLAUDE.md)'s "Frontend — Page Structure" project list is updated to include `views/presence`.

---

## 8. Out of scope for v1 (do not build)

- Passcode/auth gate.
- Email or browser-push reminders.
- Partner-facing read-only share link.
- Mobile app or PWA install.
- Exporting/importing data.
- Multi-relationship support.

These are deliberately deferred so v1 ships and gets used.
