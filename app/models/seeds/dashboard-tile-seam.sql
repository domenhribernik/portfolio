-- Adds the Seam tile to the Dashboard launcher (views/dashboard).
-- Run manually in phpMyAdmin. Safe to re-run: the insert is guarded on the url,
-- so a tile that already exists under another name is never duplicated.
--
-- Seam is a PUBLIC view. It carries no Auth gate at all: seam-controller.php
-- authenticates a player by a token minted at join time, not by an account, so
-- there is nothing for a project role to unlock. project_id therefore stays
-- NULL, which is what makes the tile pickable by every signed-in user.
--
-- The `seam` row in `projects` (seeded by app/models/seam-model.sql) is the
-- admin registry entry and nothing more. Do NOT point this tile at it: that
-- would restrict picking to role holders, and no user holds a seam role, so
-- the only person who could see it would be the admin.
--
-- is_default = 0, so this writes no dashboard_user_apps rows and touches
-- nobody's shelf. Seam is opt-in from the launcher's own tile picker, the same
-- as the other public multiplayer rooms (Spy Game, Drawing Room). Change the
-- flag to 1 and re-run only if it should be seeded onto every new signup.

INSERT INTO dashboard_apps (name, icon, gradient, url, sort_order, project_id, is_default)
SELECT 'Seam', 'fas fa-layer-group',
       -- The section's own two inks: the jurassic band, and seat one's ochre.
       -- Same gradient the project card uses in components/project-data.js.
       'linear-gradient(45deg, #1f8a86 0%, #e0a11c 100%)', '/views/seam/', 220,
       NULL, 0 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM dashboard_apps d WHERE d.url LIKE '/views/seam%')
ON DUPLICATE KEY UPDATE dashboard_apps.name = dashboard_apps.name;
