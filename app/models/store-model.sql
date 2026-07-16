-- Everbloom founding waitlist (views/store).
-- Public, unauthenticated writes via app/proxys/store.php: each row is one
-- email reserving a founding spot; a Telegram alert fires at insert time
-- (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID in .env). Re-submitting the same
-- email updates the chosen plan instead of duplicating the row. No reads
-- from the site except the aggregate count for the founding-spots line.
-- Apply manually via phpMyAdmin.

CREATE TABLE IF NOT EXISTS store_waitlist (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    email       VARCHAR(255)  NOT NULL,
    plan        VARCHAR(20)   NOT NULL DEFAULT 'petal-post',  -- forever | petal-post | curious
    note        VARCHAR(500)  NULL,          -- "who would get your first bouquet?"
    ip_hash     CHAR(64)      NULL,          -- sha256(ip + daily salt); coarse abuse tracing, not PII
    user_agent  VARCHAR(255)  NULL,
    notified    TINYINT(1)    NOT NULL DEFAULT 0,  -- Telegram alert delivered?
    created_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_store_email (email),
    INDEX idx_store_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
