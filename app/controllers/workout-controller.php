<?php
declare(strict_types=1);
define('SECURE_ACCESS', true);

header('Content-Type: application/json; charset=utf-8');
// Responses vary with the session cookie, so they must never be cached.
header('Cache-Control: no-store');
// No Access-Control-Allow-Origin here: writes are gated by the session
// cookie, and wildcard CORS is incompatible with cookie auth.

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

require_once __DIR__ . '/../config/dev-mode.php';
require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../config/auth.php';

// Workout tracker (read-only demo plus per-user rows, same shape as
// plants/sourdough). Reads are public: signed out you get the site owner's
// workouts and history as a demo, signed in you get your own. Writes require
// login and are always scoped to the caller's own rows.
//
// Workouts and exercises use SOFT DELETE (deleted_at): every read filters
// deleted_at IS NULL and the assert helpers treat soft-deleted rows as
// missing, but session history keeps referencing them for analytics.
// Sessions are the user's own log entries and are hard-deleted on request.
//
// An exercise's `type` decides which metric fields apply and is immutable
// after creation; session sets reference exercise_id + round_number, never
// workout_items.id (items are rewritten wholesale on every workout save).

const WORKOUT_TYPES = ['reps', 'weighted', 'time', 'distance'];
const RESUME_WINDOW_HOURS = 12;

// Shared SELECT fragments (declared before the dispatch below runs, since
// top-level consts are not hoisted past an exit).
const EXERCISE_SELECT = '
    SELECT e.id, e.user_id, e.name, e.type, e.icon, e.note, e.created_at, e.updated_at,
           (SELECT COUNT(*) FROM workout_items wi
             JOIN workouts w ON w.id = wi.workout_id AND w.deleted_at IS NULL
             WHERE wi.exercise_id = e.id) AS used_by_workouts,
           EXISTS(SELECT 1 FROM workout_session_sets ss WHERE ss.exercise_id = e.id) AS has_history
    FROM workout_exercises e';

const WORKOUT_SELECT = '
    SELECT w.id, w.user_id, w.name, w.description, w.rounds, w.created_at, w.updated_at,
           (SELECT MAX(s.started_at) FROM workout_sessions s WHERE s.workout_id = w.id) AS last_session_at
    FROM workouts w';

$method   = $_SERVER['REQUEST_METHOD'];
$resource = $_GET['resource'] ?? null;
$action   = $_GET['action']   ?? null;
$id       = isset($_GET['id']) ? (int) $_GET['id'] : null;

try {
    if ($resource === 'session') {
        if ($method !== 'GET') sendError('Method not allowed', 405);
        getSession();
    } elseif ($resource === 'exercises') {
        if ($method !== 'GET') sendError('Method not allowed', 405);
        listExercises();
    } elseif ($resource === 'exercise') {
        handleExercise($method, $id);
    } elseif ($resource === 'workouts') {
        if ($method !== 'GET') sendError('Method not allowed', 405);
        listWorkouts();
    } elseif ($resource === 'workout') {
        handleWorkout($method, $id);
    } elseif ($resource === 'sessions') {
        handleSessions($method, $action, $id);
    } else {
        sendError('Unknown resource. Use ?resource=session, exercises, exercise, workouts, workout or sessions', 400);
    }
} catch (Exception $e) {
    error_log('Workout controller error: ' . $e->getMessage());
    sendError('Internal server error', 500);
}

// --- Helpers ---

