CREATE TABLE IF NOT EXISTS sourdough_starter (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL DEFAULT 'Starter',
    last_fed_at DATETIME DEFAULT NULL,
    in_fridge TINYINT(1) NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO sourdough_starter (name) VALUES ('Starter');

CREATE TABLE IF NOT EXISTS sourdough_breads (
    id INT AUTO_INCREMENT PRIMARY KEY,
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
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
