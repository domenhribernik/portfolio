-- SEAM (views/seam): two-seat rooms for the connect-four variant whose board
-- eats its own basement. Same shape as spy-model.sql (rooms + players + an
-- append-only event log whose id is the sync cursor), with one difference
-- that drives the whole feature: THE SERVER OWNS THE BOARD. A shared-canvas
-- server can guard state without ever computing it, because a stroke is
-- public and harmless. Here a client could otherwise forge a cave
-- or claim a seam, so seam_rooms.board is the only section that exists and
-- seam-controller.php is the only thing that may write it.
-- No accounts: a player is identified by a secret token minted at join time
-- and stored here only as a SHA-256 hash, mirroring the sessions table.
-- Rooms are throwaway; the controller purges rooms idle for 6+ hours and
-- deleting a room cascades to its players and events.
-- Run manually in phpMyAdmin. Safe to re-run.

-- The auth registry row, so the section shows up as a project in the admin
-- dashboard's #projects tab. It grants nobody anything: no user_project_roles
-- row is seeded here, and seam-controller.php carries NO Auth gate at all. A
-- player is a token, not an account, which is the whole point of a throwaway
-- four-letter code. So do not read this row as "seam is gated"; it is the
-- registry entry a project needs to be listed, nothing more. Grant roles from
-- the admin dashboard if the feature ever needs an audience.
INSERT INTO projects (project_key, name) VALUES ('seam', 'Seam')
ON DUPLICATE KEY UPDATE active = 1;

CREATE TABLE IF NOT EXISTS seam_rooms (
    id INT AUTO_INCREMENT PRIMARY KEY,
    code CHAR(4) NOT NULL UNIQUE,
    -- Two statuses fewer than spy: the match starts the moment the second
    -- surveyor is seated, so there is no phase anybody has to press a button
    -- to leave.
    status ENUM('lobby','play','over') NOT NULL DEFAULT 'lobby',
    -- Which language this room plays in. Whoever opens it picks once, and
    -- every joiner inherits it. Values come from views/seam/i18n/ui.json.
    lang CHAR(2) NOT NULL DEFAULT 'en',
    -- The section: 42 characters, row-major, ROW 0 IS THE SURFACE and row 5
    -- the basement. '.' is an empty bed, '1' and '2' are the two seats. That
    -- encoding is chosen so the twist is one string operation: drawing the
    -- bottom is seven dots followed by the first thirty-five characters.
    -- Deliberately no DEFAULT: the controller is the only source of a board,
    -- so an INSERT that forgets one should fail rather than invent one.
    board CHAR(42) NOT NULL,
    -- Whose cut it is, and who cut first this game. `starter` alternates
    -- between rematches so neither seat keeps the first-move advantage.
    turn TINYINT NOT NULL DEFAULT 1,
    starter TINYINT NOT NULL DEFAULT 1,
    -- Unspent draw permits, and whether that seat drew on its own previous
    -- turn. Together they are the anti-spam rule: a seat may cave at most
    -- CHARGES times per game and never twice running, which is what bounds
    -- the game at 42 + 2 * CHARGES * 7 cuts and stops a deadlock.
    -- No DEFAULT for the same reason as `board`.
    charges_1 TINYINT NOT NULL,
    charges_2 TINYINT NOT NULL,
    cooling_1 TINYINT NOT NULL DEFAULT 0,
    cooling_2 TINYINT NOT NULL DEFAULT 0,
    moves SMALLINT NOT NULL DEFAULT 0,
    -- Settled once, at the moment the section is struck or stalls, so the
    -- result never depends on who is still connected when it is read.
    -- Spelled p1/p2 rather than 1/2 because an ENUM of digit strings is a
    -- MySQL footgun: outcome = 1 would mean the first member, not the value.
    outcome ENUM('p1','p2','draw') DEFAULT NULL,
    -- The struck cells as a comma-separated list, so the plate can draw its
    -- fault stroke along exactly the four beds that won it.
    seam VARCHAR(64) DEFAULT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_active DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_seam_rooms_idle (last_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS seam_players (
    id INT AUTO_INCREMENT PRIMARY KEY,
    room_id INT NOT NULL,
    token_hash CHAR(64) NOT NULL UNIQUE,
    name VARCHAR(20) NOT NULL,
    -- 1 or 2. Deliberately NOT unique per room: a lobby player who walks out
    -- leaves a row behind, and the seat must be free again. The race is shut
    -- instead by locking the room row inside the join transaction, which is
    -- the same claim-then-count trick the verdict write uses.
    seat TINYINT NOT NULL,
    is_host TINYINT NOT NULL DEFAULT 0,
    -- Survives rematches, so a pair can play a series in one room.
    wins SMALLINT NOT NULL DEFAULT 0,
    -- Has this surveyor asked for another section. Both must ask before one
    -- opens, so nobody has the result wiped out from under them while they
    -- are still reading it. Cleared the moment the new section is dealt.
    wants_again TINYINT NOT NULL DEFAULT 0,
    joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    left_at DATETIME DEFAULT NULL,
    INDEX idx_seam_players_room (room_id),
    CONSTRAINT fk_seam_players_room FOREIGN KEY (room_id)
        REFERENCES seam_rooms(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The event log. id doubles as the sync cursor: clients poll with the last
-- id they have seen and receive everything newer for their room, so the
-- composite (room_id, id) index is the hot path of the whole feature. Rows
-- here carry only the EDGES worth animating (a cut, a cave, a verdict); the
-- section itself always comes from the poll snapshot, so a phone that
-- resumed past a page of events still renders the right board.
CREATE TABLE IF NOT EXISTS seam_events (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    room_id INT NOT NULL,
    player_id INT DEFAULT NULL,
    type VARCHAR(16) NOT NULL,
    data MEDIUMTEXT DEFAULT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_seam_events_room_seq (room_id, id),
    CONSTRAINT fk_seam_events_room FOREIGN KEY (room_id)
        REFERENCES seam_rooms(id) ON DELETE CASCADE,
    CONSTRAINT fk_seam_events_player FOREIGN KEY (player_id)
        REFERENCES seam_players(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
