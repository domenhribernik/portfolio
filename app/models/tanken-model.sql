-- Tanken: the live price cache for the German fuel price view (views/tanken).
--
-- Serves app/controllers/tanken-controller.php and app/services/tanken-service.php.
-- Run manually in phpMyAdmin; nothing in this codebase executes SQL on its own.
-- Safe to re-run.
--
-- Deliberately NOT a gated project: there is no `projects` row and no role.
-- Anyone may look up fuel prices, signed in or not, so there is no gate to
-- register and auth-model.sql is not a prerequisite.
--
-- Where the data comes from: the Tankerkoenig API, which republishes the
-- Bundeskartellamt's MTS-K feed under CC BY 4.0. The frontend never touches
-- that API. Everything the page reads is a row in here, written by the
-- service behind the once-a-minute lease in tanken_poll_state.
--
-- PRIVACY: no table here records where a visitor was. A search bumps
-- last_requested_at on the stations it returned and nothing else, so the
-- only trace of a lookup is "somebody was interested in this petrol station
-- recently". Do not add a column for the searched coordinates, an ip_hash or
-- a user_id; none of them is needed to poll prices, and the privacy page
-- says we do not keep them.

-- ---------------------------------------------------------------------------
--  Stations we have seen, and therefore may poll
-- ---------------------------------------------------------------------------
-- Populated from list.php, which is the only call that knows about stations
-- near a point. `uuid` is Tankerkoenig's own station id and is what
-- prices.php takes, so it is the natural primary key; there is no surrogate.
CREATE TABLE IF NOT EXISTS tanken_stations (
    uuid CHAR(36) NOT NULL PRIMARY KEY,
    name VARCHAR(190) NOT NULL DEFAULT '',
    brand VARCHAR(120) NOT NULL DEFAULT '',
    street VARCHAR(190) NOT NULL DEFAULT '',
    house_number VARCHAR(40) NOT NULL DEFAULT '',
    post_code VARCHAR(10) NOT NULL DEFAULT '',
    place VARCHAR(120) NOT NULL DEFAULT '',
    -- DECIMAL rather than FLOAT: these are compared and rendered, never summed,
    -- and 6 places is ~11 cm, far finer than a forecourt needs.
    lat DECIMAL(9,6) NOT NULL,
    lng DECIMAL(9,6) NOT NULL,
    -- The rolling TTL. A station somebody asked about recently is worth an API
    -- call; one nobody has asked about in TANKEN_TRACK_TTL_HOURS is not, and
    -- drops out of the poll rotation without being deleted.
    last_requested_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Round-robin cursor: the poller always takes the ten stalest.
    last_polled_at DATETIME NULL DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_tanken_stations_rotation (last_requested_at, last_polled_at),
    INDEX idx_tanken_stations_bbox (lat, lng)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
--  The current price cache. This is the `current_prices` table of the brief.
-- ---------------------------------------------------------------------------
-- One row per station per fuel, overwritten in place: this is a cache of the
-- present, not a history. (The statistics panel does not read it. That comes
-- from views/tanken/hourly-stats.json, built offline from the archive.)
--
-- price is NULL when the station reports no price for that fuel, which is
-- different from "we have not looked". `status` carries which: a closed
-- station keeps its last price with status 'closed' so the page can show a
-- greyed figure with an honest timestamp instead of a blank row.
CREATE TABLE IF NOT EXISTS tanken_current_prices (
    station_uuid CHAR(36) NOT NULL,
    fuel ENUM('e5','e10','diesel') NOT NULL,
    -- 5,3 fits German pump pricing exactly: 1.789 EUR, tenth-of-a-cent and all.
    price DECIMAL(5,3) NULL DEFAULT NULL,
    status ENUM('open','closed','no prices') NOT NULL DEFAULT 'open',
    -- When the API last told us this, NOT when the row was written. The page
    -- renders it verbatim as "last updated", including when a poll failed and
    -- we are serving something older than we would like.
    observed_at DATETIME NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (station_uuid, fuel),
    CONSTRAINT fk_tanken_prices_station FOREIGN KEY (station_uuid)
        REFERENCES tanken_stations(uuid) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
--  The rate limit, as a table
-- ---------------------------------------------------------------------------
-- Tankerkoenig's free tier allows one request per minute and revokes keys that
-- harvest. Production has no cron (see PRODUCT.md), so the poll rides the page
-- load, which means any number of visitors can arrive at once. This single row
-- is what stops them becoming a burst: a request wins the right to call the API
-- only by winning a conditional UPDATE against it, so concurrency is settled by
-- InnoDB's row lock rather than by hope.
--
-- Exactly one row, id = 1. Do not add more.
CREATE TABLE IF NOT EXISTS tanken_poll_state (
    id TINYINT NOT NULL PRIMARY KEY,
    -- Start both stamps in the past so the very first request may call out.
    last_call_at DATETIME NOT NULL DEFAULT '2000-01-01 00:00:00',
    leased_until DATETIME NOT NULL DEFAULT '2000-01-01 00:00:00',
    last_ok_at DATETIME NULL DEFAULT NULL,
    last_error VARCHAR(255) NULL DEFAULT NULL,
    -- Belt and braces on top of the per-minute lease: a crude daily ceiling so
    -- a clock or lease bug cannot quietly turn into a harvesting pattern.
    calls_today INT NOT NULL DEFAULT 0,
    call_day DATE NULL DEFAULT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO tanken_poll_state (id) VALUES (1)
ON DUPLICATE KEY UPDATE id = tanken_poll_state.id;

-- ---------------------------------------------------------------------------
--  Dashboard tile
-- ---------------------------------------------------------------------------
-- project_id stays NULL on purpose: a public passion view, so a project-linked
-- tile would sit dormant on every shelf waiting for a role that does not exist.
INSERT INTO dashboard_apps (name, icon, gradient, url, sort_order, project_id, is_default)
SELECT 'Tanken', 'fa-solid fa-gas-pump',
       'linear-gradient(45deg, #1f3a5f 0%, #f2b705 100%)', '/views/tanken/', 210,
       NULL, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM dashboard_apps d WHERE d.url LIKE '/views/tanken%')
ON DUPLICATE KEY UPDATE dashboard_apps.name = dashboard_apps.name;

-- Existing users do not get is_default tiles retroactively, so backfill onto
-- the end of each active user's own shelf.
INSERT INTO dashboard_user_apps (user_id, app_id, position)
SELECT u.id, a.id,
       COALESCE((SELECT MAX(p.position) FROM (SELECT user_id, position FROM dashboard_user_apps) p
                  WHERE p.user_id = u.id), -1) + 1
FROM users u JOIN dashboard_apps a ON a.url LIKE '/views/tanken%'
WHERE u.is_active = 1
ON DUPLICATE KEY UPDATE app_id = dashboard_user_apps.app_id;
