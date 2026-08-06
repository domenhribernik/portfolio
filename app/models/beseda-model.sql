-- Beseda: the streak store for the Slovenian learning tool (views/beseda).
--
-- Requires auth-model.sql (users) to have been run first. Run manually in
-- phpMyAdmin; nothing in this codebase executes SQL on its own.
--
-- Deliberately NOT a gated project: there is no `projects` row and no role.
-- Anyone may learn, signed in or not. Practice days live in localStorage until
-- someone signs in, at which point they are merged here so the streak follows
-- the account across devices and onto the iliana page widget.
--
-- One row per user per day practised, and nothing else: the current and
-- longest streaks are derived on the client (components/beseda/logic.js) so
-- the page and the widget can never disagree about the number. The UNIQUE key
-- is what makes the merge idempotent, since the client re-uploads its whole
-- history on every sign-in.

CREATE TABLE IF NOT EXISTS beseda_activity (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    day DATE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_beseda_activity_user_day (user_id, day),
    INDEX idx_beseda_activity_user (user_id),
    CONSTRAINT fk_beseda_activity_user FOREIGN KEY (user_id)
        REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- Dashboard tile. project_id stays NULL on purpose: this is a public passion
-- view, and a project-linked tile would sit dormant on every new shelf until
-- someone granted a role that does not exist. is_default = 1 puts it on new
-- users' shelves via seedDefaultDashboardApps().
INSERT INTO dashboard_apps (name, icon, gradient, url, sort_order, project_id, is_default)
SELECT 'Beseda', 'fa-solid fa-language',
       'linear-gradient(45deg, #2f5b53 0%, #7fa89c 100%)', '/views/beseda/', 200,
       NULL, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM dashboard_apps d WHERE d.url LIKE '/views/beseda%')
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
FROM users u JOIN dashboard_apps a ON a.url LIKE '/views/beseda%'
WHERE u.is_active = 1
ON DUPLICATE KEY UPDATE app_id = dashboard_user_apps.app_id;
