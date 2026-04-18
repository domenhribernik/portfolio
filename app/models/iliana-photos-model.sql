CREATE TABLE IF NOT EXISTS iliana_photos (
    id INT AUTO_INCREMENT PRIMARY KEY,
    uuid VARCHAR(36) NOT NULL UNIQUE,
    mime_type VARCHAR(50) NOT NULL DEFAULT 'image/webp',
    width INT DEFAULT NULL,
    height INT DEFAULT NULL,
    file_size INT DEFAULT NULL,
    caption VARCHAR(500) NOT NULL,
    photo_date DATE NOT NULL,
    added_by ENUM('Domen', 'Iliana') NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_photo_date (photo_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