function sendJson(mixed $data, int $code = 200): void
{
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

function sendError(string $message, int $code = 400): void
{
    http_response_code($code);
    echo json_encode(['error' => $message], JSON_UNESCAPED_UNICODE);
    exit;
}

function sanitize(string $value): string
{
    return htmlspecialchars(trim($value), ENT_QUOTES, 'UTF-8');
}

function readBody(): array
{
    if (!empty($_POST)) return $_POST;
    $raw = file_get_contents('php://input');
    if (!$raw) return [];
    $json = json_decode($raw, true);
    if (is_array($json)) return $json;
    parse_str($raw, $parsed);
    return is_array($parsed) ? $parsed : [];
}

/** The user whose workouts back the public demo: the first active site admin. */
function showcaseUserId(): ?int
{
    static $resolved = false;
    static $id = null;
    if (!$resolved) {
        $resolved = true;
        $found = Database::read()
            ->query('SELECT id FROM users WHERE is_admin = 1 AND is_active = 1 ORDER BY id LIMIT 1')
            ->fetchColumn();
        $id = $found === false ? null : (int) $found;
    }
    return $id;
}

/** Whose data the current request reads: the viewer's own, or the demo one. */
function shelfUserId(): ?int
{
    $viewer = Auth::currentUser();
    return $viewer !== null ? (int) $viewer['id'] : showcaseUserId();
}

function viewerPayload(?array $viewer): ?array
{
    return $viewer !== null ? [
        'id' => (int) $viewer['id'],
        'display_name' => $viewer['display_name'],
        'avatar_url' => $viewer['avatar_url'],
    ] : null;
}

/** Numeric value or null; blank/absent/non-numeric all read as null. */
function numOrNull(mixed $value): ?float
{
    if ($value === null || $value === '' || !is_numeric($value)) return null;
    return (float) $value;
}

/**
 * Validate the metric fields for one exercise type and return the full
 * normalized column set [reps, weight_kg, seconds, distance_m, pace_s_per_km]
 * with NULL for every column the type does not use. $prefix is 'target_'
 * (workout items) or 'actual_' (session sets).
 */
function normalizeMetrics(string $type, array $data, string $prefix, string $label): array
{
    $reps = $weight = $seconds = $distance = $pace = null;

    if ($type === 'reps' || $type === 'weighted') {
        $reps = numOrNull($data[$prefix . 'reps'] ?? null);
        if ($reps === null || $reps < 1 || $reps > 1000) {
            sendError("$label: reps must be between 1 and 1000", 400);
        }
        $reps = (int) $reps;
        if ($type === 'weighted') {
            $weight = numOrNull($data[$prefix . 'weight_kg'] ?? null);
            if ($weight === null || $weight < 0 || $weight > 9999.9) {
                sendError("$label: weight must be between 0 and 9999.9 kg", 400);
            }
        }
    } elseif ($type === 'time') {
        $seconds = numOrNull($data[$prefix . 'seconds'] ?? null);
        if ($seconds === null || $seconds < 1 || $seconds > 86400) {
            sendError("$label: duration must be between 1 and 86400 seconds", 400);
        }
        $seconds = (int) $seconds;
    } elseif ($type === 'distance') {
        $distance = numOrNull($data[$prefix . 'distance_m'] ?? null);
        if ($distance === null || $distance < 1 || $distance > 1000000) {
            sendError("$label: distance must be between 1 and 1000000 meters", 400);
        }
        $distance = (int) $distance;
        $pace = numOrNull($data[$prefix . 'pace_s_per_km'] ?? null);
        if ($pace !== null) {
            if ($pace < 60 || $pace > 3600) {
                sendError("$label: pace must be between 60 and 3600 seconds per km", 400);
            }
            $pace = (int) $pace;
        }
    }

    return [$reps, $weight, $seconds, $distance, $pace];
}

// --- Session probe ---

function getSession(): void
{
    $viewer = Auth::currentUser();
    sendJson([
        'demo' => $viewer === null,
        'viewer' => viewerPayload($viewer),
    ]);
}

// --- Exercises ---

function handleExercise(string $method, ?int $id): void
{
    switch ($method) {
        case 'POST':
            $user = Auth::requireLogin();
            createExercise($user);
            return;
        case 'PUT':
            $user = Auth::requireLogin();
            if (!$id) sendError('Exercise ID is required', 400);
            updateExercise($id, $user);
            return;
        case 'DELETE':
            $user = Auth::requireLogin();
            if (!$id) sendError('Exercise ID is required', 400);
            deleteExercise($id, $user);
            return;
        default:
            sendError('Method not allowed', 405);
    }
}

function formatExercise(array $row): array
{
    $row['id'] = (int) $row['id'];
    if (array_key_exists('used_by_workouts', $row)) $row['used_by_workouts'] = (int) $row['used_by_workouts'];
    if (array_key_exists('has_history', $row))      $row['has_history'] = (bool) $row['has_history'];
    unset($row['user_id'], $row['deleted_at']);
    return $row;
}

function listExercises(): void
{
    $viewer  = Auth::currentUser();
    $ownerId = $viewer !== null ? (int) $viewer['id'] : showcaseUserId();

    $exercises = [];
    if ($ownerId !== null) {
        $stmt = Database::read()->prepare(
            EXERCISE_SELECT . ' WHERE e.user_id = ? AND e.deleted_at IS NULL ORDER BY e.name'
        );
        $stmt->execute([$ownerId]);
        $exercises = array_map('formatExercise', $stmt->fetchAll());
    }

    sendJson([
        'demo' => $viewer === null,
        'viewer' => viewerPayload($viewer),
        'exercises' => $exercises,
    ]);
}

/** The caller's non-deleted exercise row, or 404. */
function fetchOwnExercise(int $id, array $user): array
{
    $stmt = Database::read()->prepare(
        EXERCISE_SELECT . ' WHERE e.id = ? AND e.user_id = ? AND e.deleted_at IS NULL'
    );
    $stmt->execute([$id, (int) $user['id']]);
    $row = $stmt->fetch();
    if (!$row) sendError('Exercise not found', 404);
    return $row;
}

/** Validated {name, icon, note} from the request body, or a 400. */
function exerciseFields(array $data): array
{
    $name = isset($data['name']) ? trim((string) $data['name']) : '';
    if ($name === '')           sendError('Name is required', 400);
    if (mb_strlen($name) > 100) sendError('Name must be 100 characters or less', 400);

    $icon = isset($data['icon']) ? trim((string) $data['icon']) : '';
    if ($icon !== '' && !preg_match('/^[a-z0-9 \-]{1,50}$/i', $icon)) {
        sendError('Icon must be FontAwesome classes (letters, digits, spaces, dashes)', 400);
    }

    $note = isset($data['note']) ? trim((string) $data['note']) : '';
    if (mb_strlen($note) > 500) sendError('Note must be 500 characters or less', 400);

    return [
        'name' => sanitize($name),
        'icon' => $icon === '' ? null : $icon,
        'note' => $note === '' ? null : sanitize($note),
    ];
}

function createExercise(array $user): void
{
    $data = readBody();
    $type = $data['type'] ?? '';
    if (!in_array($type, WORKOUT_TYPES, true)) {
        sendError('Type must be one of: ' . implode(', ', WORKOUT_TYPES), 400);
    }
    $fields = exerciseFields($data);

    $stmt = Database::write()->prepare(
        'INSERT INTO workout_exercises (user_id, name, type, icon, note) VALUES (?, ?, ?, ?, ?)'
    );
    $stmt->execute([(int) $user['id'], $fields['name'], $type, $fields['icon'], $fields['note']]);

    $id = (int) Database::write()->lastInsertId();
    sendJson(formatExercise(fetchOwnExercise($id, $user)), 201);
}

function updateExercise(int $id, array $user): void
{
    $existing = fetchOwnExercise($id, $user);

    $data = readBody();
    // Type is immutable: history and workout targets are validated against it.
    if (isset($data['type']) && $data['type'] !== $existing['type']) {
        sendError('Type cannot be changed. Create a new exercise instead.', 400);
    }
    $fields = exerciseFields($data);

    $stmt = Database::write()->prepare(
        'UPDATE workout_exercises SET name = ?, icon = ?, note = ? WHERE id = ? AND user_id = ?'
    );
    $stmt->execute([$fields['name'], $fields['icon'], $fields['note'], $id, (int) $user['id']]);

    sendJson(formatExercise(fetchOwnExercise($id, $user)));
}

function deleteExercise(int $id, array $user): void
{
    $exercise = fetchOwnExercise($id, $user);
    if ((int) $exercise['used_by_workouts'] > 0) {
        sendError('Exercise is used by a workout. Remove it from your workouts first.', 400);
    }

    $stmt = Database::write()->prepare(
        'UPDATE workout_exercises SET deleted_at = NOW() WHERE id = ? AND user_id = ?'
    );
    $stmt->execute([$id, (int) $user['id']]);

    sendJson(['message' => 'Exercise deleted']);
}

// --- Workouts ---

function handleWorkout(string $method, ?int $id): void
{
    switch ($method) {
        case 'POST':
            $user = Auth::requireLogin();
            saveWorkout($user, null);
            return;
        case 'PUT':
            $user = Auth::requireLogin();
            if (!$id) sendError('Workout ID is required', 400);
            fetchOwnWorkout($id, $user);
            saveWorkout($user, $id);
            return;
        case 'DELETE':
            $user = Auth::requireLogin();
            if (!$id) sendError('Workout ID is required', 400);
            deleteWorkout($id, $user);
            return;
        default:
            sendError('Method not allowed', 405);
    }
}

function formatWorkoutItem(array $row): array
{
    return [
        'exercise_id' => (int) $row['exercise_id'],
        'name' => $row['name'],
        'type' => $row['type'],
        'icon' => $row['icon'],
        'exercise_note' => $row['exercise_note'],
        'position' => (int) $row['position'],
        'target_reps' => $row['target_reps'] !== null ? (int) $row['target_reps'] : null,
        'target_weight_kg' => $row['target_weight_kg'] !== null ? (float) $row['target_weight_kg'] : null,
        'target_seconds' => $row['target_seconds'] !== null ? (int) $row['target_seconds'] : null,
        'target_distance_m' => $row['target_distance_m'] !== null ? (int) $row['target_distance_m'] : null,
        'target_pace_s_per_km' => $row['target_pace_s_per_km'] !== null ? (int) $row['target_pace_s_per_km'] : null,
        'note' => $row['note'],
    ];
}

function formatWorkout(array $row, array $items): array
{
    return [
        'id' => (int) $row['id'],
        'name' => $row['name'],
        'description' => $row['description'],
        'rounds' => (int) $row['rounds'],
        'last_session_at' => $row['last_session_at'] ?? null,
        'created_at' => $row['created_at'],
        'updated_at' => $row['updated_at'],
        'items' => $items,
    ];
}

/** Items for a set of workout ids, grouped by workout id, in position order. */
function fetchItemsFor(array $workoutIds): array
{
    if ($workoutIds === []) return [];
    $placeholders = implode(',', array_fill(0, count($workoutIds), '?'));
    $stmt = Database::read()->prepare(
        "SELECT wi.workout_id, wi.exercise_id, wi.position, wi.target_reps, wi.target_weight_kg,
                wi.target_seconds, wi.target_distance_m, wi.target_pace_s_per_km, wi.note,
                e.name, e.type, e.icon, e.note AS exercise_note
         FROM workout_items wi
         JOIN workout_exercises e ON e.id = wi.exercise_id
         WHERE wi.workout_id IN ($placeholders)
         ORDER BY wi.workout_id, wi.position"
    );
    $stmt->execute($workoutIds);
    $grouped = [];
    foreach ($stmt->fetchAll() as $row) {
        $grouped[(int) $row['workout_id']][] = formatWorkoutItem($row);
    }
    return $grouped;
}

function listWorkouts(): void
{
    $viewer  = Auth::currentUser();
    $ownerId = $viewer !== null ? (int) $viewer['id'] : showcaseUserId();

    $workouts = [];
    if ($ownerId !== null) {
        $stmt = Database::read()->prepare(
            WORKOUT_SELECT . ' WHERE w.user_id = ? AND w.deleted_at IS NULL ORDER BY w.created_at DESC'
        );
        $stmt->execute([$ownerId]);
        $rows  = $stmt->fetchAll();
        $items = fetchItemsFor(array_map(fn($r) => (int) $r['id'], $rows));
        foreach ($rows as $row) {
            $workouts[] = formatWorkout($row, $items[(int) $row['id']] ?? []);
        }
    }

    sendJson([
        'demo' => $viewer === null,
        'viewer' => viewerPayload($viewer),
        'workouts' => $workouts,
    ]);
}

/** The caller's non-deleted workout row, or 404. */
function fetchOwnWorkout(int $id, array $user): array
{
    $stmt = Database::read()->prepare(
        WORKOUT_SELECT . ' WHERE w.id = ? AND w.user_id = ? AND w.deleted_at IS NULL'
    );
    $stmt->execute([$id, (int) $user['id']]);
    $row = $stmt->fetch();
    if (!$row) sendError('Workout not found', 404);
    return $row;
}

/**
 * Create ($id null) or update a workout and its items atomically. Items are
 * deleted and rewritten in array order (recipes pattern), so item ids are
 * never stable and nothing may reference them.
 */
function saveWorkout(array $user, ?int $id): void
{
    $data = readBody();

    $name = isset($data['name']) ? trim((string) $data['name']) : '';
    if ($name === '')           sendError('Name is required', 400);
    if (mb_strlen($name) > 100) sendError('Name must be 100 characters or less', 400);

    $description = isset($data['description']) ? trim((string) $data['description']) : '';
    if (mb_strlen($description) > 500) sendError('Description must be 500 characters or less', 400);

    $rounds = numOrNull($data['rounds'] ?? null);
    if ($rounds === null || $rounds < 1 || $rounds > 10 || $rounds !== floor($rounds)) {
        sendError('Rounds must be a whole number between 1 and 10', 400);
    }
    $rounds = (int) $rounds;

    $items = $data['items'] ?? null;
    if (!is_array($items) || count($items) < 1)  sendError('A workout needs at least one exercise', 400);
    if (count($items) > 30)                      sendError('A workout can have at most 30 exercises', 400);

    $exerciseIds = [];
    foreach ($items as $item) {
        if (!is_array($item)) sendError('Malformed workout item', 400);
        $exerciseIds[] = (int) ($item['exercise_id'] ?? 0);
    }
    if (count(array_unique($exerciseIds)) !== count($exerciseIds)) {
        sendError('Each exercise can appear only once per workout', 400);
    }

    // Every referenced exercise must be the caller's own and not deleted.
    $placeholders = implode(',', array_fill(0, count($exerciseIds), '?'));
    $stmt = Database::read()->prepare(
        "SELECT id, type FROM workout_exercises
         WHERE user_id = ? AND deleted_at IS NULL AND id IN ($placeholders)"
    );
    $stmt->execute([(int) $user['id'], ...$exerciseIds]);
    $types = [];
    foreach ($stmt->fetchAll() as $row) {
        $types[(int) $row['id']] = $row['type'];
    }

    $rows = [];
    foreach ($items as $index => $item) {
        $exerciseId = (int) ($item['exercise_id'] ?? 0);
        if (!isset($types[$exerciseId])) sendError('Exercise not found', 404);

        $label = 'Exercise ' . ($index + 1);
        $note  = isset($item['note']) ? trim((string) $item['note']) : '';
        if (mb_strlen($note) > 255) sendError("$label: note must be 255 characters or less", 400);

        [$reps, $weight, $seconds, $distance, $pace] =
            normalizeMetrics($types[$exerciseId], $item, 'target_', $label);
        $rows[] = [$exerciseId, $index + 1, $reps, $weight, $seconds, $distance, $pace,
                   $note === '' ? null : sanitize($note)];
    }

    $db = Database::write();
    $db->beginTransaction();
    try {
        if ($id === null) {
            $stmt = $db->prepare('INSERT INTO workouts (user_id, name, description, rounds) VALUES (?, ?, ?, ?)');
            $stmt->execute([(int) $user['id'], sanitize($name),
                            $description === '' ? null : sanitize($description), $rounds]);
            $id = (int) $db->lastInsertId();
        } else {
            $stmt = $db->prepare('UPDATE workouts SET name = ?, description = ?, rounds = ? WHERE id = ? AND user_id = ?');
            $stmt->execute([sanitize($name), $description === '' ? null : sanitize($description),
                            $rounds, $id, (int) $user['id']]);
        }

        $db->prepare('DELETE FROM workout_items WHERE workout_id = ?')->execute([$id]);
        $insert = $db->prepare(
            'INSERT INTO workout_items (workout_id, exercise_id, position, target_reps, target_weight_kg,
                                        target_seconds, target_distance_m, target_pace_s_per_km, note)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        );
        foreach ($rows as $row) {
            $insert->execute([$id, ...$row]);
        }

        $db->commit();
    } catch (Exception $e) {
        $db->rollBack();
        throw $e;
    }

    $workout = fetchOwnWorkout($id, $user);
    $items   = fetchItemsFor([$id]);
    sendJson(formatWorkout($workout, $items[$id] ?? []));
}

