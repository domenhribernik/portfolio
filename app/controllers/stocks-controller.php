<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    exit;
}

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
