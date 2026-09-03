-- BEARING (views/bearing): two-seat rooms for the co-op radio telemetry
-- game. Same shape as seam-model.sql (rooms + players + an append-only
-- event log whose id is the sync cursor), with two differences that drive
-- the whole feature.
--
-- 1. THE SERVER OWNS THE VALLEY. Terrain, the animals, their hidden
--    behaviour profiles and their movement are generated from
--    bearing_rooms.seed and never leave except as the things a station
--    could actually observe.
-- 2. AN ANIMAL'S POSITION IS A SECRET until dawn, and so now are its
--    PROFILE, its DEN CELL and its TRACK. bearing_animals is never
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
-- Run manually in phpMyAdmin. Safe to re-run: the ALTERs at the foot
-- migrate a database created before the intercept rework.

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
    -- there is no clock anywhere in this schema. Ten, not twenty-four: a
    -- night is one sitting, and twenty-four cycles of the same three
    -- actions was the shape of the version nobody wanted to replay.
    cycle TINYINT UNSIGNED NOT NULL DEFAULT 0,
    cycles TINYINT UNSIGNED NOT NULL DEFAULT 10,
    -- clear | haze | storm. Raises the noise floor and makes a ridge
    -- bounce more convincing, which changes where you can afford to stand.
    weather VARCHAR(8) NOT NULL DEFAULT 'clear',
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
-- observation instead: a trace, or a fix the pair placed themselves.
CREATE TABLE IF NOT EXISTS bearing_animals (
    id INT AUTO_INCREMENT PRIMARY KEY,
    room_id INT NOT NULL,
    collar VARCHAR(8) NOT NULL,
    -- Row-major cell index, moved every cycle by the profile below.
    at SMALLINT NOT NULL,
    -- ridge | den | water | flight. The hidden behaviour the whole night is
    -- spent deducing, so this is the single most secret column in the game.
    profile VARCHAR(8) NOT NULL,
    -- Only meaningful for the den profile: the point she orbits.
    den_cell SMALLINT DEFAULT NULL,
    -- Every cell she has stood in, comma separated, oldest first. Written
    -- as the night runs and published only in the dawn report, where it is
    -- drawn over the track the pair reconstructed.
    track MEDIUMTEXT NOT NULL,
    -- Which cycles this collar transmits on: it pings when
    -- cycle % duty == phase, so sweeping a silent collar wastes the cycle.
    duty TINYINT NOT NULL DEFAULT 1,
    phase TINYINT NOT NULL DEFAULT 0,
    INDEX idx_bearing_animals_room (room_id),
    CONSTRAINT fk_bearing_animals_room FOREIGN KEY (room_id)
        REFERENCES bearing_rooms(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- THE COMMITMENT. One seat proposes a cell and a cycle, the other has to
-- confirm it, and only then does it lock and cost the proposer's cycle.
-- Two seats are required by the schema, not merely by the controller:
-- confirmed_by is what makes a solo intercept unrepresentable.
CREATE TABLE IF NOT EXISTS bearing_intercepts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    room_id INT NOT NULL,
    collar VARCHAR(8) NOT NULL,
    proposed_by INT NOT NULL,
    confirmed_by INT DEFAULT NULL,
    at SMALLINT NOT NULL,
    target_cycle TINYINT UNSIGNED NOT NULL,
    -- contact | near | missed, written when the night reaches target_cycle.
    grade VARCHAR(8) DEFAULT NULL,
    -- How far the call was from the animal, in metres. Only ever written at
    -- resolution, which is the moment it stops being a secret.
    error_m SMALLINT DEFAULT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_bearing_intercepts_room (room_id, collar),
    CONSTRAINT fk_bearing_intercepts_room FOREIGN KEY (room_id)
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

-- ---------------------------------------------------------------------
-- Migration from the pre-intercept schema. No-ops on a fresh install and
-- on a database that has already had them applied.
--
-- The old night asked a scripted question ("she should have denned, find
-- where") on a fixed hidden cycle. The intercept rework replaced it, so
-- brief, brief_collar, den_cycle, den_at and denned are dropped rather
-- than left behind to rot: a nullable column nothing writes is a trap for
-- whoever reads this schema next.
ALTER TABLE bearing_rooms
    ADD COLUMN IF NOT EXISTS weather VARCHAR(8) NOT NULL DEFAULT 'clear',
    DROP COLUMN IF EXISTS brief,
    DROP COLUMN IF EXISTS brief_collar,
    DROP COLUMN IF EXISTS den_cycle,
    DROP COLUMN IF EXISTS den_at,
    ALTER COLUMN cycles SET DEFAULT 10;

ALTER TABLE bearing_animals
    ADD COLUMN IF NOT EXISTS profile VARCHAR(8) NOT NULL DEFAULT 'ridge',
    ADD COLUMN IF NOT EXISTS den_cell SMALLINT DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS track MEDIUMTEXT NOT NULL DEFAULT '',
    DROP COLUMN IF EXISTS pace,
    DROP COLUMN IF EXISTS denned;
