-- Jeger foraging checklist: one saved checklist per user. The plant catalog
-- itself is hardcoded in the frontend (views/jeger/script.js); the only stored
-- state is which herbs a user has ticked off, kept as a JSON map of
-- { plantId: true }. Signed-out visitors get a read-only demo of the site
-- owner's progress (first active admin); signed-in users edit their own.
-- Requires auth-model.sql (users) to have been run first. Run manually in phpMyAdmin.
--
-- This replaces the old single shared JSON file at app/data/jeger-checklist.json,
-- which had no per-user separation. There is nothing to migrate: that file was
-- never populated in production.

CREATE TABLE IF NOT EXISTS jeger_checklists (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    checked JSON NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_jeger_user (user_id),
    CONSTRAINT fk_jeger_user FOREIGN KEY (user_id)
        REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
