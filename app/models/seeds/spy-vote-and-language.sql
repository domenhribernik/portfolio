-- Run-once upgrade for databases that already carry the FIRST version of the
-- spy room tables (the one without voting, outcomes or a room language).
-- A fresh database needs none of this: app/models/spy-model.sql already
-- creates the current shape. Run manually in phpMyAdmin, once.
--
-- The location column changes from a display string to a key into
-- views/spy/i18n/locations.json. Live rooms cannot be migrated meaningfully
-- (their old value is an English display string, not a key), so the column
-- is added empty and any room mid-deal simply needs re-dealing. Rooms are
-- throwaway and purged after six idle hours anyway.

ALTER TABLE spy_rooms
    MODIFY COLUMN status ENUM('lobby','brief','round','vote','debrief') NOT NULL DEFAULT 'lobby',
    ADD COLUMN lang CHAR(2) NOT NULL DEFAULT 'en' AFTER status,
    ADD COLUMN location_key VARCHAR(64) DEFAULT NULL AFTER round_seconds,
    ADD COLUMN accused_id INT DEFAULT NULL AFTER paused_seconds,
    ADD COLUMN outcome ENUM('agents','spies') DEFAULT NULL AFTER accused_id,
    DROP COLUMN location;

ALTER TABLE spy_players
    ADD COLUMN wants_end TINYINT NOT NULL DEFAULT 0 AFTER ready,
    ADD COLUMN voted_for INT DEFAULT NULL AFTER wants_end;

-- Any room caught mid-game by the upgrade has no location key, so send them
-- all back to the lobby rather than leaving a round nobody can finish.
UPDATE spy_rooms
SET status = 'lobby', location_key = NULL, round_ends_at = NULL,
    paused_seconds = NULL, accused_id = NULL, outcome = NULL
WHERE status <> 'lobby';

UPDATE spy_players SET role = NULL, ready = 0, wants_end = 0, voted_for = NULL;
