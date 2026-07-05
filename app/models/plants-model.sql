-- Botaniq plants: one shelf per user. Signed-out visitors get a read-only
-- demo of the site owner's shelf (first active admin); every signed-in user
-- gets their own rows. Requires auth-model.sql (users) to have been run first.
-- Run manually in phpMyAdmin.

CREATE TABLE IF NOT EXISTS plants (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    name VARCHAR(255) NOT NULL,
    nickname VARCHAR(255) DEFAULT NULL,
    type VARCHAR(255) NOT NULL,
    description TEXT NOT NULL,
    watering_frequency_text VARCHAR(255) NOT NULL,
    watering_min_days INT NOT NULL,
    watering_max_days INT NOT NULL,
    light VARCHAR(255) NOT NULL,
    humidity VARCHAR(255) NOT NULL,
    temperature VARCHAR(100) NOT NULL,
    soil VARCHAR(255) NOT NULL,
    common_issues JSON NOT NULL,
    useful_tips JSON NOT NULL,
    image_data LONGBLOB DEFAULT NULL,
    image_mime VARCHAR(50) DEFAULT NULL,
    last_watered DATETIME DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_plants_user (user_id),
    CONSTRAINT fk_plants_user FOREIGN KEY (user_id)
        REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Migration (2026-07) for a pre-existing plants table without user_id.
-- Run these three statements once, in order; skip on a fresh install.
-- Existing plants are backfilled to the site admin, whose shelf doubles
-- as the public demo.
--
-- ALTER TABLE plants ADD COLUMN user_id INT DEFAULT NULL AFTER id;

-- UPDATE plants SET user_id =
--     (SELECT id FROM users WHERE is_admin = 1 AND is_active = 1 ORDER BY id LIMIT 1)
--     WHERE user_id IS NULL;

-- ALTER TABLE plants
--     MODIFY user_id INT NOT NULL,
--     ADD INDEX idx_plants_user (user_id),
--     ADD CONSTRAINT fk_plants_user FOREIGN KEY (user_id)
--         REFERENCES users(id) ON DELETE CASCADE;
