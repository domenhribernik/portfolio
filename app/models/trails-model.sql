-- Trails: the cloud copy of recorded flights (views/trails).
--
-- Requires auth-model.sql (users) to have been run first. Run manually in
-- phpMyAdmin; nothing in this codebase executes SQL on its own.
--
-- Deliberately NOT a gated project: there is no `projects` row and no role.
-- Anyone may record a flight, signed in or not. A flight lives in the
-- device's IndexedDB from the moment it is recorded and only reaches these
-- tables if someone signs in, at which point the client uploads its whole
-- history so the flights follow the account onto another device.
--
-- `uuid` is minted on the device before the flight is even flown, and the
-- UNIQUE key on (user_id, uuid) is what makes the sync idempotent: the client
-- re-uploads freely, and a flight that is already here is simply updated
-- rather than duplicated. Nothing on this side ever invents a flight id.
--
-- The track itself is one JSON blob rather than a points table. A ten-hour
-- flight is 8-12 000 fixes, thinned to at most 2500 for upload, and it is
-- always read and written whole; a row per fix would mean thousands of
-- inserts per sync on shared hosting to answer a query nobody makes.

CREATE TABLE IF NOT EXISTS trails_flights (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    uuid CHAR(36) NOT NULL,
    name VARCHAR(120) NOT NULL DEFAULT '',
    started_at DATETIME NOT NULL,
    ended_at DATETIME DEFAULT NULL,
    stats JSON NOT NULL,
    points MEDIUMTEXT NOT NULL,
    point_count INT NOT NULL DEFAULT 0,
    updated_at BIGINT NOT NULL,
    deleted_at DATETIME DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_trails_flights_user_uuid (user_id, uuid),
    INDEX idx_trails_flights_user (user_id),
    INDEX idx_trails_flights_started (user_id, started_at),
    CONSTRAINT fk_trails_flights_user FOREIGN KEY (user_id)
        REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- `updated_at` is the client's own epoch-milliseconds clock, not a DB
-- timestamp: it is the value the merge compares to decide whether an incoming
-- copy is newer than the stored one, so it has to mean the same thing on every
-- device and survive the round trip unchanged.


-- One share per flight. The token is never stored: only its SHA-256, the same
-- way sessions are handled in auth-model.sql, so a database leak cannot be
-- turned into a set of working public links. Re-sharing replaces the row and
-- therefore silently kills the previous link, which the UI says out loud.
CREATE TABLE IF NOT EXISTS trails_shares (
    id INT AUTO_INCREMENT PRIMARY KEY,
    flight_id INT NOT NULL,
    token_hash CHAR(64) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_trails_shares_token (token_hash),
    UNIQUE KEY uq_trails_shares_flight (flight_id),
    CONSTRAINT fk_trails_shares_flight FOREIGN KEY (flight_id)
        REFERENCES trails_flights(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- Dashboard tile. project_id stays NULL on purpose: this is a public passion
-- view, and a project-linked tile would sit dormant on every new shelf until
-- someone granted a role that does not exist. is_default = 1 puts it on new
-- users' shelves via seedDefaultDashboardApps().
INSERT INTO dashboard_apps (name, icon, gradient, url, sort_order, project_id, is_default)
SELECT 'Trails', 'fa-solid fa-plane-up',
       'linear-gradient(45deg, #0a151d 0%, #ff2d78 100%)', '/views/trails/', 210,
       NULL, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM dashboard_apps d WHERE d.url LIKE '/views/trails%')
ON DUPLICATE KEY UPDATE dashboard_apps.name = dashboard_apps.name;

-- Existing users do not get is_default tiles retroactively, so backfill.
-- `position` is per-user shelf order (sort_order lives on dashboard_apps and
-- orders the picker, not the shelf), so append at the end of each user's own
-- shelf. The derived table is MySQL's workaround for reading the table being
-- inserted into.
INSERT INTO dashboard_user_apps (user_id, app_id, position)
SELECT u.id, a.id,
       COALESCE((SELECT MAX(p.position) FROM (SELECT user_id, position FROM dashboard_user_apps) p
                  WHERE p.user_id = u.id), -1) + 1
FROM users u JOIN dashboard_apps a ON a.url LIKE '/views/trails%'
WHERE u.is_active = 1
ON DUPLICATE KEY UPDATE app_id = dashboard_user_apps.app_id;
