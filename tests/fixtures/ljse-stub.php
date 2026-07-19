<?php
declare(strict_types=1);

// Fake LJSE website + Telegram API for tests/stocks-sync.test.php. The suite
// boots a second PHP built-in server with this file as the router and points
// LJSE_BASE_URL / TELEGRAM_API_BASE at it, so the sync service's outbound
// calls land here instead of ljse.si and api.telegram.org.
//
// Behavior is data-driven: LJSE JSON payloads are served from the directory
// in STOCKS_STUB_DIR (the test writes the scenario files), so a missing file
// doubles as the "exchange is down" case (500). Every request is logged as a
// JSON line to STOCKS_STUB_LOG. Loopback only.

if (($_SERVER['REMOTE_ADDR'] ?? '') !== '127.0.0.1') {
    http_response_code(403);
    exit;
}

$path = parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH) ?? '';
$entry = [
    'path'   => $path,
    'method' => $_SERVER['REQUEST_METHOD'],
    'query'  => $_SERVER['QUERY_STRING'] ?? '',
    'body'   => file_get_contents('php://input'),
];
$log = getenv('STOCKS_STUB_LOG');
if (is_string($log) && $log !== '') {
    file_put_contents($log, json_encode($entry) . "\n", FILE_APPEND | LOCK_EX);
}

header('Content-Type: application/json; charset=utf-8');

// Telegram: /bot<token>/sendMessage. The log line above is the assertion
// surface; the reply just needs to look like success.
if (preg_match('#^/bot[^/]+/sendMessage$#', $path)) {
    echo json_encode(['ok' => true, 'result' => ['message_id' => 1]]);
    exit;
}

$dir = getenv('STOCKS_STUB_DIR') ?: '';
$file = null;
if ($path === '/json/TradingPriceList') {
    $file = 'tradingpricelist.json';
} elseif (preg_match('#^/json/securityHistory/([A-Z0-9]+)/#', $path, $m)) {
    $file = 'securityhistory-' . $m[1] . '.json';
}

if ($file === null || $dir === '' || !file_exists("$dir/$file")) {
    http_response_code(500);
    echo json_encode(['error' => 'stub: no scenario file']);
    exit;
}
readfile("$dir/$file");
