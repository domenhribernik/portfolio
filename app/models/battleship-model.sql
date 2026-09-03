-- BATTLESHIP (views/battleship): two-seat rooms for the salvage variant of
-- battleship, where the heavy weapons are unlocked by your OWN wrecks rather
-- than bought with a lead. Same shape as seam-model.sql and spy-model.sql
-- (rooms + players + an append-only event log whose id is the sync cursor),
-- with the two rules from those games combined, because battleship needs both:
--
--   THE SERVER OWNS BOTH PLOTS (seam's rule). A client may send a coordinate.
--   It may never send a hit, a sink, a salvage total or an outcome. Every
--   grid, fleet and tote in here is written by battleship-controller.php and
--   by nothing else.
--
--   A FLEET IS A SECRET (spy's rule). battleship_players.fleet and .decoys
--   leave the controller in exactly one place: the `you` block of their own
--   owner's poll. They never enter an event, never appear in players[], and
--   are not disclosed to the loser at the verdict either. A sonar reading is
--   the same kind of secret, which is why battleship_intel exists as its own
--   table rather than as a column or an event: a private result cannot reach
--   the public log if the public log has nowhere to put it.
--
-- No accounts for play: a player is a secret token minted at join time and
-- stored here only as a SHA-256 hash, mirroring the sessions table. The one
-- account contact point is battleship_players.user_id, stamped when whoever
-- sat down happened to be signed in, so the match can be written to
-- battleship_records at the verdict. Nothing about the game is gated on it.
--
-- Rooms are throwaway; the controller purges rooms idle for 6+ hours and
-- deleting a room cascades to its players, events and intel.
--
-- Run manually in phpMyAdmin. Safe to re-run.

-- The auth registry row, so the game shows up as a project in the admin
-- dashboard's #projects tab. It grants nobody anything: no user_project_roles
-- row is seeded here, and battleship-controller.php carries NO Auth gate at
-- all. A player is a token, not an account, which is the whole point of a
-- throwaway four-letter code. So do not read this row as "battleship is
-- gated"; it is the registry entry a project needs to be listed, nothing more.
INSERT INTO projects (project_key, name) VALUES ('battleship', 'Battleship')
ON DUPLICATE KEY UPDATE active = 1;


-- One room, one match. The room owns the turn and the phase; each seat owns
-- its own plot, because in this game there is no shared board to own.
CREATE TABLE IF NOT EXISTS battleship_rooms (
    id INT AUTO_INCREMENT PRIMARY KEY,
    code CHAR(4) NOT NULL UNIQUE,
    -- lobby: waiting for a second seat.  place: both laying fleets, at the
    -- same time.  battle: alternating turns.  over: a verdict is frozen.
    status ENUM('lobby','place','battle','over') NOT NULL DEFAULT 'lobby',
    lang CHAR(2) NOT NULL DEFAULT 'en',
    turn TINYINT NOT NULL DEFAULT 1,
    starter TINYINT NOT NULL DEFAULT 1,
    turns SMALLINT NOT NULL DEFAULT 0,
    -- Digit strings, never bare ints: an ENUM of '1','2' is a MySQL footgun,
    -- because outcome = 1 would mean the first member rather than the value.
    outcome ENUM('p1','p2') DEFAULT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_active DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_battleship_rooms_idle (last_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


CREATE TABLE IF NOT EXISTS battleship_players (
    id INT AUTO_INCREMENT PRIMARY KEY,
    room_id INT NOT NULL,
    token_hash CHAR(64) NOT NULL UNIQUE,
    -- Stamped only if this seat happened to be signed in when it sat down.
    -- Nothing is gated on it; it exists so the verdict can write a record.
    user_id INT DEFAULT NULL,
    name VARCHAR(20) NOT NULL,
    seat TINYINT NOT NULL,
    is_host TINYINT NOT NULL DEFAULT 0,

    -- THE SECRET. JSON: [{"key":"carrier","at":34,"dir":"h"}, ...]. NULL until
    -- this seat submits a placement, which is also how the controller knows
    -- whether both fleets are down and the match can start.
    fleet VARCHAR(255) DEFAULT NULL,

    -- What has been fired AT this seat, row major, 100 cells:
    --   .  unfired          o  miss            x  hit, hull still afloat
    --   s  sunk hull        D  decoy popped, not yet confessed
    --   d  decoy, confessed
    -- Deliberately no DEFAULT: the controller is the only source of a plot,
    -- so an INSERT that forgets one should fail rather than invent one.
    grid CHAR(100) NOT NULL,

    -- THE SECRET. Comma separated cells holding a live decoy buoy.
    decoys VARCHAR(32) DEFAULT NULL,
    -- PUBLIC, and deliberately so. Comma separated centres of the blocks the
    -- ENEMY has swept against this seat. A sweep buys a reading and pays for
    -- it by lighting the water, which is the only thing reposition can react
    -- to and the reason the two tools counter each other at all.
    swept VARCHAR(255) DEFAULT NULL,

    salvage TINYINT NOT NULL DEFAULT 0,
    salvage_spent SMALLINT NOT NULL DEFAULT 0,
    shots_fired SMALLINT NOT NULL DEFAULT 0,
    shots_hit SMALLINT NOT NULL DEFAULT 0,
    wins SMALLINT NOT NULL DEFAULT 0,
    wants_again TINYINT NOT NULL DEFAULT 0,

    joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    left_at DATETIME DEFAULT NULL,
    INDEX idx_battleship_players_room (room_id),
    CONSTRAINT fk_battleship_players_room FOREIGN KEY (room_id)
        REFERENCES battleship_rooms(id) ON DELETE CASCADE,
    CONSTRAINT fk_battleship_players_user FOREIGN KEY (user_id)
        REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- The event log. id doubles as the sync cursor: clients poll with the last id
-- they have seen and receive everything newer for their room, so the composite
-- (room_id, id) index is the hot path of the whole feature. Every row here is
-- PUBLIC to the room, which is why no fleet, decoy or sonar reading ever
-- travels in one. A `moved` row carries the seat and nothing else on purpose:
-- the enemy learns their plot went stale and has to work out where.
CREATE TABLE IF NOT EXISTS battleship_events (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    room_id INT NOT NULL,
    player_id INT DEFAULT NULL,
    type VARCHAR(16) NOT NULL,
    data MEDIUMTEXT DEFAULT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_battleship_events_room_seq (room_id, id),
    CONSTRAINT fk_battleship_events_room FOREIGN KEY (room_id)
        REFERENCES battleship_rooms(id) ON DELETE CASCADE,
    CONSTRAINT fk_battleship_events_player FOREIGN KEY (player_id)
        REFERENCES battleship_players(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- Private results, delivered only in their owner's own poll. A sonar reading
-- is a secret the way a spy's role is, and giving it its own table rather than
-- a column on the event log means it CANNOT leak into the public log by
-- accident: there is nowhere in battleship_events for it to go.
CREATE TABLE IF NOT EXISTS battleship_intel (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    room_id INT NOT NULL,
    player_id INT NOT NULL,
    kind VARCHAR(16) NOT NULL,
    at_cell TINYINT NOT NULL,
    reading TINYINT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_battleship_intel_player (player_id, id),
    CONSTRAINT fk_battleship_intel_room FOREIGN KEY (room_id)
        REFERENCES battleship_rooms(id) ON DELETE CASCADE,
    CONSTRAINT fk_battleship_intel_player FOREIGN KEY (player_id)
        REFERENCES battleship_players(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- The one thing that outlives a room. Written at the verdict for whichever
-- seats were signed in, and read back by the start screen as a record card.
-- Rooms are purged after 6 hours; these rows are not, which is why they carry
-- the opponent's name rather than a foreign key to a player that will be gone.
--
-- mode 'bot' rows are reported by the client, because the solo game never
-- touches the server. They are self reported and the card labels them
-- practice for exactly that reason; only 'room' rows are server witnessed.
CREATE TABLE IF NOT EXISTS battleship_records (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    mode ENUM('room','bot') NOT NULL DEFAULT 'room',
    result ENUM('win','loss') NOT NULL,
    opponent VARCHAR(20) NOT NULL DEFAULT '',
    turns SMALLINT NOT NULL DEFAULT 0,
    shots SMALLINT NOT NULL DEFAULT 0,
    hits SMALLINT NOT NULL DEFAULT 0,
    salvage_spent SMALLINT NOT NULL DEFAULT 0,
    finished_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_battleship_records_user (user_id, finished_at),
    CONSTRAINT fk_battleship_records_user FOREIGN KEY (user_id)
        REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
