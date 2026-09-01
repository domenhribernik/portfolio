-- Run-once upgrade for databases carrying the SECOND version of the spy room
-- tables (voting, outcomes and a room language, but one ballot per player, an
-- outcome computed from that ballot, and a location drawn fresh every deal).
-- A fresh database needs none of this: app/models/spy-model.sql already
-- creates the current shape. Run manually in phpMyAdmin, once.
--
-- Three things change, and they are the three the game was tested and found
-- wanting on:
--   1. A table hunting n spies now casts n accusations, so the single
--      spy_players.voted_for column becomes the spy_ballots table.
--   2. The dossier is no longer handed out the moment the vote closes. The
--      accused defends themselves first, and the HOST calls the round, which
--      is what declassifies it: hence revealed, and an outcome that starts
--      NULL instead of being settled by the ballot.
--   3. A room never plays the same location twice, which needs somewhere to
--      remember what it has already used.
--
-- Live rooms cannot be migrated meaningfully (there is no per-ballot history
-- to expand into rows), so any room mid-game is sent back to the lobby.
-- Rooms are throwaway and purged after six idle hours anyway.

CREATE TABLE IF NOT EXISTS spy_ballots (
    id INT AUTO_INCREMENT PRIMARY KEY,
    room_id INT NOT NULL,
    voter_id INT NOT NULL,
    target_id INT NOT NULL,
    UNIQUE KEY uniq_spy_ballot (voter_id, target_id),
    INDEX idx_spy_ballots_room (room_id),
    INDEX idx_spy_ballots_target (room_id, target_id),
    CONSTRAINT fk_spy_ballots_room FOREIGN KEY (room_id)
        REFERENCES spy_rooms(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE spy_rooms
    ADD COLUMN used_location_keys TEXT DEFAULT NULL AFTER location_key,
    ADD COLUMN accused_ids VARCHAR(255) DEFAULT NULL AFTER paused_seconds,
    ADD COLUMN revealed TINYINT NOT NULL DEFAULT 0 AFTER outcome,
    DROP COLUMN accused_id;

ALTER TABLE spy_players
    DROP COLUMN voted_for;

-- Any room caught mid-game by the upgrade is sent back to the lobby rather
-- than leaving a round nobody can finish. used_location_keys is deliberately
-- NOT cleared here, so a room that survives the upgrade keeps its deck.
UPDATE spy_rooms
SET status = 'lobby', location_key = NULL, round_ends_at = NULL,
    paused_seconds = NULL, accused_ids = NULL, outcome = NULL, revealed = 0
WHERE status <> 'lobby';

UPDATE spy_players SET role = NULL, ready = 0, wants_end = 0;