function deleteWorkout(int $id, array $user): void
{
    fetchOwnWorkout($id, $user);

    // Soft delete: session history keeps its snapshot of this workout's runs.
    $stmt = Database::write()->prepare(
        'UPDATE workouts SET deleted_at = NOW() WHERE id = ? AND user_id = ?'
    );
    $stmt->execute([$id, (int) $user['id']]);

    sendJson(['message' => 'Workout deleted']);
}

// --- Sessions (run logs) ---

function handleSessions(string $method, ?string $action, ?int $id): void
{
    switch ($method) {
        case 'GET':
            if (isset($_GET['open'])) { getOpenSession(); return; }
            if ($id) { getSessionDetail($id); return; }
            listSessions();
            return;

        case 'POST':
            $user = Auth::requireLogin();
            if (!$id) { createSession($user); return; }
            if ($action === 'log')    { logSet($id, $user);         return; }
            if ($action === 'unlog')  { unlogSet($id, $user);       return; }
            if ($action === 'finish') { finishSession($id, $user);  return; }
            sendError('Unknown session action', 400);

        case 'DELETE':
            $user = Auth::requireLogin();
            if (!$id) sendError('Session ID is required', 400);
            deleteSession($id, $user);
            return;

        default:
            sendError('Method not allowed', 405);
    }
}

