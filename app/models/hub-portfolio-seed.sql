-- Registers every PASSION project from components/project-data.js in the
-- auth projects registry (the admin dashboard's projects tab), keeps the hub
-- to the genuinely useful launcher apps only (no academic or professional
-- entries anywhere), marks the default shelf, and assigns those defaults to
-- every existing active user. Run manually in phpMyAdmin. Safe to re-run,
-- with two caveats: section 2 deletes any tile it prunes even if it was
-- re-added by hand in the dashboard, and the backfill at the bottom re-adds
-- default tiles a user has since removed from their shelf. Treat re-runs as
-- a deliberate reset, not a routine step.
--
-- Standalone on purpose: it starts with the same idempotent schema catch-up
-- statements as hub-model.sql, so it works on a database at any state
-- (fresh local scratch, pre-rework prod, or prod after the first version of
-- this file), in either order relative to hub-model.sql.
--
-- Design note: the hub tiles for public passion views deliberately carry
-- project_id NULL even though the projects are now registered below. A tile
-- linked to a project is visible only to role holders, and a brand-new user
-- has no roles at signup, so linked default tiles would sit dormant on every
-- new shelf. NULL-project tiles are visible to any signed-in user, which is
-- what makes the seeded defaults appear for future users with no role
-- grants. The registry rows exist for the dashboard's projects tab and for
-- any future role-gated feature inside those views; only the genuinely
-- gated private tools (Lists, Vrata) keep a project_id on their tile.
--
-- Separate and still pending: list-model.sql (shopping_* to list_* table
-- rename). This file only repairs the hub tile side of that rename.

-- ------------------------------------------------------------------
-- 1. Schema catch-up (idempotent copies of hub-model.sql pieces)
-- ------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS hub_user_apps (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    app_id INT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_hua_user_app (user_id, app_id),
    INDEX idx_hua_app (app_id),
    CONSTRAINT fk_hua_user FOREIGN KEY (user_id)
        REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_hua_app FOREIGN KEY (app_id)
        REFERENCES hub_apps(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE hub_apps ADD COLUMN IF NOT EXISTS is_default TINYINT NOT NULL DEFAULT 0;

-- ------------------------------------------------------------------
-- 2. Prune tiles that are not launcher tools: everything academic and
--    professional, plus the showcase-only passion views (Nebo, IP
--    Locator, Blog). Deleting a tile cascades its hub_user_apps rows.
--    No-ops where the rows never existed.
-- ------------------------------------------------------------------

DELETE FROM hub_apps WHERE url IN (
    '/views/nebo/',
    '/views/ip/',
    '/views/blog/',
    '/views/thesis/',
    'https://www.knjiznica-celje.si/raziskovalne/4202106000.pdf',
    'https://github.com/domenhribernik/fruit_algorithm',
    'https://vitamavric.com',
    'https://gasperstrazisar.com',
    'https://cwcyprus.com',
    'https://ajsapetspa.com'
);

-- ------------------------------------------------------------------
-- 3. Register ALL passion projects in the projects registry (keys match
--    the views/ folder names; existing rows keep their current name).
-- ------------------------------------------------------------------

INSERT INTO projects (project_key, name) VALUES
    ('botaniq',   'Botaniq'),
    ('sourdough', 'Sourdough'),
    ('tarok',     'Tarok'),
    ('workout',   'Workout'),
    ('recipes',   'Recipes'),
    ('flowers',   'Paper Flowers'),
    ('spy',       'Spy Game'),
    ('parlour',   'Drawing Room'),
    ('maze',      'Maze'),
    ('music',     'Backing Tracks'),
    ('ip',        'IP Locator'),
    ('nebo',      'Nebo'),
    ('blog',      'Blog')
ON DUPLICATE KEY UPDATE name = name;

-- ------------------------------------------------------------------
-- 4. Repair the stale shopping-era tile (Todo -> Lists)
-- ------------------------------------------------------------------

INSERT INTO projects (project_key, name) VALUES ('list', 'Lists')
ON DUPLICATE KEY UPDATE name = name;

-- Rename in place unless a 'Lists' tile already exists (hub-model.sql may
-- have seeded one first); the derived table dodges MySQL error 1093.
UPDATE hub_apps
   SET name = 'Lists',
       icon = 'fa-solid fa-list-check',
       gradient = 'linear-gradient(45deg, #1f35e0 0%, #4facfe 100%)',
       url = '/views/list/',
       project_id = (SELECT id FROM projects WHERE project_key = 'list'),
       sort_order = 140
 WHERE name = 'Todo'
   AND NOT EXISTS (SELECT 1 FROM (SELECT name FROM hub_apps) other WHERE other.name = 'Lists');

-- No-op after a successful rename; removes the stale duplicate otherwise.
DELETE FROM hub_apps WHERE name = 'Todo';

-- ------------------------------------------------------------------
-- 5. Repair existing tiles (match by url: names may have drifted)
-- ------------------------------------------------------------------

-- Botaniq and Sourdough are public demo-shaped views now (any signed-in
-- user, no project role), so their tiles must not stay role-gated.
UPDATE hub_apps SET project_id = NULL, sort_order = 10  WHERE url LIKE '/views/botaniq%';
UPDATE hub_apps SET project_id = NULL, sort_order = 20  WHERE url LIKE '/views/sourdough%';
UPDATE hub_apps SET sort_order = 30  WHERE url LIKE '/views/workout%';
UPDATE hub_apps SET sort_order = 40  WHERE url LIKE '/views/recipes%';
UPDATE hub_apps SET sort_order = 50  WHERE url LIKE '/views/tarok%';
UPDATE hub_apps SET sort_order = 60  WHERE url LIKE '/views/flowers%';
UPDATE hub_apps SET sort_order = 70  WHERE url LIKE '/views/spy%';
UPDATE hub_apps SET sort_order = 80  WHERE url LIKE '/views/parlour%';
UPDATE hub_apps SET sort_order = 90  WHERE url LIKE '/views/maze%';
UPDATE hub_apps SET sort_order = 100 WHERE url LIKE '/views/music%';
-- Also covers the Lists tile hub-model.sql seeds when it runs before this file.
UPDATE hub_apps
   SET sort_order = 140,
       project_id = (SELECT id FROM projects WHERE project_key = 'list')
 WHERE url LIKE '/views/list/%';
UPDATE hub_apps SET sort_order = 150 WHERE url LIKE '/views/vrata%';
UPDATE hub_apps SET sort_order = 160 WHERE url LIKE '/views/jeger%';

-- ------------------------------------------------------------------
-- 6. The useful launcher apps (icons and gradients from
--    components/project-data.js). Guarded by url so a same-url tile under
--    another name is never duplicated; UNIQUE(name) catches the rest.
-- ------------------------------------------------------------------

INSERT INTO hub_apps (name, icon, gradient, url, sort_order, project_id)
SELECT 'Recipes', 'fas fa-utensils', 'linear-gradient(45deg, #e0731d 0%, #efe9dd 100%)', '/views/recipes/', 40, NULL FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM hub_apps h WHERE h.url LIKE '/views/recipes%')
ON DUPLICATE KEY UPDATE hub_apps.name = hub_apps.name;

INSERT INTO hub_apps (name, icon, gradient, url, sort_order, project_id)
SELECT 'Tarok', 'fa fa-trophy', 'linear-gradient(45deg, #ff006e 0%, #ff4d4d 100%)', '/views/tarok/', 50, NULL FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM hub_apps h WHERE h.url LIKE '/views/tarok%')
ON DUPLICATE KEY UPDATE hub_apps.name = hub_apps.name;

INSERT INTO hub_apps (name, icon, gradient, url, sort_order, project_id)
SELECT 'Paper Flowers', 'fas fa-spa', 'linear-gradient(45deg, #b13a6e 0%, #f6c1d9 100%)', '/views/flowers/', 60, NULL FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM hub_apps h WHERE h.url LIKE '/views/flowers%')
ON DUPLICATE KEY UPDATE hub_apps.name = hub_apps.name;

