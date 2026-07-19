-- Compass: private No More Mr. Nice Guy practice tracker (views/compass).
-- Single-owner tool: every branch of compass-controller.php sits behind
-- Auth::requireAdmin(), so rows carry no user_id. Nothing here is public.
-- Run manually in phpMyAdmin. Safe to re-run.
--
-- The practice keys, catch patterns and the 46 Breaking Free activity
-- numbers are defined in views/compass/logic.js (the single source of
-- truth); the controller validates against the same sets.

-- One row per LOCAL calendar day: which of the six daily practices were
-- kept, plus an optional journal note. practices is a JSON object of
-- practice_key -> bool (TEXT keeps it portable across MySQL versions).
CREATE TABLE IF NOT EXISTS compass_checkins (
    id INT AUTO_INCREMENT PRIMARY KEY,
    day DATE NOT NULL UNIQUE,
    practices TEXT NOT NULL,
    note TEXT DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The catch log: one row each time a Nice Guy pattern is noticed in the act
-- (approval seeking, covert contract, DEER, victim puke...). note = what
-- happened, instead = what I'll do differently next time.
CREATE TABLE IF NOT EXISTS compass_catches (
    id INT AUTO_INCREMENT PRIMARY KEY,
    pattern VARCHAR(20) NOT NULL,
    note TEXT DEFAULT NULL,
    instead TEXT DEFAULT NULL,
    caught_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_compass_catches_time (caught_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Workbook state for the book's 46 Breaking Free activities: one row per
-- exercise once it has been touched, upserted on activity_num.
CREATE TABLE IF NOT EXISTS compass_activities (
    id INT AUTO_INCREMENT PRIMARY KEY,
    activity_num TINYINT UNSIGNED NOT NULL UNIQUE,
    status ENUM('todo','doing','done') NOT NULL DEFAULT 'todo',
    note TEXT DEFAULT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
