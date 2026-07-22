-- Dashboard launcher tiles (formerly "hub"). The shelf is personal: a user
-- sees a tile only when they PICKED it (a dashboard_user_apps row) AND they
-- are permitted to see it (tile with project_id NULL is permitted to any
-- signed-in user; a gated tile needs a role in that project; site admins are
-- permitted everything). Admins mark tiles is_default: those are seeded onto
-- the shelf of every NEW user at signup (even gated ones; the row lies
-- dormant until a role arrives). Existing users are never backfilled. The
-- Dashboard is navigation, not a security boundary: every target view
-- enforces its own auth.
--
-- Per-user layout: each user arranges their own shelf. dashboard_folders are
-- one level deep and per user; dashboard_user_apps carries folder_id (which
-- folder the app lives in, NULL = the root grid) and position (order within
-- its container). The admin-controlled dashboard_apps.sort_order is demoted
-- to catalog order: it orders the picker and decides where a freshly picked
-- tile first lands, but the per-user layout always wins on the shelf.
--
-- Run manually in phpMyAdmin. Safe to re-run (MariaDB: ADD COLUMN IF NOT
-- EXISTS; the rename in section 1 is a one-time step, skip it once the
-- dashboard_* tables exist).

-- ------------------------------------------------------------------
-- 1. One-time rename from the old "hub_*" tables (data survives).
--    Skip this whole section if hub_apps no longer exists (fresh DBs and
--    any DB already migrated fall through to the idempotent section 2).
-- ------------------------------------------------------------------
RENAME TABLE hub_apps TO dashboard_apps, hub_user_apps TO dashboard_user_apps;

-- ------------------------------------------------------------------
-- 2. Idempotent schema (the fresh-DB path, and the catch-up for columns
--    the rename did not add).
-- ------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS dashboard_apps (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    icon VARCHAR(100) NOT NULL DEFAULT 'fa-solid fa-cube',
    gradient VARCHAR(255) NOT NULL DEFAULT 'linear-gradient(45deg, #d4451f 0%, #f2b705 100%)',
    url VARCHAR(255) NOT NULL,
    sort_order INT NOT NULL DEFAULT 0,
    project_id INT DEFAULT NULL,
    active TINYINT NOT NULL DEFAULT 1,
    is_default TINYINT NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_dashboard_apps_sort (active, sort_order),
    CONSTRAINT fk_dashboard_apps_project FOREIGN KEY (project_id)
        REFERENCES projects(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Older databases predate is_default; the rename carries the old schema over.
ALTER TABLE dashboard_apps ADD COLUMN IF NOT EXISTS is_default TINYINT NOT NULL DEFAULT 0;

-- One level of per-user folders. A folder holds tiles the user filed into it;
-- ON DELETE SET NULL on the app rows means a dissolved folder drops its apps
-- back to the root grid rather than losing them.
CREATE TABLE IF NOT EXISTS dashboard_folders (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    name VARCHAR(60) NOT NULL,
    position INT NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_dashboard_folders_user (user_id, position),
    CONSTRAINT fk_dashboard_folders_user FOREIGN KEY (user_id)
        REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row = one tile a user chose to show on their shelf. Presence, plus the
-- user's own placement: folder_id (NULL = root grid) and position (order
-- within its container). Rows for tiles the user is not (or no longer)
-- permitted to see are harmless: the shelf query filters by permission, so
-- they lie dormant and pop back in if a role is granted.
CREATE TABLE IF NOT EXISTS dashboard_user_apps (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    app_id INT NOT NULL,
    folder_id INT DEFAULT NULL,
    position INT NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_dua_user_app (user_id, app_id),
    INDEX idx_dua_app (app_id),
    INDEX idx_dua_folder (folder_id),
    CONSTRAINT fk_dua_user FOREIGN KEY (user_id)
        REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_dua_app FOREIGN KEY (app_id)
        REFERENCES dashboard_apps(id) ON DELETE CASCADE,
    CONSTRAINT fk_dua_folder FOREIGN KEY (folder_id)
        REFERENCES dashboard_folders(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Catch-up for databases migrated from the old hub_user_apps (which had
-- neither column). The FK is added separately so a re-run does not choke on
-- an already-present constraint (wrapped so re-runs are harmless).
ALTER TABLE dashboard_user_apps ADD COLUMN IF NOT EXISTS folder_id INT DEFAULT NULL;
ALTER TABLE dashboard_user_apps ADD COLUMN IF NOT EXISTS position INT NOT NULL DEFAULT 0;
ALTER TABLE dashboard_user_apps ADD INDEX IF NOT EXISTS idx_dua_folder (folder_id);
-- Add the folder FK only if it is missing. MariaDB has no "ADD CONSTRAINT IF
-- NOT EXISTS"; run this line once and ignore a duplicate-key error on re-run.
ALTER TABLE dashboard_user_apps
    ADD CONSTRAINT fk_dua_folder FOREIGN KEY (folder_id)
        REFERENCES dashboard_folders(id) ON DELETE SET NULL;

-- ------------------------------------------------------------------
-- 3. Register the linked projects if missing (auth-model.sql seed pattern).
-- ------------------------------------------------------------------
INSERT INTO projects (project_key, name) VALUES
    ('botaniq',   'Botaniq'),
    ('sourdough', 'Sourdough'),
    ('list',      'Lists'),
    ('vrata',     'Vrata')
ON DUPLICATE KEY UPDATE name = name;

-- ------------------------------------------------------------------
-- 4. Seed tiles. INSERT ... SELECT resolves project ids by key at run time;
--    UNIQUE(name) makes re-runs no-ops. Urls are root-relative: the frontend
--    resolves them against the site root, so they work whether the site is
--    served at / or under /portfolio/.
-- ------------------------------------------------------------------
INSERT INTO dashboard_apps (name, icon, gradient, url, sort_order, project_id)
SELECT 'Botaniq', 'fa-solid fa-leaf',
       'linear-gradient(45deg, #2d6a4f 0%, #74c69d 100%)', '/views/botaniq/', 10, p.id
FROM projects p WHERE p.project_key = 'botaniq'
ON DUPLICATE KEY UPDATE dashboard_apps.name = dashboard_apps.name;

INSERT INTO dashboard_apps (name, icon, gradient, url, sort_order, project_id)
SELECT 'Sourdough', 'fa-solid fa-bread-slice',
       'linear-gradient(45deg, #b8371a 0%, #f2b705 100%)', '/views/sourdough/', 20, p.id
FROM projects p WHERE p.project_key = 'sourdough'
ON DUPLICATE KEY UPDATE dashboard_apps.name = dashboard_apps.name;

INSERT INTO dashboard_apps (name, icon, gradient, url, sort_order, project_id)
SELECT 'Lists', 'fa-solid fa-list-check',
       'linear-gradient(45deg, #1f35e0 0%, #4facfe 100%)', '/views/list/', 30, p.id
FROM projects p WHERE p.project_key = 'list'
ON DUPLICATE KEY UPDATE dashboard_apps.name = dashboard_apps.name;

INSERT INTO dashboard_apps (name, icon, gradient, url, sort_order, project_id)
SELECT 'Vrata', 'fa-solid fa-door-open',
       'linear-gradient(45deg, #1c1a17 0%, #6b6256 100%)', '/views/vrata/', 40, p.id
FROM projects p WHERE p.project_key = 'vrata'
ON DUPLICATE KEY UPDATE dashboard_apps.name = dashboard_apps.name;
