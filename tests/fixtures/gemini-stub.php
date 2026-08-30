<?php
declare(strict_types=1);

// Fake Gemini generateContent for tests/narek-proxy.test.php. The suite boots a
// second PHP built-in server with GEMINI_API_BASE pointed at this file, so the
// proxy's outbound calls land here instead of Google. Records every call to
// GEMINI_STUB_LOG (one JSON line each) and answers from GEMINI_STUB_SCENARIO,
// a JSON file the suite rewrites between cases. Loopback only.

if (($_SERVER['REMOTE_ADDR'] ?? '') !== '127.0.0.1') {
    http_response_code(403);
    exit;
}

header('Content-Type: application/json; charset=utf-8');

$path = (string) ($_SERVER['PATH_INFO'] ?? ($_SERVER['REQUEST_URI'] ?? ''));
$raw  = (string) file_get_contents('php://input');

// models/<name>:generateContent
$model = '';
if (preg_match('#models/([^:/?]+):generateContent#', $path, $m)) {
    $model = urldecode($m[1]);
}

$log = getenv('GEMINI_STUB_LOG');
if (is_string($log) && $log !== '') {
    file_put_contents($log, json_encode([
        'model'  => $model,
        'key'    => $_SERVER['HTTP_X_GOOG_API_KEY'] ?? '',
        'method' => $_SERVER['REQUEST_METHOD'] ?? '',
        'body'   => json_decode($raw, true),
    ]) . "\n", FILE_APPEND | LOCK_EX);
}

$scenarioPath = (string) (getenv('GEMINI_STUB_SCENARIO') ?: '');
$scenario     = [];
if ($scenarioPath !== '' && is_file($scenarioPath)) {
    $decoded = json_decode((string) file_get_contents($scenarioPath), true);
    if (is_array($decoded)) {
        $scenario = $decoded;
    }
}

// A model listed in "missing" answers 404, exactly as a project without access
// to it would, so the proxy's fallback chain can be exercised.
if (in_array($model, $scenario['missing'] ?? [], true)) {
    http_response_code(404);
    echo json_encode(['error' => ['code' => 404, 'message' => 'model not found']]);
    exit;
}

$status = (int) ($scenario['status'] ?? 200);
if ($status !== 200) {
    http_response_code($status);
    echo json_encode(['error' => ['code' => $status, 'message' => $scenario['message'] ?? 'stub error']]);
    exit;
}

// "parts" lets a case return several text parts, which the proxy must join.
$parts = $scenario['parts'] ?? null;
if (!is_array($parts)) {
    $parts = [['text' => (string) ($scenario['text'] ?? 'Danes je lep dan.')]];
}

echo json_encode(['candidates' => [['content' => ['parts' => $parts]]]], JSON_UNESCAPED_UNICODE);
