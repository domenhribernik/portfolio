-- Adds the Bearing tile to the Dashboard launcher (views/dashboard).
-- Run manually in phpMyAdmin. Safe to re-run: the insert is guarded on the url,
-- so a tile that already exists under another name is never duplicated.
--
-- Bearing is a PUBLIC view. bearing-controller.php carries no Auth gate at
-- all: a player is a token minted at join time, not an account, so there is
-- nothing for a project role to unlock. project_id therefore stays NULL,
-- which is what makes the tile pickable by every signed-in user.
--
-- The `bearing` row in `projects` (seeded by app/models/bearing-model.sql) is
-- the admin registry entry and nothing more. Do NOT point this tile at it:
-- that would restrict picking to role holders, and nobody holds a bearing
-- role, so the only person who could see it would be the admin.
--
-- is_default = 0, so this writes no dashboard_user_apps rows and touches
-- nobody's shelf, the same as the other public multiplayer rooms.

INSERT INTO dashboard_apps (name, icon, gradient, url, sort_order, project_id, is_default)
SELECT 'Bearing', 'fas fa-satellite-dish',
       -- The plate's flooded ink and its one second colour. Same gradient the
       -- project card uses in components/project-data.js.
       'linear-gradient(45deg, #272052 0%, #ff6a2b 100%)', '/views/bearing/', 225,
       NULL, 0 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM dashboard_apps d WHERE d.url LIKE '/views/bearing%')
ON DUPLICATE KEY UPDATE dashboard_apps.name = dashboard_apps.name;
