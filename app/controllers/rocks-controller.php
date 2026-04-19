<?php
declare(strict_types=1);
header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

$dataFile = __DIR__ . '/../data/rocks.json';

function readRocks(string $file): array {
    if (!file_exists($file)) return [];
    $raw = file_get_contents($file);
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

// Atomic write: tmp file + rename (rename is atomic on POSIX filesystems)
function writeRocks(string $file, array $rocks): void {
    $tmp = $file . '.tmp';
    file_put_contents($tmp, json_encode(array_values($rocks), JSON_PRETTY_PRINT), LOCK_EX);
    rename($tmp, $file);
}

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    echo json_encode(readRocks($dataFile));
    exit;
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $body = json_decode(file_get_contents('php://input'), true);
    $action = is_array($body) ? ($body['action'] ?? null) : null;
    $rocks = readRocks($dataFile);

    switch ($action) {
        case 'add': {
            $rock = $body['rock'] ?? null;
            if (!is_array($rock)) {
                http_response_code(400);
                echo json_encode(['error' => 'rock required']);
                exit;
            }
            $maxId = 0;
            foreach ($rocks as $r) $maxId = max($maxId, (int)($r['id'] ?? 0));
            $rock['id'] = $maxId + 1;
            $rocks[] = $rock;
            writeRocks($dataFile, $rocks);
            echo json_encode(['ok' => true, 'rock' => $rock]);
            exit;
        }
        case 'update': {
            $id = (int)($body['id'] ?? 0);
            $found = false;
            foreach ($rocks as &$r) {
                if ((int)($r['id'] ?? 0) === $id) {
                    if (array_key_exists('x', $body)) $r['x'] = (float)$body['x'];
                    if (array_key_exists('z', $body)) $r['z'] = (float)$body['z'];
                    if (array_key_exists('rotation', $body)) $r['rotation'] = (float)$body['rotation'];
                    $found = true;
                    break;
                }
            }
            unset($r);
            if ($found) writeRocks($dataFile, $rocks);
            echo json_encode(['ok' => $found]);
            exit;
        }
        case 'delete': {
            $id = (int)($body['id'] ?? 0);
            $filtered = array_filter($rocks, fn($r) => (int)($r['id'] ?? 0) !== $id);
            writeRocks($dataFile, $filtered);
            echo json_encode(['ok' => true]);
            exit;
        }
        case 'clear': {
            writeRocks($dataFile, []);
            echo json_encode(['ok' => true]);
            exit;
        }
    }

    http_response_code(400);
    echo json_encode(['error' => 'unknown action']);
    exit;
}

http_response_code(405);
echo json_encode(['error' => 'method not allowed']);
