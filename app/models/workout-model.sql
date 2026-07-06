-- Workout tracker: multiple workouts per user, built from a per-user exercise
-- library, with every performed set logged for later progression analytics.
-- Read-only demo plus per-user rows (same shape as plants/sourdough): signed-out
-- visitors see the first active admin's workouts, signed-in users their own.
-- Requires auth-model.sql (users) to have been run first. Run manually in phpMyAdmin.
--
-- This model introduces SOFT DELETE (deleted_at) for workouts and exercises:
-- rows are hidden, never removed, so session history stays analyzable. Sessions
-- themselves are the user's own log entries and are hard-deleted on request.
--
-- Exercise `type` decides which metric columns apply and is immutable after
-- creation (the controller rejects type changes). Adding a fifth type later
-- means a manual ALTER TABLE of both ENUM-adjacent metric column sets here.

-- Per-user exercise library. type: reps (bodyweight reps), weighted (reps at a
-- weight), time (hold/duration), distance (run with optional pace).
CREATE TABLE IF NOT EXISTS workout_exercises (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    name VARCHAR(100) NOT NULL,
    type ENUM('reps','weighted','time','distance') NOT NULL,
    icon VARCHAR(50) DEFAULT NULL,
    note VARCHAR(500) DEFAULT NULL,
    deleted_at DATETIME DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_workout_exercises_user (user_id),
    CONSTRAINT fk_workout_exercises_user FOREIGN KEY (user_id)
        REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A workout is a named circuit: `rounds` passes over every item in order.
CREATE TABLE IF NOT EXISTS workouts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    name VARCHAR(100) NOT NULL,
    description VARCHAR(500) DEFAULT NULL,
    rounds TINYINT UNSIGNED NOT NULL DEFAULT 3,
    deleted_at DATETIME DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_workouts_user (user_id),
    CONSTRAINT fk_workouts_user FOREIGN KEY (user_id)
        REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Items are rewritten wholesale on every workout save (recipes pattern), so
-- their ids are NOT stable; nothing else may reference workout_items.id.
-- Only the target columns matching the exercise's type are non-NULL.
CREATE TABLE IF NOT EXISTS workout_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    workout_id INT NOT NULL,
    exercise_id INT NOT NULL,
    position INT NOT NULL,
    target_reps INT DEFAULT NULL,
    target_weight_kg DECIMAL(5,1) DEFAULT NULL,
    target_seconds INT DEFAULT NULL,
    target_distance_m INT DEFAULT NULL,
    target_pace_s_per_km INT DEFAULT NULL,
    note VARCHAR(255) DEFAULT NULL,
    UNIQUE KEY uq_workout_items_exercise (workout_id, exercise_id),
    CONSTRAINT fk_workout_items_workout FOREIGN KEY (workout_id)
        REFERENCES workouts(id) ON DELETE CASCADE,
    CONSTRAINT fk_workout_items_exercise FOREIGN KEY (exercise_id)
        REFERENCES workout_exercises(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per run of a workout. Name and rounds are snapshotted at start so
-- history stays truthful after the workout is renamed or edited. Created
-- lazily on the first completed set; finished_at NULL = incomplete run.
CREATE TABLE IF NOT EXISTS workout_sessions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    workout_id INT DEFAULT NULL,
    workout_name VARCHAR(100) NOT NULL,
    rounds TINYINT UNSIGNED NOT NULL,
    started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at DATETIME DEFAULT NULL,
    note VARCHAR(500) DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_workout_sessions_user (user_id, started_at),
    CONSTRAINT fk_workout_sessions_user FOREIGN KEY (user_id)
        REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_workout_sessions_workout FOREIGN KEY (workout_id)
        REFERENCES workouts(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per completed set: exercise X, round N, with the actuals the user
-- performed. Keyed by (session, exercise, round) so logging is an idempotent
-- upsert; sets reference the exercise directly (never workout_items, whose ids
-- are unstable). idx_session_sets_exercise is the progression-dashboard path:
-- all sets of one exercise over time.
CREATE TABLE IF NOT EXISTS workout_session_sets (
    id INT AUTO_INCREMENT PRIMARY KEY,
    session_id INT NOT NULL,
    exercise_id INT NOT NULL,
    round_number TINYINT UNSIGNED NOT NULL,
    actual_reps INT DEFAULT NULL,
    actual_weight_kg DECIMAL(5,1) DEFAULT NULL,
    actual_seconds INT DEFAULT NULL,
    actual_distance_m INT DEFAULT NULL,
    actual_pace_s_per_km INT DEFAULT NULL,
    done_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_session_set (session_id, exercise_id, round_number),
    INDEX idx_session_sets_exercise (exercise_id, done_at),
    CONSTRAINT fk_session_sets_session FOREIGN KEY (session_id)
        REFERENCES workout_sessions(id) ON DELETE CASCADE,
    CONSTRAINT fk_session_sets_exercise FOREIGN KEY (exercise_id)
        REFERENCES workout_exercises(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed (2026-07): recreates the previously hardcoded calisthenics plan for the
-- site admin so the public demo is not empty. Run once in phpMyAdmin, then
-- leave commented; a fresh install stays seedless per repo convention.
--
-- SET @admin_id = (SELECT id FROM users WHERE is_admin = 1 AND is_active = 1 ORDER BY id LIMIT 1);

-- INSERT INTO workout_exercises (user_id, name, type, icon, note) VALUES
--     (@admin_id, 'Muscle-ups', 'reps', 'fas fa-arrows-up-to-line', 'Band is fine, quality over quantity. Rest 2 to 3 min between sets.'),
--     (@admin_id, 'Push-ups',   'reps', 'fas fa-person-falling',    'Push close to failure. Control the descent.'),
--     (@admin_id, 'Chin-ups',   'reps', 'fas fa-person-rays',       'Close to failure. Full hang at the bottom, chin over bar.'),
--     (@admin_id, 'Dips',       'reps', 'fas fa-arrow-down',        'Slight forward lean for chest emphasis.');

-- INSERT INTO workouts (user_id, name, description, rounds) VALUES
--     (@admin_id, 'Calisthenics', 'The classic bodyweight circuit: bar and floor, nothing else.', 3);
-- SET @workout_id = LAST_INSERT_ID();

-- INSERT INTO workout_items (workout_id, exercise_id, position, target_reps)
-- SELECT @workout_id, e.id, o.position, o.reps
-- FROM (SELECT 'Muscle-ups' AS name, 1 AS position, 4  AS reps
--       UNION ALL SELECT 'Push-ups', 2, 15
--       UNION ALL SELECT 'Chin-ups', 3, 8
--       UNION ALL SELECT 'Dips',     4, 5) o
-- JOIN workout_exercises e ON e.name = o.name AND e.user_id = @admin_id;
