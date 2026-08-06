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

// Beseda streak sync (views/beseda, plus the widget on views/iliana).
//
// The content the learner reads is static JSON in the view folder; this
// controller only stores which days someone practised. There is no project
// gate and no role: anyone may learn. Signed out, the streak lives in
// localStorage and never touches this file.
//
// Streaks are NOT computed here. The client owns that maths
// (components/beseda/logic.js) so the full page and the iliana widget always
// show the same number; the server is a set of days and nothing more.
//
// POST is a merge, not a replace. The client uploads its whole local history
// on sign-in and a single day when marking today, and both take the same path:
// the UNIQUE (user_id, day) key makes it idempotent. Nothing is ever deleted
// here, because losing a day silently shortens someone's streak.

const MAX_DAYS_PER_REQUEST = 500;
const MAX_DAYS_RETURNED = 400;
// A device whose clock runs ahead is legitimately already on tomorrow.
const FUTURE_TOLERANCE_DAYS = 1;
const MAX_AGE_DAYS = 1100;

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
    if (!empty($_POST)) return $_POST;
    $raw = file_get_contents('php://input');
    if (!$raw) return [];
    $json = json_decode($raw, true);
    if (is_array($json)) return $json;
    parse_str($raw, $parsed);
    return is_array($parsed) ? $parsed : [];
}

function viewerPayload(?array $viewer): ?array
{
    if ($viewer === null) return null;
    return [
        'id' => (int) $viewer['id'],
        'display_name' => $viewer['display_name'] ?? '',
        'avatar_url' => $viewer['avatar_url'] ?? null,
    ];
}

/**
 * Keep only the entries that are real calendar days in a plausible window.
 *
 * Junk is dropped rather than rejected: this arrives from localStorage, which
 * can hold anything after a schema change or a hand edit, and failing the
 * whole request would strand a learner with a streak they cannot sync. There
 * is nothing to protect against here beyond nonsense, since inflating your own
 * streak harms no one.
 */
function cleanDays(mixed $days): array
{
    if (!is_array($days)) return [];
    $today = new DateTimeImmutable('today');
    $clean = [];
    foreach ($days as $day) {
        if (!is_string($day) || !preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $day, $m)) continue;
        if (!checkdate((int) $m[2], (int) $m[3], (int) $m[1])) continue;
        $offset = (int) $today->diff(new DateTimeImmutable($day))->format('%r%a');
        if ($offset > FUTURE_TOLERANCE_DAYS || $offset < -MAX_AGE_DAYS) continue;
        $clean[$day] = true;
    }
    return array_keys($clean);
}

function fetchDays(int $userId): array
{
    $stmt = Database::read()->prepare(
        'SELECT day FROM beseda_activity WHERE user_id = ?
         ORDER BY day DESC LIMIT ' . MAX_DAYS_RETURNED
    );
    $stmt->execute([$userId]);
    $days = $stmt->fetchAll(PDO::FETCH_COLUMN);
    sort($days);
    return $days;
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

// --- Streak ---

function getStreak(): void
{
    $user = Auth::requireLogin();
    sendJson(['days' => fetchDays((int) $user['id'])]);
}

function mergeStreak(): void
{
    $user = Auth::requireLogin();
    $body = readBody();
    $submitted = $body['days'] ?? null;

    if (!is_array($submitted)) {
        sendError('Expected a days array.', 400);
    }
    if (count($submitted) > MAX_DAYS_PER_REQUEST) {
        sendError('Too many days in one request.', 400);
    }

    $days = cleanDays($submitted);
    if ($days !== []) {
        $write = Database::write();
        $stmt = $write->prepare(
            'INSERT INTO beseda_activity (user_id, day) VALUES (?, ?)
             ON DUPLICATE KEY UPDATE day = day'
        );
        foreach ($days as $day) {
            $stmt->execute([(int) $user['id'], $day]);
        }
    }

    sendJson(['days' => fetchDays((int) $user['id'])]);
}

// --- Routing ---

$method = $_SERVER['REQUEST_METHOD'];
$resource = $_GET['resource'] ?? null;

try {
    if ($resource === 'session') {
        if ($method !== 'GET') sendError('Method not allowed', 405);
        getSession();
    } elseif ($resource === 'streak') {
        if ($method === 'GET') {
            getStreak();
        } elseif ($method === 'POST') {
            mergeStreak();
        } else {
            sendError('Method not allowed', 405);
        }
    } else {
        sendError('Unknown resource. Use ?resource=session or streak.', 400);
    }
} catch (Exception $e) {
    error_log('Beseda controller error: ' . $e->getMessage());
    sendError('Internal server error', 500);
}
