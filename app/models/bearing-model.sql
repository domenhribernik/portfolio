-- BEARING (views/bearing): two-seat rooms for the co-op radio telemetry
-- game. Same shape as seam-model.sql (rooms + players + an append-only
-- event log whose id is the sync cursor), with two differences that drive
-- the whole feature.
--
-- 1. THE SERVER OWNS THE VALLEY. Terrain, the animals and their movement
--    are generated here from bearing_rooms.seed and never leave except as
--    the things a station could actually observe.
-- 2. AN ANIMAL'S POSITION IS A SECRET until dawn. bearing_animals is never
--    serialised into any payload; tests/bearing-controller.test.php greps
--    the raw response bytes to prove it.
--
-- A note on what is NOT guarded, because it looks like a hole and is not:
-- a sweep returns the whole 360-sample trace, and the true bearing is the
-- peak of it. That is the game. The player's job is to read it well, and
-- reading it perfectly by script would only be cheating if there were an
-- opponent. This is co-op: both seats want the same outcome, so the trace
-- can be handed over honestly and the skill stays where it belongs.
--
-- Run manually in phpMyAdmin. Safe to re-run.

INSERT INTO projects (project_key, name) VALUES ('bearing', 'Bearing')
ON DUPLICATE KEY UPDATE active = 1;

CREATE TABLE IF NOT EXISTS bearing_rooms (
    id INT AUTO_INCREMENT PRIMARY KEY,
    code CHAR(4) NOT NULL UNIQUE,
    status ENUM('lobby','night','dawn') NOT NULL DEFAULT 'lobby',
    -- Everything about the valley derives from this, so a night is
    -- reproducible and the simulation suite can replay one exactly.
    seed INT UNSIGNED NOT NULL,
    -- Row-major elevation, one character per cell, '0'..'9'. Deliberately
    -- no DEFAULT: the controller is the only source of a valley, so an
    -- INSERT that forgets one should fail rather than invent a flat one.
    terrain MEDIUMTEXT NOT NULL,
    -- Dusk to dawn. Nothing advances until BOTH seats have committed, so
    -- there is no clock anywhere in this schema.
    cycle TINYINT UNSIGNED NOT NULL DEFAULT 0,
    cycles TINYINT UNSIGNED NOT NULL DEFAULT 24,
    -- The night's question, and the collar it is about.
    brief VARCHAR(32) NOT NULL,
    brief_collar VARCHAR(8) NOT NULL,
    -- When she dens and where. Both hidden until the night reaches it.
    den_cycle TINYINT UNSIGNED NOT NULL,
    den_at SMALLINT DEFAULT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_active DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_bearing_rooms_idle (last_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS bearing_players (
    id INT AUTO_INCREMENT PRIMARY KEY,
    room_id INT NOT NULL,
    token_hash CHAR(64) NOT NULL UNIQUE,
    name VARCHAR(20) NOT NULL,
    -- 1 or 2. Not unique per room on purpose: a lobby player who walks out
    -- leaves a row behind and the seat must be free again. The race is shut
    -- by locking the room row inside the join transaction.
    seat TINYINT NOT NULL,
    is_host TINYINT NOT NULL DEFAULT 0,
    -- Where this station stands, as a row-major cell index.
    pos SMALLINT NOT NULL,
    -- The ground this seat has walked, one character per cell, '0' or '1'.
    -- Each seat knows its own half of the valley and only hears about the
    -- other, which is what stops either player becoming the quarterback.
    revealed MEDIUMTEXT NOT NULL,
    -- The lockstep: a cycle resolves when both seats have committed for it.
    committed_cycle SMALLINT NOT NULL DEFAULT -1,
    committed_action TEXT DEFAULT NULL,
    fixes_logged SMALLINT NOT NULL DEFAULT 0,
    wants_again TINYINT NOT NULL DEFAULT 0,
    joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    left_at DATETIME DEFAULT NULL,
    INDEX idx_bearing_players_room (room_id),
    CONSTRAINT fk_bearing_players_room FOREIGN KEY (room_id)
        REFERENCES bearing_rooms(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- THE SECRET. No column in here is ever serialised into a payload before
-- dawn. Everything a station may know is derived from it and sent as an
-- observation instead: a trace, or a graded fix.
CREATE TABLE IF NOT EXISTS bearing_animals (
    id INT AUTO_INCREMENT PRIMARY KEY,
    room_id INT NOT NULL,
    collar VARCHAR(8) NOT NULL,
    -- Row-major cell index. Moves every cycle until she dens.
    at SMALLINT NOT NULL,
    -- Which cycles this collar transmits on: it pings when
    -- cycle % duty == phase, so sweeping a silent collar wastes the cycle.
    duty TINYINT NOT NULL DEFAULT 1,
    phase TINYINT NOT NULL DEFAULT 0,
    -- How far it moves per cycle, and how much it wanders.
    pace TINYINT NOT NULL DEFAULT 2,
    denned TINYINT NOT NULL DEFAULT 0,
    INDEX idx_bearing_animals_room (room_id),
    CONSTRAINT fk_bearing_animals_room FOREIGN KEY (room_id)
        REFERENCES bearing_rooms(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The event log. id doubles as the sync cursor, so the composite
-- (room_id, id) index is the hot path of the whole feature. Rows here carry
-- only the edges worth animating; the snapshot in the same poll response is
-- the truth, so a phone that resumed past a page of events still renders
-- the right plate.
CREATE TABLE IF NOT EXISTS bearing_events (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    room_id INT NOT NULL,
    player_id INT DEFAULT NULL,
    type VARCHAR(16) NOT NULL,
    data MEDIUMTEXT DEFAULT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_bearing_events_room_seq (room_id, id),
    CONSTRAINT fk_bearing_events_room FOREIGN KEY (room_id)
        REFERENCES bearing_rooms(id) ON DELETE CASCADE,
    CONSTRAINT fk_bearing_events_player FOREIGN KEY (player_id)
        REFERENCES bearing_players(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
