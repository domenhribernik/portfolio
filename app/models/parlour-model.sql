-- The Drawing Room (views/parlour): anonymous multiplayer rooms that share
-- an append-only event log (strokes, clears, the start bell). No accounts:
-- a guest is identified by a secret token minted at create/join time and
-- stored here only as a SHA-256 hash, mirroring the sessions table.
-- Rooms are throwaway; the controller purges rooms idle for 12+ hours and
-- deleting a room cascades to its guests and events.
-- Run manually in phpMyAdmin. Safe to re-run.

CREATE TABLE IF NOT EXISTS parlour_rooms (
    id INT AUTO_INCREMENT PRIMARY KEY,
    code CHAR(4) NOT NULL UNIQUE,
    status ENUM('lobby','live') NOT NULL DEFAULT 'lobby',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_active DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_parlour_rooms_idle (last_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS parlour_guests (
    id INT AUTO_INCREMENT PRIMARY KEY,
    room_id INT NOT NULL,
    token_hash CHAR(64) NOT NULL UNIQUE,
    name VARCHAR(20) NOT NULL,
    ink TINYINT NOT NULL,
    is_host TINYINT NOT NULL DEFAULT 0,
    joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    left_at DATETIME DEFAULT NULL,
    INDEX idx_parlour_guests_room (room_id),
    CONSTRAINT fk_parlour_guests_room FOREIGN KEY (room_id)
        REFERENCES parlour_rooms(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The event log. id doubles as the sync cursor: clients poll with the last
-- id they have seen and receive everything newer for their room, so the
-- composite (room_id, id) index is the hot path of the whole feature.
CREATE TABLE IF NOT EXISTS parlour_events (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    room_id INT NOT NULL,
    guest_id INT DEFAULT NULL,
    type VARCHAR(16) NOT NULL,
    data MEDIUMTEXT DEFAULT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_parlour_events_room_seq (room_id, id),
    CONSTRAINT fk_parlour_events_room FOREIGN KEY (room_id)
        REFERENCES parlour_rooms(id) ON DELETE CASCADE,
    CONSTRAINT fk_parlour_events_guest FOREIGN KEY (guest_id)
        REFERENCES parlour_guests(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
