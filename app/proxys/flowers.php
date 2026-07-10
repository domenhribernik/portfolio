<?php
// Small server-side endpoint for sharing Paper Flowers bouquets: stores each
// shared bouquet (the order plus an optional note) as a JSON file in
// app/cache/flowers/, serves it back by id, and prunes anything older than
// 7 days. Same shape as tarok.php: no external API, no auth, a share link
// is public by design.

header('Content-Type: application/json; charset=utf-8');

$cacheDir = __DIR__ . '/../cache/flowers';
if (!is_dir($cacheDir)) {
    @mkdir($cacheDir, 0775, true);
}

const MAX_BODY_BYTES = 8192;   // an order of 12 stems plus a note is tiny
const MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const MAX_MESSAGE_CHARS = 280;
const MAX_STEMS = 12;          // mirrors MAX_STEMS in views/flowers/logic.js

// Sanitize an id down to the exact shape the client hash produces (base36)
// so a crafted id can never escape the cache directory.
function sanitizeId($raw) {
    $id = preg_replace('/[^a-z0-9]/i', '', (string) $raw);
    return substr($id, 0, 32);
}

// Delete every shared bouquet older than 7 days. Returns how many wilted.
function pruneOldBouquets($cacheDir) {
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

// Validate and normalize the order: known-shaped entries only, positive
// integer counts, total capped at MAX_STEMS so a crafted payload can't make
// viewers render an oversized scene. Returns null when nothing survives.
function sanitizeOrder($raw) {
    if (!is_array($raw)) {
        return null;
    }
    $order = [];
    $total = 0;
    foreach ($raw as $item) {
        if (!is_array($item) || !isset($item['type'], $item['count'])) {
            continue;
        }
        $type = $item['type'];
        $count = $item['count'];
        if (!is_string($type) || !preg_match('/^[a-z][a-z-]{0,23}$/', $type)) {
            continue;
        }
        if (!is_int($count) || $count <= 0) {
            continue;
        }
        $take = min($count, MAX_STEMS - $total);
        if ($take <= 0) {
            break;
        }
        $order[] = ['type' => $type, 'count' => $take];
        $total += $take;
    }
    return $total > 0 ? $order : null;
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

    $body = json_decode($raw, true);
    if (json_last_error() !== JSON_ERROR_NONE || !is_array($body)) {
        http_response_code(400);
        echo json_encode(['error' => 'invalid_json']);
        exit;
    }

    $order = sanitizeOrder($body['order'] ?? null);
    if ($order === null) {
        http_response_code(400);
        echo json_encode(['error' => 'invalid_order']);
        exit;
    }

    $id = sanitizeId($body['id'] ?? '');
    if ($id === '') {
        http_response_code(400);
        echo json_encode(['error' => 'invalid_id']);
        exit;
    }

    $message = isset($body['message']) && is_string($body['message'])
        ? trim(mb_substr($body['message'], 0, MAX_MESSAGE_CHARS))
        : '';

    // Store the re-encoded, sanitized shape, never the raw body.
    $bouquet = [
        'v' => 1,
        'order' => $order,
        'message' => $message,
        'createdAt' => gmdate('c'),
    ];
    $ok = file_put_contents(
        $cacheDir . '/' . $id . '.json',
        json_encode($bouquet, JSON_UNESCAPED_UNICODE),
        LOCK_EX
    );
    if ($ok === false) {
        http_response_code(500);
        echo json_encode(['error' => 'write_failed']);
        exit;
    }

    pruneOldBouquets($cacheDir);
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
    echo json_encode(['deleted' => pruneOldBouquets($cacheDir)]);
    exit;
}

http_response_code(400);
echo json_encode(['error' => 'unknown_action']);
