-- Adds the Trips tile to the Dashboard launcher (views/trips) for everyone.
-- Run manually in phpMyAdmin, after trips-model.sql. Safe to re-run: the
-- insert is guarded by url and the backfill by the shelf's primary key.
--
-- project_id stays NULL on purpose: Trips is open to anyone signed in, like
-- trails and beseda, and a project-linked tile would sit dormant on every
-- shelf until someone granted a role that does not exist. is_default = 1 puts
-- it on new users' shelves via seedDefaultDashboardApps().
-- Icon and gradient match the trips entry in components/project-data.js.

INSERT INTO dashboard_apps (name, icon, gradient, url, sort_order, project_id, is_default)
SELECT 'Trips', 'fa-solid fa-route',
       'linear-gradient(45deg, #cf2d25 0%, #0b7a80 100%)', '/views/trips/', 240,
       NULL, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM dashboard_apps d WHERE d.url LIKE '/views/trips%')
ON DUPLICATE KEY UPDATE dashboard_apps.name = dashboard_apps.name;

-- Existing users do not get is_default tiles retroactively, so backfill.
-- `position` is per-user shelf order, so append at the end of each user's own
-- shelf. The derived table is MySQL's workaround for reading the table being
-- inserted into.
INSERT INTO dashboard_user_apps (user_id, app_id, position)
SELECT u.id, a.id,
       COALESCE((SELECT MAX(p.position) FROM (SELECT user_id, position FROM dashboard_user_apps) p
                  WHERE p.user_id = u.id), -1) + 1
FROM users u JOIN dashboard_apps a ON a.url LIKE '/views/trips%'
WHERE u.is_active = 1
ON DUPLICATE KEY UPDATE app_id = dashboard_user_apps.app_id;
