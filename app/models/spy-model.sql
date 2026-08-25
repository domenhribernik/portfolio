-- Spy (views/spy) room mode: anonymous multiplayer rooms for the phone-per-
-- player gamemode. Same shape as parlour-model.sql (rooms + players + an
-- append-only event log whose id is the sync cursor), with one difference
-- that drives the whole feature: a role is a SECRET, so it can never be an
-- event. The server owns the deal and keeps it in spy_rooms.location and
-- spy_players.role; the poll response only ever discloses the requesting
-- player's own role, and the full dossier only once status = 'debrief'.
-- No accounts: a player is identified by a secret token minted at join time
-- and stored here only as a SHA-256 hash, mirroring the sessions table.
-- Rooms are throwaway; the controller purges rooms idle for 6+ hours and
-- deleting a room cascades to its players and events.
-- Run manually in phpMyAdmin. Safe to re-run.

CREATE TABLE IF NOT EXISTS spy_rooms (
    id INT AUTO_INCREMENT PRIMARY KEY,
    code CHAR(4) NOT NULL UNIQUE,
    status ENUM('lobby','brief','round','debrief') NOT NULL DEFAULT 'lobby',
    spies TINYINT NOT NULL DEFAULT 1,
    round_seconds SMALLINT NOT NULL DEFAULT 300,
    -- Secret until the debrief. NULL before the first deal.
    location VARCHAR(64) DEFAULT NULL,
    -- The shared clock. NULL while paused or outside a round. Every client
    -- renders seconds derived from this, so all phones agree.
    round_ends_at DATETIME DEFAULT NULL,
    -- Non-NULL means paused with this many seconds still on the clock.
    paused_seconds SMALLINT DEFAULT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_active DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_spy_rooms_idle (last_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS spy_players (
    id INT AUTO_INCREMENT PRIMARY KEY,
    room_id INT NOT NULL,
    token_hash CHAR(64) NOT NULL UNIQUE,
    name VARCHAR(20) NOT NULL,
    is_host TINYINT NOT NULL DEFAULT 0,
    -- The secret. Never sent to anyone but its owner, and never to anyone at
    -- all for another player until the debrief reveal.
    role ENUM('citizen','spy') DEFAULT NULL,
    -- Has this player memorised their card for the current deal.
    ready TINYINT NOT NULL DEFAULT 0,
    joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    left_at DATETIME DEFAULT NULL,
    INDEX idx_spy_players_room (room_id),
    CONSTRAINT fk_spy_players_room FOREIGN KEY (room_id)
        REFERENCES spy_rooms(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The event log. id doubles as the sync cursor: clients poll with the last
-- id they have seen and receive everything newer for their room, so the
-- composite (room_id, id) index is the hot path of the whole feature. Every
-- row here is PUBLIC to the room, which is why no role or location ever
-- travels in one: these are phase edges only (deal, ready, start, end...).
CREATE TABLE IF NOT EXISTS spy_events (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    room_id INT NOT NULL,
    player_id INT DEFAULT NULL,
    type VARCHAR(16) NOT NULL,
    data MEDIUMTEXT DEFAULT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_spy_events_room_seq (room_id, id),
    CONSTRAINT fk_spy_events_room FOREIGN KEY (room_id)
        REFERENCES spy_rooms(id) ON DELETE CASCADE,
    CONSTRAINT fk_spy_events_player FOREIGN KEY (player_id)
        REFERENCES spy_players(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
