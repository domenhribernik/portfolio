-- Adds the Share tile to the Dashboard launcher (views/share), for the admin only.
-- Run manually in phpMyAdmin. Safe to re-run: the insert is guarded by url, so
-- a tile that already exists under another name is never duplicated.
--
-- views/share itself is a PUBLIC page and stays one. What is private here is
-- only the launcher shortcut to it: the Dashboard is navigation, not a security
-- boundary, so this gates who is offered the tile and nothing else.
--
-- Same shape as dashboard-tile-medication.sql, and for the same reason it
-- touches three tables:
--   projects            the auth registry the tile's audience is checked against
--   dashboard_apps      the launcher's tile pool (icon, gradient, url, audience)
--   dashboard_user_apps the per-user shelf; a tile shows nowhere without a row here

-- ------------------------------------------------------------------
-- 1. The registry row the tile points at.
--    This is what makes the tile admin-only. A tile with a project_id is
--    offered to role holders of that project, plus site admins, who pass
--    implicitly. Nobody is granted a share role, so that leaves the admin.
--
--    Do NOT drop this statement. Without the row, the project_id subquery
--    below resolves to NULL, and a NULL-project tile is offered to EVERY
--    signed-in user: exactly the opposite of what this file is for.
--    Granting anyone a role in `share` later widens the tile to them too.
-- ------------------------------------------------------------------

INSERT INTO projects (project_key, name) VALUES ('share', 'Share')
ON DUPLICATE KEY UPDATE name = name;

-- ------------------------------------------------------------------
-- 2. The tile. is_default = 0 so it is never seeded onto a new signup's shelf.
--    Icon and gradient match the share entry in components/project-data.js.
-- ------------------------------------------------------------------

INSERT INTO dashboard_apps (name, icon, gradient, url, sort_order, project_id, is_default)
SELECT 'Share', 'fa-solid fa-qrcode',
       'linear-gradient(45deg, #1f35e0 0%, #d4451f 100%)', '/views/share/', 230,
       (SELECT id FROM projects WHERE project_key = 'share'), 0 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM dashboard_apps d WHERE d.url LIKE '/views/share%')
ON DUPLICATE KEY UPDATE dashboard_apps.name = dashboard_apps.name;

-- ------------------------------------------------------------------
-- 3. Shelf placement: the admin only, appended after whatever is already there.
--    The derived table recomputes MAX(position) while dodging MySQL error 1093
--    (cannot read the table being inserted into).
-- ------------------------------------------------------------------

INSERT INTO dashboard_user_apps (user_id, app_id, position)
SELECT u.id, a.id,
       COALESCE((SELECT MAX(p.position) FROM (SELECT user_id, position FROM dashboard_user_apps) p
                  WHERE p.user_id = u.id), -1) + 1
FROM users u JOIN dashboard_apps a ON a.url LIKE '/views/share%'
WHERE u.email = 'domen.hribernik4@gmail.com'
ON DUPLICATE KEY UPDATE app_id = dashboard_user_apps.app_id;
