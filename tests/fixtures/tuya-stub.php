<?php
declare(strict_types=1);

// Fake Tuya cloud for tests/vrata.test.php. The suite boots a second PHP
// built-in server with TUYA_BASE_URL pointed at this file, so the proxy's
// outbound calls land here instead of the real door. Records every call to
// the TUYA_STUB_LOG file (one JSON line each) and answers canned success
// payloads. Loopback only, so it is inert if it ever reaches a real host.

if (($_SERVER['REMOTE_ADDR'] ?? '') !== '127.0.0.1') {
    http_response_code(403);
    exit;
}

$entry = [
    'path'   => $_SERVER['PATH_INFO'] ?? ($_SERVER['REQUEST_URI'] ?? ''),
    'method' => $_SERVER['REQUEST_METHOD'],
    'body'   => file_get_contents('php://input'),
];
$log = getenv('TUYA_STUB_LOG');
if (is_string($log) && $log !== '') {
    file_put_contents($log, json_encode($entry) . "\n", FILE_APPEND | LOCK_EX);
}

header('Content-Type: application/json; charset=utf-8');
$path = (string) $entry['path'];
if (str_contains($path, '/token')) {
    echo json_encode(['success' => true, 'result' => ['access_token' => 'stub-token']]);
} elseif (str_contains($path, '/stream/')) {
    echo json_encode(['success' => true, 'result' => ['url' => 'https://stub.example/cam.m3u8']]);
} else {
    echo json_encode(['success' => true]);
}
