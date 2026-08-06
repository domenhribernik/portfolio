-- Adds the Stocks (Borza LJSE), Iliana and Nebo tiles to the Dashboard launcher.
-- Run manually in phpMyAdmin. Safe to re-run: every insert is guarded by url, so a
-- tile that already exists under another name is never duplicated.
--
-- Three layers have to line up for a tile to actually appear, which is why this file
-- touches three tables:
--   projects            the auth registry, what Auth::requireProjectRole() checks
--   dashboard_apps      the launcher's tile pool (icon, gradient, url, audience)
--   dashboard_user_apps the per-user shelf; a tile shows nowhere without a row here

-- ------------------------------------------------------------------
-- 1. Registry rows the gated tiles point at.
--    Already seeded by stocks-model.sql and iliana-photos-model.sql, re-asserted
--    here because a missing row makes the project_id subquery below resolve to
--    NULL, and a NULL-project tile is visible to EVERY signed-in user. For two
--    private tools that is exactly backwards, so do not drop this statement.
-- ------------------------------------------------------------------

INSERT INTO projects (project_key, name) VALUES
    ('stocks', 'Borza LJSE'),
    ('iliana', 'Iliana')
ON DUPLICATE KEY UPDATE name = name;

-- ------------------------------------------------------------------
-- 2. The tiles. Stocks and Iliana carry a project_id so only role holders (and
--    admins, who pass implicitly) may pick them. Nebo is a public view with no
--    gate anywhere, so project_id stays NULL and it is a default shelf tile.
-- ------------------------------------------------------------------

INSERT INTO dashboard_apps (name, icon, gradient, url, sort_order, project_id, is_default)
SELECT 'Borza LJSE', 'fa-solid fa-chart-line',
       'linear-gradient(45deg, #1b4332 0%, #52b788 100%)', '/views/stocks/', 170,
       (SELECT id FROM projects WHERE project_key = 'stocks'), 0 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM dashboard_apps d WHERE d.url LIKE '/views/stocks%')
ON DUPLICATE KEY UPDATE dashboard_apps.name = dashboard_apps.name;

INSERT INTO dashboard_apps (name, icon, gradient, url, sort_order, project_id, is_default)
SELECT 'Iliana', 'fa-solid fa-camera-retro',
       'linear-gradient(45deg, #9d2449 0%, #f4a4bd 100%)', '/views/iliana/', 180,
       (SELECT id FROM projects WHERE project_key = 'iliana'), 0 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM dashboard_apps d WHERE d.url LIKE '/views/iliana%')
ON DUPLICATE KEY UPDATE dashboard_apps.name = dashboard_apps.name;

INSERT INTO dashboard_apps (name, icon, gradient, url, sort_order, project_id, is_default)
SELECT 'Nebo', 'fas fa-moon',
       'linear-gradient(45deg, #0b102a 0%, #2c3e70 100%)', '/views/nebo/', 190,
       NULL, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM dashboard_apps d WHERE d.url LIKE '/views/nebo%')
ON DUPLICATE KEY UPDATE dashboard_apps.name = dashboard_apps.name;

-- Re-assert the flag if a Nebo tile already existed from an earlier seed.
UPDATE dashboard_apps SET is_default = 1 WHERE url LIKE '/views/nebo%';

-- ------------------------------------------------------------------
-- 3. Shelf placement for the two private tiles: the admin only.
--    Each statement recomputes MAX(position) so the tiles land in distinct
--    slots at the end of the shelf; the derived table dodges MySQL error 1093
--    (cannot read the table being inserted into).
-- ------------------------------------------------------------------

INSERT INTO dashboard_user_apps (user_id, app_id, position)
SELECT u.id, a.id,
       COALESCE((SELECT MAX(p.position) FROM (SELECT user_id, position FROM dashboard_user_apps) p
                  WHERE p.user_id = u.id), -1) + 1
FROM users u JOIN dashboard_apps a ON a.url LIKE '/views/stocks%'
WHERE u.email = 'domen.hribernik4@gmail.com'
ON DUPLICATE KEY UPDATE app_id = dashboard_user_apps.app_id;

INSERT INTO dashboard_user_apps (user_id, app_id, position)
SELECT u.id, a.id,
       COALESCE((SELECT MAX(p.position) FROM (SELECT user_id, position FROM dashboard_user_apps) p
                  WHERE p.user_id = u.id), -1) + 1
FROM users u JOIN dashboard_apps a ON a.url LIKE '/views/iliana%'
WHERE u.email = 'domen.hribernik4@gmail.com'
ON DUPLICATE KEY UPDATE app_id = dashboard_user_apps.app_id;

-- ------------------------------------------------------------------
-- 4. Nebo is a default tile, so it goes on every existing active user's shelf.
--    Signup seeding only covers users created after this runs.
-- ------------------------------------------------------------------

INSERT INTO dashboard_user_apps (user_id, app_id, position)
SELECT u.id, a.id,
       COALESCE((SELECT MAX(p.position) FROM (SELECT user_id, position FROM dashboard_user_apps) p
                  WHERE p.user_id = u.id), -1) + 1
FROM users u JOIN dashboard_apps a ON a.url LIKE '/views/nebo%'
WHERE u.is_active = 1
ON DUPLICATE KEY UPDATE app_id = dashboard_user_apps.app_id;
