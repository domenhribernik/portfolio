<?php
declare(strict_types=1);
define('SECURE_ACCESS', true);

header('Content-Type: application/json');
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

// Single-owner private tool: every branch, reads included, is admin-only.
// The cron script (app/scripts/check_stocks.py) reads the JSON file
// directly, so it is unaffected by this gate.
Auth::requireAdmin();

$cacheFile = __DIR__ . '/../cache/stocks.json';

function readTickers($file) {
    if (!file_exists($file)) return [];
    $data = json_decode(file_get_contents($file), true);
    return is_array($data) ? $data : [];
}

function writeTickers($file, $tickers) {
    file_put_contents($file, json_encode(array_values($tickers), JSON_PRETTY_PRINT));
}

$method = $_SERVER['REQUEST_METHOD'];
$tickers = readTickers($cacheFile);

if ($method === 'GET') {
    echo json_encode($tickers);

} elseif ($method === 'POST') {
    $body = json_decode(file_get_contents('php://input'), true);
    $ticker = strtoupper(trim($body['ticker'] ?? ''));

    if (!$ticker || !preg_match('/^[A-Z0-9.\-]{1,10}$/', $ticker)) {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid ticker symbol']);
        exit;
    }

    if (in_array($ticker, $tickers)) {
        http_response_code(409);
        echo json_encode(['error' => 'Ticker already in list']);
        exit;
    }

    $tickers[] = $ticker;
    writeTickers($cacheFile, $tickers);
    echo json_encode($tickers);

} elseif ($method === 'DELETE') {
    $body = json_decode(file_get_contents('php://input'), true);
    $ticker = strtoupper(trim($body['ticker'] ?? ''));

    $tickers = array_filter($tickers, fn($t) => $t !== $ticker);
    writeTickers($cacheFile, $tickers);
    echo json_encode(array_values($tickers));

} else {
    http_response_code(405);
    echo json_encode(['error' => 'Method not allowed']);
}
?>
