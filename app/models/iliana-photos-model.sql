CREATE TABLE IF NOT EXISTS iliana_photos (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    image_id   INT NOT NULL,
    caption    VARCHAR(500) NOT NULL,
    photo_date DATE NOT NULL,
    added_by   VARCHAR(100) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_iliana_photos_image FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE,
    INDEX idx_photo_date (photo_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Writes are gated by Auth::requireProjectRole('iliana', 'editor') (SEC-02).
-- Requires auth-model.sql (users, projects, user_project_roles) to have been
-- run first. Grant the two editor roles from the views/admin dashboard.
INSERT INTO projects (project_key, name) VALUES ('iliana', 'Iliana')
ON DUPLICATE KEY UPDATE active = 1;

-- Migration for installs created before the SEC-02 fix, where added_by was
-- ENUM('Domen', 'Iliana'). added_by is now the session user's display name
-- (derived server-side, never taken from the request body). Run once,
-- manually via phpMyAdmin:
--   ALTER TABLE iliana_photos MODIFY added_by VARCHAR(100) NOT NULL;
