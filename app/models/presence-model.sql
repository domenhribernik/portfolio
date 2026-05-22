-- Presence — schema for the private LDR self-tracking tool at views/presence/.
-- Run manually in phpMyAdmin. Safe to re-run: all CREATEs use IF NOT EXISTS,
-- and the settings seed uses ON DUPLICATE KEY UPDATE to preserve existing values.

-- 1) Daily entries — one row per calendar day.
CREATE TABLE IF NOT EXISTS presence_daily (
    id INT AUTO_INCREMENT PRIMARY KEY,
    entry_date DATE NOT NULL UNIQUE,

    -- Concrete behaviors. TINYINT: 1 = yes, 0 = no, NULL = not applicable today.
    good_morning TINYINT DEFAULT NULL,
    good_night TINYINT DEFAULT NULL,
    voice_or_video TINYINT DEFAULT NULL,
    unprompted_thinking_of_you TINYINT DEFAULT NULL,
    present_when_we_talked TINYINT DEFAULT NULL,

    -- The honest counter. Lower is better.
    silent_leaves INT NOT NULL DEFAULT 0,

    -- NMMNG reflection fields.
    reflection TEXT DEFAULT NULL,
    covert_contract_noticed TEXT DEFAULT NULL,
    where_i_showed_up TEXT DEFAULT NULL,

    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2) Trigger log — many rows per day.
CREATE TABLE IF NOT EXISTS presence_triggers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    entry_date DATE NOT NULL,
    occurred_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    situation TEXT NOT NULL,
    what_i_did TEXT NOT NULL,
    what_i_could_do_next_time TEXT DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_entry_date (entry_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3) Personal CRM for things she's mentioned, so they don't fall through the cracks.
CREATE TABLE IF NOT EXISTS presence_she_mentioned (
    id INT AUTO_INCREMENT PRIMARY KEY,
    topic VARCHAR(255) NOT NULL,
    detail TEXT DEFAULT NULL,
    mentioned_on DATE NOT NULL,
    follow_up_by DATE DEFAULT NULL,
    followed_up TINYINT NOT NULL DEFAULT 0,
    followed_up_on DATE DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_follow_up_by (follow_up_by, followed_up)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4) Weekly review — one row per ISO week.
CREATE TABLE IF NOT EXISTS presence_weekly (
    id INT AUTO_INCREMENT PRIMARY KEY,
    year_week CHAR(7) NOT NULL UNIQUE,  -- e.g. '2026-W21'
    presence_score TINYINT DEFAULT NULL,        -- 1..10
    initiation_score TINYINT DEFAULT NULL,
    consistency_score TINYINT DEFAULT NULL,
    depth_score TINYINT DEFAULT NULL,
    what_she_said_she_needed TEXT DEFAULT NULL,
    where_i_made_her_chase_me TEXT DEFAULT NULL,
    next_week_one_thing TEXT DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5) Settings — key/value config editable from the UI.
CREATE TABLE IF NOT EXISTS presence_settings (
    setting_key VARCHAR(64) PRIMARY KEY,
    setting_value VARCHAR(255) NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO presence_settings (setting_key, setting_value) VALUES
    ('her_timezone',     'Europe/Ljubljana'),
    ('next_visit_date',  ''),
    ('last_visit_date',  '')
ON DUPLICATE KEY UPDATE setting_value = setting_value;
