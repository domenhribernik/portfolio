-- Contact form submissions from the homepage colophon.
-- Public, unauthenticated writes via app/proxys/contact.php: each row is the
-- durable record of a message; delivery is a Telegram alert fired at insert
-- time (reusing TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID in .env). No reads from
-- the site; the admin inspects rows directly. Apply manually via phpMyAdmin.

CREATE TABLE IF NOT EXISTS contact_messages (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    name        VARCHAR(120)  NOT NULL,
    email       VARCHAR(255)  NOT NULL,
    message     TEXT          NOT NULL,
    ip_hash     CHAR(64)      NULL,          -- sha256(ip + daily salt); coarse abuse tracing, not PII
    user_agent  VARCHAR(255)  NULL,
    notified    TINYINT(1)    NOT NULL DEFAULT 0,  -- Telegram alert delivered?
    created_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_contact_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
