-- Sourdough tracker: one portal per user. Signed-out visitors get a read-only
-- demo of the site owner's starter and loaves (first active admin); every
-- signed-in user gets their own starter (auto-created on first use) and breads.
-- Requires auth-model.sql (users) to have been run first. Run manually in phpMyAdmin.

-- One starter per user. The controller lazily creates a row the first time a
-- signed-in user touches their starter, so there is no seed INSERT here.
CREATE TABLE IF NOT EXISTS sourdough_starter (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    name VARCHAR(100) NOT NULL DEFAULT 'Starter',
    last_fed_at DATETIME DEFAULT NULL,
    in_fridge TINYINT(1) NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_starter_user (user_id),
    CONSTRAINT fk_starter_user FOREIGN KEY (user_id)
        REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sourdough_breads (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    name VARCHAR(100) NOT NULL,
    phase ENUM('bulk_fermentation','cold_proof','bench_rest','bake_lid','bake_no_lid','finished') NOT NULL DEFAULT 'bulk_fermentation',
    mixed_at DATETIME NOT NULL,
    folds JSON NOT NULL,
    folds_done_at DATETIME DEFAULT NULL,
    cold_proof_at DATETIME DEFAULT NULL,
    bench_rest_at DATETIME DEFAULT NULL,
    bake_lid_at DATETIME DEFAULT NULL,
    bake_no_lid_at DATETIME DEFAULT NULL,
    finished_at DATETIME DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_breads_user (user_id),
    CONSTRAINT fk_breads_user FOREIGN KEY (user_id)
        REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Migration (2026-07) for pre-existing single-audience tables without user_id.
-- Run once, in order; skip on a fresh install. Existing starter + breads are
-- backfilled to the site admin, whose portal doubles as the public demo. The
-- old global starter had one seeded row (there is no per-user seed anymore).
--
-- ALTER TABLE sourdough_starter ADD COLUMN user_id INT DEFAULT NULL AFTER id;
-- ALTER TABLE sourdough_breads  ADD COLUMN user_id INT DEFAULT NULL AFTER id;

-- SET @admin_id = (SELECT id FROM users WHERE is_admin = 1 AND is_active = 1 ORDER BY id LIMIT 1);
-- UPDATE sourdough_starter SET user_id = @admin_id WHERE user_id IS NULL;
-- UPDATE sourdough_breads  SET user_id = @admin_id WHERE user_id IS NULL;

-- ALTER TABLE sourdough_starter
--     MODIFY user_id INT NOT NULL,
--     ADD UNIQUE KEY uq_starter_user (user_id),
--     ADD CONSTRAINT fk_starter_user FOREIGN KEY (user_id)
--         REFERENCES users(id) ON DELETE CASCADE;
-- ALTER TABLE sourdough_breads
--     MODIFY user_id INT NOT NULL,
--     ADD INDEX idx_breads_user (user_id),
--     ADD CONSTRAINT fk_breads_user FOREIGN KEY (user_id)
--         REFERENCES users(id) ON DELETE CASCADE;
