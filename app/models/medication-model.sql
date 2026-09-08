-- Medication: private medication tracker (views/medication).
--
-- Single-owner tool. Every branch of medication-controller.php sits behind
-- Auth::requireAdmin(), so rows carry no user_id at all, the same shape as
-- compass-model.sql. Nothing here is public.
--
-- Requires auth-model.sql first (for the projects table).
-- Run manually in phpMyAdmin. Safe to re-run.
--
-- Two different verbs, and they are not interchangeable:
--   ends_on     the course is finished. The medication drops off the Today
--               view on its own from that date, and its history stays.
--   deleted_at  the medication is gone. It leaves every view, history
--               included, so a day's taken count can never exceed what was
--               planned for it. Reads filter deleted_at IS NULL everywhere.

-- The projects row exists ONLY so the Dashboard launcher tile can be gated on
-- it: a dashboard_apps row with a NULL project_id is offered to EVERY signed-in
-- user, which is exactly backwards for a private tool. The controller still
-- gates on requireAdmin(); site admins pass project checks implicitly, so the
-- two agree. Do not grant anyone a role here.
INSERT INTO projects (project_key, name) VALUES ('medication', 'Medication')
ON DUPLICATE KEY UPDATE active = 1;

-- The shelf: what is being taken, and how often.
CREATE TABLE IF NOT EXISTS medication_meds (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    -- Free string rather than an ENUM so adding a shape is not a migration.
    -- Validated against an allowlist in medication-controller.php that mirrors
    -- FORMS in views/medication/logic.js; edit the three together.
    form VARCHAR(20) NOT NULL DEFAULT 'tablet',
    doses_per_day TINYINT UNSIGNED NOT NULL DEFAULT 1,
    starts_on DATE DEFAULT NULL,
    ends_on DATE DEFAULT NULL,
    deleted_at DATETIME DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_medication_meds_deleted (deleted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The log. A row exists IF AND ONLY IF that slot was taken: there is no
-- boolean column, un-taking a dose is a DELETE. The unique key is what makes
-- the PUT idempotent, so a tap retried on a bad connection is harmless.
--
-- `slot` is an index within the day, not a time. The schedule is a count
-- ("three times a day"), so slots are interchangeable and the view draws them
-- as a counter; see the notch section of views/medication/logic.js.
CREATE TABLE IF NOT EXISTS medication_doses (
    id INT AUTO_INCREMENT PRIMARY KEY,
    med_id INT NOT NULL,
    day DATE NOT NULL,
    slot TINYINT UNSIGNED NOT NULL,
    taken_at DATETIME NOT NULL,
    UNIQUE KEY uq_medication_doses_slot (med_id, day, slot),
    INDEX idx_medication_doses_day (day),
    CONSTRAINT fk_medication_doses_med FOREIGN KEY (med_id)
        REFERENCES medication_meds(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