function formatSession(array $row, ?array $sets = null): array
{
    $out = [
        'id' => (int) $row['id'],
        'workout_id' => $row['workout_id'] !== null ? (int) $row['workout_id'] : null,
        'workout_name' => $row['workout_name'],
        'rounds' => (int) $row['rounds'],
        'started_at' => $row['started_at'],
        'finished_at' => $row['finished_at'],
        'note' => $row['note'],
    ];
    if (array_key_exists('set_count', $row)) $out['set_count'] = (int) $row['set_count'];
    if ($sets !== null) $out['sets'] = $sets;
    return $out;
}

function formatSet(array $row): array
{
    return [
        'exercise_id' => (int) $row['exercise_id'],
        'exercise_name' => $row['exercise_name'],
        'type' => $row['type'],
        'icon' => $row['icon'],
        'round_number' => (int) $row['round_number'],
        'actual_reps' => $row['actual_reps'] !== null ? (int) $row['actual_reps'] : null,
        'actual_weight_kg' => $row['actual_weight_kg'] !== null ? (float) $row['actual_weight_kg'] : null,
        'actual_seconds' => $row['actual_seconds'] !== null ? (int) $row['actual_seconds'] : null,
        'actual_distance_m' => $row['actual_distance_m'] !== null ? (int) $row['actual_distance_m'] : null,
        'actual_pace_s_per_km' => $row['actual_pace_s_per_km'] !== null ? (int) $row['actual_pace_s_per_km'] : null,
        'done_at' => $row['done_at'],
    ];
}

