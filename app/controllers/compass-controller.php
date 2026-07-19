<?php
declare(strict_types=1);
define('SECURE_ACCESS', true);

header('Content-Type: application/json; charset=utf-8');
// Responses vary with the session cookie, so they must never be cached.
header('Cache-Control: no-store');
// No Access-Control-Allow-Origin here: everything is gated by the session
// cookie, and wildcard CORS is incompatible with cookie auth.

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

require_once __DIR__ . '/../config/dev-mode.php';
require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../config/auth.php';

// Compass: the private No More Mr. Nice Guy practice tracker backend
// (views/compass). Single-owner personal tool: EVERY branch, reads included,
// sits behind Auth::requireAdmin(), and rows carry no user_id.
//
// The practice keys, catch patterns and activity count mirror
// views/compass/logic.js, the single source of truth for the program.

Auth::requireAdmin();

const PRACTICE_KEYS = ['seen', 'present', 'direct', 'nostrings', 'self', 'lead'];
const PATTERN_KEYS = ['approval', 'covert', 'caretake', 'hide', 'deer', 'victim', 'avoid', 'settle'];
const ACTIVITY_STATUSES = ['todo', 'doing', 'done'];
const ACTIVITY_COUNT = 46;
const NOTE_MAX = 2000;
const CATCH_LIMIT = 300;

$method   = $_SERVER['REQUEST_METHOD'];
$resource = $_GET['resource'] ?? null;
$id       = isset($_GET['id']) ? (int) $_GET['id'] : null;

try {
    if ($resource === 'state') {
        if ($method !== 'GET') sendError('Method not allowed', 405);
        getState();
    } elseif ($resource === 'checkin') {
        if ($method !== 'POST') sendError('Method not allowed', 405);
        saveCheckin(readBody());
    } elseif ($resource === 'catch') {
        if ($method === 'POST') {
            createCatch(readBody());
        } elseif ($method === 'DELETE') {
            deleteCatch($id);
        } else {
            sendError('Method not allowed', 405);
        }
    } elseif ($resource === 'activity') {
        if ($method !== 'POST') sendError('Method not allowed', 405);
        saveActivity(readBody());
    } else {
        sendError('Unknown resource. Use ?resource=state, checkin, catch or activity', 400);
    }
} catch (Exception $e) {
    error_log('Compass controller error: ' . $e->getMessage());
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

function readBody(): array
{
    $raw = file_get_contents('php://input');
    if (!$raw) return [];
    $json = json_decode($raw, true);
    return is_array($json) ? $json : [];
}

// --- State: everything the page needs in one payload ---

function getState(): void
{
    $db = Database::read();

    // All check-ins: one tiny row per day, so even years of history stay a
    // small payload, and streak math never loses its tail.
    $checkins = $db->query(
        'SELECT day, practices, note FROM compass_checkins ORDER BY day DESC'
    );
    $checkinRows = array_map(static function (array $row): array {
        $practices = json_decode((string) $row['practices'], true);
        return [
            'day' => $row['day'],
            'practices' => is_array($practices) ? $practices : [],
            'note' => $row['note'],
        ];
    }, $checkins->fetchAll());

    $catches = $db->query(
        'SELECT id, pattern, note, instead, caught_at FROM compass_catches
         ORDER BY caught_at DESC, id DESC LIMIT ' . CATCH_LIMIT
    )->fetchAll();
    foreach ($catches as &$c) {
        $c['id'] = (int) $c['id'];
    }
    unset($c);

    $activities = $db->query(
        'SELECT activity_num, status, note FROM compass_activities ORDER BY activity_num'
    )->fetchAll();
    foreach ($activities as &$a) {
        $a['num'] = (int) $a['activity_num'];
        unset($a['activity_num']);
    }
    unset($a);

    sendJson([
        'checkins' => $checkinRows,
        'catches' => $catches,
        'activities' => $activities,
    ]);
}

// --- Check-ins: one row per local day, upserted ---

/** Validate an optional note field; exits with 422 when over the cap. */
function cleanNote(array $body, string $field = 'note'): ?string
{
    $note = trim((string) ($body[$field] ?? ''));
    if (mb_strlen($note) > NOTE_MAX) sendError('Note is too long', 422);
    return $note !== '' ? $note : null;
}

function saveCheckin(array $body): void
{
    $day = (string) ($body['day'] ?? '');
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $day) || !strtotime($day)) {
        sendError('Invalid day', 422);
    }

    $raw = $body['practices'] ?? [];
    if (!is_array($raw)) sendError('practices must be an object', 422);
    $practices = [];
    foreach ($raw as $key => $value) {
        if (!in_array($key, PRACTICE_KEYS, true)) sendError("Unknown practice: $key", 422);
        $practices[$key] = (bool) $value;
    }
    $note = cleanNote($body);

    $stmt = Database::write()->prepare(
        'INSERT INTO compass_checkins (day, practices, note) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE practices = VALUES(practices), note = VALUES(note)'
    );
    $stmt->execute([$day, json_encode($practices), $note]);

    sendJson(['day' => $day, 'practices' => $practices, 'note' => $note]);
}

// --- Catch log ---

function createCatch(array $body): void
{
    $pattern = (string) ($body['pattern'] ?? '');
    if (!in_array($pattern, PATTERN_KEYS, true)) sendError('Unknown pattern', 422);
    $note = cleanNote($body);
    $instead = cleanNote($body, 'instead');

    $db = Database::write();
    $db->prepare('INSERT INTO compass_catches (pattern, note, instead) VALUES (?, ?, ?)')
        ->execute([$pattern, $note, $instead]);

    $get = $db->prepare('SELECT id, pattern, note, instead, caught_at FROM compass_catches WHERE id = ?');
    $get->execute([(int) $db->lastInsertId()]);
    $row = $get->fetch();
    $row['id'] = (int) $row['id'];
    sendJson($row, 201);
}

function deleteCatch(?int $id): void
{
    if (!$id) sendError('id required', 400);
    $stmt = Database::write()->prepare('DELETE FROM compass_catches WHERE id = ?');
    $stmt->execute([$id]);
    if ($stmt->rowCount() === 0) sendError('Catch not found', 404);
    sendJson(['ok' => true]);
}

// --- Workbook: Breaking Free activity states ---

function saveActivity(array $body): void
{
    $num = (int) ($body['num'] ?? 0);
    $status = (string) ($body['status'] ?? '');
    if ($num < 1 || $num > ACTIVITY_COUNT) sendError('Unknown activity number', 422);
    if (!in_array($status, ACTIVITY_STATUSES, true)) sendError('Unknown status', 422);
    $note = cleanNote($body);

    Database::write()->prepare(
        'INSERT INTO compass_activities (activity_num, status, note) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE status = VALUES(status), note = VALUES(note)'
    )->execute([$num, $status, $note]);

    sendJson(['num' => $num, 'status' => $status, 'note' => $note]);
}
