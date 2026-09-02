-- One-off teardown: removes the Compass tracker (views/compass) and The
-- Drawing Room (views/parlour), both retired. The views, controllers, model
-- files and tests are already gone from the repo; this drops what is left in
-- the database. Run manually in phpMyAdmin, on prod and on any local scratch
-- DB. Safe to re-run.
--
-- This DESTROYS the compass check-in history, catch log and workbook notes.
-- Take a dump of the three compass_* tables first if any of it is wanted.

-- Parlour first: guests and events are foreign-keyed to rooms, so drop the
-- children before the parent.
DROP TABLE IF EXISTS parlour_events;
DROP TABLE IF EXISTS parlour_guests;
DROP TABLE IF EXISTS parlour_rooms;

-- Compass had no foreign keys and no user_id (it was admin-only).
DROP TABLE IF EXISTS compass_checkins;
DROP TABLE IF EXISTS compass_catches;
DROP TABLE IF EXISTS compass_activities;

-- The dashboard tile and its projects row. The tile's project_id is NULL, so
-- order does not matter, but delete the tile first for symmetry.
DELETE FROM dashboard_apps WHERE url LIKE '/views/parlour%';
DELETE FROM dashboard_apps WHERE url LIKE '/views/compass%';

-- user_project_roles is ON DELETE CASCADE from projects, so any grants go
-- with these rows. Compass never had a projects row (it used requireAdmin).
DELETE FROM projects WHERE project_key IN ('parlour', 'compass');
