CREATE TABLE IF NOT EXISTS pricing_quotes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    ip_address VARCHAR(45) NOT NULL,
    user_agent VARCHAR(500) DEFAULT NULL,
    suggested_package VARCHAR(20) NOT NULL,
    total_price INT NOT NULL,
    selections JSON NOT NULL,
    special_requests TEXT DEFAULT NULL,
    contact_name VARCHAR(100) DEFAULT NULL,
    contact_email VARCHAR(255) DEFAULT NULL,
    message TEXT DEFAULT NULL,
    contacted TINYINT(1) NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Run manually if the table already exists (prod already has this table live):
-- ALTER TABLE pricing_quotes ADD COLUMN contacted TINYINT(1) NOT NULL DEFAULT 0 AFTER message;