INSERT INTO hub_apps (name, icon, gradient, url, sort_order, project_id)
SELECT 'Spy Game', 'fas fa-user-secret', 'linear-gradient(45deg, #b24592 0%, #f15f79 100%)', '/views/spy/', 70, NULL FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM hub_apps h WHERE h.url LIKE '/views/spy%')
ON DUPLICATE KEY UPDATE hub_apps.name = hub_apps.name;

INSERT INTO hub_apps (name, icon, gradient, url, sort_order, project_id)
SELECT 'Drawing Room', 'fas fa-bell', 'linear-gradient(45deg, #42101c 0%, #c9992e 100%)', '/views/parlour/', 80, NULL FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM hub_apps h WHERE h.url LIKE '/views/parlour%')
ON DUPLICATE KEY UPDATE hub_apps.name = hub_apps.name;

INSERT INTO hub_apps (name, icon, gradient, url, sort_order, project_id)
SELECT 'Maze Generator', 'fas fa-puzzle-piece', 'linear-gradient(45deg, #3d5af1 0%, #22d1ee 100%)', '/views/maze/', 90, NULL FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM hub_apps h WHERE h.url LIKE '/views/maze%')
ON DUPLICATE KEY UPDATE hub_apps.name = hub_apps.name;

INSERT INTO hub_apps (name, icon, gradient, url, sort_order, project_id)
SELECT 'Backing Tracks', 'fas fa-music', 'linear-gradient(45deg, #667eea 0%, #56ccf2 100%)', '/views/music/', 100, NULL FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM hub_apps h WHERE h.url LIKE '/views/music%')
ON DUPLICATE KEY UPDATE hub_apps.name = hub_apps.name;

-- ------------------------------------------------------------------
-- 7. The default shelf: the per-user-data apps plus the two most
--    shareable ones. Seeded to every NEW user at signup; editable
--    later per tile in the views/admin dashboard.
-- ------------------------------------------------------------------

UPDATE hub_apps SET is_default = 1
 WHERE url LIKE '/views/botaniq%'
    OR url LIKE '/views/sourdough%'
    OR url LIKE '/views/workout%'
    OR url LIKE '/views/recipes%'
    OR url LIKE '/views/tarok%'
    OR url LIKE '/views/flowers%';

-- ------------------------------------------------------------------
-- 8. One-time backfill: put the default tiles on every EXISTING active
--    user's shelf (signup seeding only covers users created later).
--    Re-running restores defaults a user deliberately removed.
-- ------------------------------------------------------------------

INSERT INTO hub_user_apps (user_id, app_id)
SELECT u.id, h.id
FROM users u
JOIN hub_apps h ON h.is_default = 1
WHERE u.is_active = 1
ON DUPLICATE KEY UPDATE app_id = hub_user_apps.app_id;
