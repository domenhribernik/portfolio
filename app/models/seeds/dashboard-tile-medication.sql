-- Adds the Medication tile to the Dashboard launcher (views/medication).
-- Run manually in phpMyAdmin. Safe to re-run: the insert is guarded by url, so
-- a tile that already exists under another name is never duplicated.
--
-- Three layers have to line up for a tile to actually appear, which is why this
-- file touches three tables:
--   projects            the auth registry, what Auth::requireProjectRole() checks
--   dashboard_apps      the launcher's tile pool (icon, gradient, url, audience)
--   dashboard_user_apps the per-user shelf; a tile shows nowhere without a row here

-- ------------------------------------------------------------------
-- 1. The registry row the tile points at.
--    Already seeded by medication-model.sql, re-asserted here because a missing
--    row makes the project_id subquery below resolve to NULL, and a
--    NULL-project tile is offered to EVERY signed-in user. For a private
--    medical log that is exactly backwards, so do not drop this statement.
-- ------------------------------------------------------------------

INSERT INTO projects (project_key, name) VALUES ('medication', 'Medication')
ON DUPLICATE KEY UPDATE name = name;

-- ------------------------------------------------------------------
-- 2. The tile. is_default = 0 so it never lands on anyone else's shelf; the
--    project_id means only role holders (and admins, who pass implicitly) can
--    even pick it out of the launcher's picker.
-- ------------------------------------------------------------------

INSERT INTO dashboard_apps (name, icon, gradient, url, sort_order, project_id, is_default)
SELECT 'Medication', 'fa-solid fa-pills',
       'linear-gradient(45deg, #24463f 0%, #a9c0b8 100%)', '/views/medication/', 200,
       (SELECT id FROM projects WHERE project_key = 'medication'), 0 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM dashboard_apps d WHERE d.url LIKE '/views/medication%')
ON DUPLICATE KEY UPDATE dashboard_apps.name = dashboard_apps.name;

-- ------------------------------------------------------------------
-- 3. Shelf placement: the admin only. The derived table recomputes
--    MAX(position) while dodging MySQL error 1093 (cannot read the table being
--    inserted into).
-- ------------------------------------------------------------------

INSERT INTO dashboard_user_apps (user_id, app_id, position)
SELECT u.id, a.id,
       COALESCE((SELECT MAX(p.position) FROM (SELECT user_id, position FROM dashboard_user_apps) p
                  WHERE p.user_id = u.id), -1) + 1
FROM users u JOIN dashboard_apps a ON a.url LIKE '/views/medication%'
WHERE u.email = 'domen.hribernik4@gmail.com'
ON DUPLICATE KEY UPDATE app_id = dashboard_user_apps.app_id;
