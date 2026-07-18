-- The vrata PWA has no tables of its own (its state lives in the Tuya cloud);
-- this only registers the project so the door backend (app/proxys/vrata.php)
-- can authorize signed-in users by role in addition to the shared key.
--
-- SEC-03: app/proxys/vrata.php accepts either the shared VRATA_KEY (posted in
-- the JSON body, never the URL) OR a signed-in user holding a role in this
-- project (admins pass implicitly). Grant the 'user' role from the views/admin
-- dashboard to anyone who should open the door without knowing the key.
--
-- Requires auth-model.sql (users, projects, user_project_roles) first.
INSERT INTO projects (project_key, name) VALUES ('vrata', 'Vrata')
ON DUPLICATE KEY UPDATE active = 1;
