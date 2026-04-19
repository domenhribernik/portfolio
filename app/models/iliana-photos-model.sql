CREATE TABLE IF NOT EXISTS iliana_photos (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    image_id   INT NOT NULL,
    caption    VARCHAR(500) NOT NULL,
    photo_date DATE NOT NULL,
    added_by   ENUM('Domen', 'Iliana') NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_iliana_photos_image FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE,
    INDEX idx_photo_date (photo_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;