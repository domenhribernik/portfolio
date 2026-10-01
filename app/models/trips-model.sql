-- Trips (views/trips): travel photo albums on a map.
--
-- A trip is an ordered chain of places; a place is an album of photos. A trip
-- has one owner and any number of travellers who joined through its invite
-- link. Every uuid is minted on the device, which is what lets the offline
-- outbox retry a create safely: the same uuid twice is the same row.
--
-- Requires auth-model.sql (users) and images-model.sql (images).
-- Idempotent: safe to re-run. The Dashboard tile lives in
-- seeds/dashboard-tile-trips.sql.

CREATE TABLE IF NOT EXISTS trips (
    id INT AUTO_INCREMENT PRIMARY KEY,
    uuid CHAR(36) NOT NULL,
    owner_id INT NOT NULL,
    name VARCHAR(120) NOT NULL,
    -- A key from the fixed set of line colours in views/trips/logic.js
    -- (LINE_COLOURS); the PHP list is held to it by tests/trips-logic.test.mjs.
    line VARCHAR(16) NOT NULL DEFAULT 'red',
    -- No FK: a photo FK here would close a trips > places > photos > trips cycle.
    -- A stale uuid simply renders as no cover.
    cover_photo_uuid CHAR(36) DEFAULT NULL,
    -- The invite link. Only the SHA-256 is stored, the token is shown once.
    token_hash CHAR(64) DEFAULT NULL,
    -- 1 on the single trip signed-out visitors see, NULL everywhere else.
    -- UNIQUE allows any number of NULLs and exactly one 1.
    showcase TINYINT DEFAULT NULL,
    -- Bumped on every change to the trip or anything in it, so a client can
    -- tell which of its offline snapshots are stale without a timestamp race.
    version INT NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_trips_uuid (uuid),
    UNIQUE KEY uq_trips_token (token_hash),
    UNIQUE KEY uq_trips_showcase (showcase),
    INDEX idx_trips_owner (owner_id),
    CONSTRAINT fk_trips_owner FOREIGN KEY (owner_id)
        REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Travellers only. The owner lives in trips.owner_id, so ownership has exactly
-- one source of truth.
CREATE TABLE IF NOT EXISTS trips_members (
    trip_id INT NOT NULL,
    user_id INT NOT NULL,
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (trip_id, user_id),
    INDEX idx_trips_members_user (user_id),
    CONSTRAINT fk_trips_members_trip FOREIGN KEY (trip_id)
        REFERENCES trips(id) ON DELETE CASCADE,
    CONSTRAINT fk_trips_members_user FOREIGN KEY (user_id)
        REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS trips_places (
    id INT AUTO_INCREMENT PRIMARY KEY,
    uuid CHAR(36) NOT NULL,
    trip_id INT NOT NULL,
    -- SET NULL: a place someone added to another person's trip outlives
    -- their account.
    created_by INT DEFAULT NULL,
    name VARCHAR(120) NOT NULL,
    lat DECIMAL(9,6) NOT NULL,
    lon DECIMAL(9,6) NOT NULL,
    country_code CHAR(2) DEFAULT NULL,
    -- Order along the line. Assigned by the server as MAX + 1; a reorder
    -- rewrites the whole trip in one transaction, so this is not UNIQUE.
    position INT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_trips_places_uuid (uuid),
    -- Target of the photos' composite FK, which keeps photo.trip_id from ever
    -- disagreeing with its place.
    UNIQUE KEY uq_trips_places_id_trip (id, trip_id),
    INDEX idx_trips_places_order (trip_id, position),
    INDEX idx_trips_places_creator (created_by),
    CONSTRAINT fk_trips_places_trip FOREIGN KEY (trip_id)
        REFERENCES trips(id) ON DELETE CASCADE,
    CONSTRAINT fk_trips_places_user FOREIGN KEY (created_by)
        REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS trips_photos (
    id INT AUTO_INCREMENT PRIMARY KEY,
    uuid CHAR(36) NOT NULL,
    trip_id INT NOT NULL,
    place_id INT NOT NULL,
    -- SET NULL: when an account is deleted, the photos it added to other
    -- people's trips stay there, unattributed (the shared-lists precedent).
    -- Photos in trips the account owned go with the trip.
    uploaded_by INT DEFAULT NULL,
    -- Two files per photo: the 2048px display copy and a 480px square thumb.
    -- Both live in assets/uploads/trips/, which is denied to the web; the
    -- controller serves them after a membership check.
    image_id INT NOT NULL,
    thumb_image_id INT NOT NULL,
    lat DECIMAL(9,6) NOT NULL,
    lon DECIMAL(9,6) NOT NULL,
    -- Where the coordinates came from. 'place' means approximate: the photo
    -- carried no location, so it sits at its place's own pin.
    loc_source ENUM('exif', 'device', 'place', 'manual') NOT NULL,
    -- The camera's wall clock, no zone: "14:32 in Bled" is what matters.
    taken_at DATETIME DEFAULT NULL,
    taken_offset_min SMALLINT DEFAULT NULL,
    caption VARCHAR(500) NOT NULL DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_trips_photos_uuid (uuid),
    UNIQUE KEY uq_trips_photos_image (image_id),
    UNIQUE KEY uq_trips_photos_thumb (thumb_image_id),
    INDEX idx_trips_photos_place (place_id, trip_id, taken_at),
    INDEX idx_trips_photos_trip (trip_id),
    INDEX idx_trips_photos_uploader (uploaded_by),
    CONSTRAINT fk_trips_photos_place FOREIGN KEY (place_id, trip_id)
        REFERENCES trips_places(id, trip_id) ON DELETE CASCADE,
    CONSTRAINT fk_trips_photos_user FOREIGN KEY (uploaded_by)
        REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_trips_photos_image FOREIGN KEY (image_id)
        REFERENCES images(id) ON DELETE CASCADE,
    CONSTRAINT fk_trips_photos_thumb FOREIGN KEY (thumb_image_id)
        REFERENCES images(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Uuids of deleted trips, places and photos. A phone that was offline when
-- something was deleted will still retry its queued create; without this the
-- retry would quietly bring the deleted thing back. Holds no personal data and
-- prunes itself on write after 180 days.
CREATE TABLE IF NOT EXISTS trips_tombstones (
    uuid CHAR(36) NOT NULL PRIMARY KEY,
    kind ENUM('trip', 'place', 'photo') NOT NULL,
    deleted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_trips_tombstones_age (deleted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