function fetchSets(int $sessionId): array
{
    $stmt = Database::read()->prepare(
        'SELECT ss.exercise_id, ss.round_number, ss.actual_reps, ss.actual_weight_kg, ss.actual_seconds,
                ss.actual_distance_m, ss.actual_pace_s_per_km, ss.done_at,
                e.name AS exercise_name, e.type, e.icon
         FROM workout_session_sets ss
         JOIN workout_exercises e ON e.id = ss.exercise_id
         WHERE ss.session_id = ?
         ORDER BY ss.round_number, ss.done_at'
    );
    $stmt->execute([$sessionId]);
    return array_map('formatSet', $stmt->fetchAll());
}

function listSessions(): void
{
    $viewer  = Auth::currentUser();
    $ownerId = $viewer !== null ? (int) $viewer['id'] : showcaseUserId();

    $sessions = [];
    if ($ownerId !== null) {
        // Transient rows (opened but nothing logged yet) stay hidden.
        $stmt = Database::read()->prepare(
            'SELECT s.id, s.workout_id, s.workout_name, s.rounds, s.started_at, s.finished_at, s.note,
                    COUNT(ss.id) AS set_count
             FROM workout_sessions s
             LEFT JOIN workout_session_sets ss ON ss.session_id = s.id
             WHERE s.user_id = ?
             GROUP BY s.id
             HAVING set_count > 0 OR s.finished_at IS NOT NULL
             ORDER BY s.started_at DESC
             LIMIT 50'
        );
        $stmt->execute([$ownerId]);
        $sessions = array_map('formatSession', $stmt->fetchAll());
    }

    sendJson([
        'demo' => $viewer === null,
        'viewer' => viewerPayload($viewer),
        'sessions' => $sessions,
    ]);
}

