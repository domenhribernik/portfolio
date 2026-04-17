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

$cacheFile = __DIR__ . '/../cache/jeger-checklist.json';

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    echo file_exists($cacheFile) ? file_get_contents($cacheFile) : '{}';
    exit;
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $data = json_decode(file_get_contents('php://input'), true);
    if (!is_array($data)) {
        http_response_code(400);
        echo json_encode(['error' => 'invalid input']);
        exit;
    }
    file_put_contents($cacheFile, json_encode($data, JSON_PRETTY_PRINT));
    echo json_encode(['ok' => true]);
    exit;
}

http_response_code(405);
echo json_encode(['error' => 'method not allowed']);
