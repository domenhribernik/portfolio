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

// One checklist per user (read-only demo plus per-user rows, same shape as
// plants-controller.php). GET is public: signed out returns the site owner's
// ticked herbs as a demo, signed in returns the caller's own. POST requires
// login and upserts only the caller's row.

$method = $_SERVER['REQUEST_METHOD'];

try {
    if ($method === 'GET') {
        getChecklist();
    } elseif ($method === 'POST') {
        $user = Auth::requireLogin();
        saveChecklist($user);
    } else {
        http_response_code(405);
        echo json_encode(['error' => 'method not allowed']);
    }
} catch (Exception $e) {
    error_log('Jeger controller error: ' . $e->getMessage());
    http_response_code(500);
    echo json_encode(['error' => 'Internal server error']);
}

/** The user whose checklist backs the public demo: the first active site admin. */
function showcaseUserId(): ?int
{
    $found = Database::read()
        ->query('SELECT id FROM users WHERE is_admin = 1 AND is_active = 1 ORDER BY id LIMIT 1')
        ->fetchColumn();
    return $found === false ? null : (int) $found;
}

/** The ticked-herbs map for a user, or an empty object if they have none. */
function fetchChecked(int $userId): array
{
    $stmt = Database::read()->prepare('SELECT checked FROM jeger_checklists WHERE user_id = ?');
    $stmt->execute([$userId]);
    $row = $stmt->fetch();
    if (!$row) {
        return [];
    }
    $decoded = json_decode($row['checked'], true);
    return is_array($decoded) ? $decoded : [];
}

function getChecklist(): void
{
    $viewer = Auth::currentUser();
    $ownerId = $viewer !== null ? (int) $viewer['id'] : showcaseUserId();
    $checked = $ownerId !== null ? fetchChecked($ownerId) : [];

    echo json_encode([
        'demo' => $viewer === null,
        'viewer' => $viewer !== null ? [
            'id' => (int) $viewer['id'],
            'display_name' => $viewer['display_name'],
            'avatar_url' => $viewer['avatar_url'],
        ] : null,
        // Force an object even when empty so the client always gets a map.
        'checked' => (object) $checked,
    ], JSON_UNESCAPED_UNICODE);
}

function saveChecklist(array $user): void
{
    $raw = file_get_contents('php://input');
    $data = $raw ? json_decode($raw, true) : null;
    if (!is_array($data)) {
        http_response_code(400);
        echo json_encode(['error' => 'invalid input']);
        return;
    }

    // Normalize to a compact { plantId: true } map: keep only truthy flags,
    // cap the number of keys, and bound key length so the JSON can't be abused.
    $checked = [];
    foreach ($data as $key => $value) {
        if (!$value) {
            continue;
        }
        $key = (string) $key;
        if ($key === '' || strlen($key) > 100) {
            continue;
        }
        $checked[$key] = true;
        if (count($checked) >= 500) {
            break;
        }
    }

    $json = json_encode((object) $checked, JSON_UNESCAPED_UNICODE);
    $stmt = Database::write()->prepare(
        'INSERT INTO jeger_checklists (user_id, checked) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE checked = VALUES(checked)'
    );
    $stmt->execute([(int) $user['id'], $json]);

    echo json_encode(['ok' => true]);
}