function getSessionDetail(int $id): void
{
    $ownerId = shelfUserId();
    if ($ownerId === null) sendError('Session not found', 404);

    $stmt = Database::read()->prepare(
        'SELECT id, workout_id, workout_name, rounds, started_at, finished_at, note
         FROM workout_sessions WHERE id = ? AND user_id = ?'
    );
    $stmt->execute([$id, $ownerId]);
    $session = $stmt->fetch();
    if (!$session) sendError('Session not found', 404);

    sendJson([
        'demo' => Auth::currentUser() === null,
        'viewer' => viewerPayload(Auth::currentUser()),
        'session' => formatSession($session, fetchSets($id)),
    ]);
}

/** The player's resume probe: latest open session for a workout, recent only. */
function getOpenSession(): void
{
    $viewer = Auth::currentUser();
    $workoutId = isset($_GET['workout_id']) ? (int) $_GET['workout_id'] : 0;
    if ($viewer === null || !$workoutId) {
        sendJson(['session' => null]);
    }

    $stmt = Database::read()->prepare(
        'SELECT id, workout_id, workout_name, rounds, started_at, finished_at, note
         FROM workout_sessions
         WHERE user_id = ? AND workout_id = ? AND finished_at IS NULL
           AND started_at > (NOW() - INTERVAL ' . RESUME_WINDOW_HOURS . ' HOUR)
         ORDER BY started_at DESC
         LIMIT 1'
    );
    $stmt->execute([(int) $viewer['id'], $workoutId]);
    $session = $stmt->fetch();

    sendJson(['session' => $session ? formatSession($session, fetchSets((int) $session['id'])) : null]);
}

