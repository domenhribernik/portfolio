<?php
// Small server-side endpoint for the Tarok scorekeeper: stores shared games as
// JSON files in app/cache/tarok/, serves them back by id, and prunes anything
// older than 7 days. No external API, no auth: a share link is public by design.

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');

$cacheDir = __DIR__ . '/../cache/tarok';
if (!is_dir($cacheDir)) {
    @mkdir($cacheDir, 0775, true);
}

const MAX_BODY_BYTES = 65536; // 64 KB is plenty for a game of rounds
const MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

// Sanitize an id down to the exact shape our client hash produces (base36) so a
// crafted id can never escape the cache directory.
function sanitizeId($raw) {
    $id = preg_replace('/[^a-z0-9]/i', '', (string) $raw);
    return substr($id, 0, 32);
}

// Delete every cached game older than 7 days. Returns how many were removed.
function pruneOldGames($cacheDir) {
    $deleted = 0;
    $cutoff = time() - MAX_AGE_SECONDS;
    foreach (glob($cacheDir . '/*.json') as $file) {
        if (filemtime($file) < $cutoff) {
            if (@unlink($file)) {
                $deleted++;
            }
        }
    }
    return $deleted;
}

$action = isset($_GET['action']) && is_string($_GET['action']) ? $_GET['action'] : '';

if ($action === 'save') {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        http_response_code(405);
        echo json_encode(['error' => 'method_not_allowed']);
        exit;
    }

    $raw = file_get_contents('php://input');
    if ($raw === false || strlen($raw) > MAX_BODY_BYTES) {
        http_response_code(413);
        echo json_encode(['error' => 'payload_too_large']);
        exit;
    }

    $game = json_decode($raw, true);
    if (json_last_error() !== JSON_ERROR_NONE
        || !is_array($game)
        || !isset($game['players']) || !is_array($game['players'])
        || !isset($game['rounds']) || !is_array($game['rounds'])) {
        http_response_code(400);
        echo json_encode(['error' => 'invalid_game']);
        exit;
    }

    $id = sanitizeId($game['gameId'] ?? '');
    if ($id === '') {
        http_response_code(400);
        echo json_encode(['error' => 'invalid_id']);
        exit;
    }

    $ok = file_put_contents($cacheDir . '/' . $id . '.json', $raw, LOCK_EX);
    if ($ok === false) {
        http_response_code(500);
        echo json_encode(['error' => 'write_failed']);
        exit;
    }

    pruneOldGames($cacheDir);
    echo json_encode(['id' => $id]);
    exit;
}

if ($action === 'load') {
    $id = sanitizeId($_GET['id'] ?? '');
    $file = $cacheDir . '/' . $id . '.json';
    if ($id === '' || !file_exists($file)) {
        http_response_code(404);
        echo json_encode(['error' => 'not_found']);
        exit;
    }
    readfile($file);
    exit;
}

if ($action === 'cleanup') {
    echo json_encode(['deleted' => pruneOldGames($cacheDir)]);
    exit;
}

http_response_code(400);
echo json_encode(['error' => 'unknown_action']);