/** The caller's session row, or 404. */
function fetchOwnSession(int $id, array $user): array
{
    $stmt = Database::read()->prepare(
        'SELECT id, workout_id, workout_name, rounds, started_at, finished_at, note
         FROM workout_sessions WHERE id = ? AND user_id = ?'
    );
    $stmt->execute([$id, (int) $user['id']]);
    $row = $stmt->fetch();
    if (!$row) sendError('Session not found', 404);
    return $row;
}

function createSession(array $user): void
{
    $data = readBody();
    $workoutId = (int) ($data['workout_id'] ?? 0);
    if (!$workoutId) sendError('Workout ID is required', 400);

    $workout = fetchOwnWorkout($workoutId, $user);

    // Snapshot name and rounds so history stays truthful after edits.
    $stmt = Database::write()->prepare(
        'INSERT INTO workout_sessions (user_id, workout_id, workout_name, rounds) VALUES (?, ?, ?, ?)'
    );
    $stmt->execute([(int) $user['id'], $workoutId, $workout['name'], (int) $workout['rounds']]);

    $id = (int) Database::write()->lastInsertId();
    sendJson(formatSession(fetchOwnSession($id, $user), []), 201);
}

function logSet(int $id, array $user): void
{
    $session = fetchOwnSession($id, $user);
    if ($session['finished_at'] !== null) sendError('Session is already finished', 400);

    $data = readBody();
    $exerciseId = (int) ($data['exercise_id'] ?? 0);
    if (!$exerciseId) sendError('Exercise ID is required', 400);

    // No deleted_at filter: a run may outlive a mid-session soft delete, and
    // history rows referencing the exercise are always valid.
    $stmt = Database::read()->prepare(
        'SELECT type FROM workout_exercises WHERE id = ? AND user_id = ?'
    );
    $stmt->execute([$exerciseId, (int) $user['id']]);
    $exercise = $stmt->fetch();
    if (!$exercise) sendError('Exercise not found', 404);

    $round = numOrNull($data['round_number'] ?? null);
    if ($round === null || $round < 1 || $round > (int) $session['rounds'] || $round !== floor($round)) {
        sendError('Round number must be between 1 and ' . (int) $session['rounds'], 400);
    }
    $round = (int) $round;

    [$reps, $weight, $seconds, $distance, $pace] =
        normalizeMetrics($exercise['type'], $data, 'actual_', 'Set');

    // Idempotent upsert on (session, exercise, round): re-logging updates.
    $stmt = Database::write()->prepare(
        'INSERT INTO workout_session_sets
            (session_id, exercise_id, round_number, actual_reps, actual_weight_kg,
             actual_seconds, actual_distance_m, actual_pace_s_per_km)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            actual_reps = VALUES(actual_reps),
            actual_weight_kg = VALUES(actual_weight_kg),
            actual_seconds = VALUES(actual_seconds),
            actual_distance_m = VALUES(actual_distance_m),
            actual_pace_s_per_km = VALUES(actual_pace_s_per_km),
            done_at = NOW()'
    );
    $stmt->execute([$id, $exerciseId, $round, $reps, $weight, $seconds, $distance, $pace]);

    $stmt = Database::read()->prepare(
        'SELECT ss.exercise_id, ss.round_number, ss.actual_reps, ss.actual_weight_kg, ss.actual_seconds,
                ss.actual_distance_m, ss.actual_pace_s_per_km, ss.done_at,
                e.name AS exercise_name, e.type, e.icon
         FROM workout_session_sets ss
         JOIN workout_exercises e ON e.id = ss.exercise_id
         WHERE ss.session_id = ? AND ss.exercise_id = ? AND ss.round_number = ?'
    );
    $stmt->execute([$id, $exerciseId, $round]);
    sendJson(formatSet($stmt->fetch()));
}

function unlogSet(int $id, array $user): void
{
    $session = fetchOwnSession($id, $user);
    if ($session['finished_at'] !== null) sendError('Session is already finished', 400);

    $data = readBody();
    $exerciseId = (int) ($data['exercise_id'] ?? 0);
    $round      = (int) ($data['round_number'] ?? 0);
    if (!$exerciseId || !$round) sendError('Exercise ID and round number are required', 400);

    $stmt = Database::write()->prepare(
        'DELETE FROM workout_session_sets WHERE session_id = ? AND exercise_id = ? AND round_number = ?'
    );
    $stmt->execute([$id, $exerciseId, $round]);

    sendJson(['message' => 'Set removed']);
}

function finishSession(int $id, array $user): void
{
    $session = fetchOwnSession($id, $user);
    if ($session['finished_at'] !== null) sendError('Session is already finished', 400);

    $stmt = Database::read()->prepare('SELECT COUNT(*) FROM workout_session_sets WHERE session_id = ?');
    $stmt->execute([$id]);
    if ((int) $stmt->fetchColumn() === 0) {
        sendError('Nothing logged yet. Discard the session instead.', 400);
    }

    $data = readBody();
    $note = isset($data['note']) ? trim((string) $data['note']) : '';
    if (mb_strlen($note) > 500) sendError('Note must be 500 characters or less', 400);

    $stmt = Database::write()->prepare(
        'UPDATE workout_sessions SET finished_at = NOW(), note = ? WHERE id = ? AND user_id = ?'
    );
    $stmt->execute([$note === '' ? null : sanitize($note), $id, (int) $user['id']]);

    sendJson(formatSession(fetchOwnSession($id, $user), fetchSets($id)));
}

function deleteSession(int $id, array $user): void
{
    fetchOwnSession($id, $user);

    // Sessions are the user's own log entries: hard delete on request
    // (a reset mid-run, or removing a history row). Sets cascade.
    $stmt = Database::write()->prepare(
        'DELETE FROM workout_sessions WHERE id = ? AND user_id = ?'
    );
    $stmt->execute([$id, (int) $user['id']]);

    sendJson(['message' => 'Session deleted']);
}
