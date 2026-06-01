<?php
header('Access-Control-Allow-Origin: *');

require_once __DIR__ . '/../config/dev-mode.php';

$basePath     = $DEV_MODE ? dirname(__DIR__)              : '/usr/home/meuhdy';
$vendorPath   = $DEV_MODE ? dirname(__DIR__) . '/vendor'  : '/usr/home/meuhdy/vendor';

$autoloaderPath = $vendorPath . '/autoload.php';
if (!file_exists($autoloaderPath)) {
    die("Autoloader not found at: $autoloaderPath");
}
require $autoloaderPath;

$envPath = $basePath . '/.env';
if (!file_exists($envPath)) {
    die(".env file not found at: $envPath");
}

$dotenv = Dotenv\Dotenv::createImmutable($basePath);
$dotenv->load();
$client_id  = $_ENV['TUYA_CLIENT_ID'];
$secret     = $_ENV['TUYA_SECRET'];
$door_id    = $_ENV['TUYA_DOOR_ID'];
$camera_id  = $_ENV['TUYA_CAMERA_ID'] ?? null;
$base_url   = $_ENV['TUYA_BASE_URL'];
$vrata_key  = $_ENV['VRATA_KEY'];

if (!isset($_GET['key']) || !is_string($_GET['key']) || !hash_equals($vrata_key, $_GET['key'])) {
    http_response_code(403);
    exit;
}

$action = isset($_GET['action']) && is_string($_GET['action']) ? $_GET['action'] : 'unlock';

// Step 1 — get token (shared by all actions)
$timestamp = round(microtime(true) * 1000);
$contentHash = hash('sha256', '');
$stringToSign = "GET\n" . $contentHash . "\n\n" . "/v1.0/token?grant_type=1";
$signStr = $client_id . $timestamp . $stringToSign;
$sign = strtoupper(hash_hmac('sha256', $signStr, $secret));

$ch = curl_init("$base_url/v1.0/token?grant_type=1");
curl_setopt($ch, CURLOPT_HTTPHEADER, [
    "client_id: $client_id",
    "sign: $sign",
    "t: $timestamp",
    "sign_method: HMAC-SHA256",
]);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
$response = json_decode(curl_exec($ch), true);
$token = $response['result']['access_token'] ?? null;

if (!$token) {
    http_response_code(502);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['error' => 'token_failed']);
    exit;
}

if ($action === 'stream') {
    if (!$camera_id) {
        http_response_code(500);
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode(['error' => 'camera_not_configured']);
        exit;
    }

    $timestamp = round(microtime(true) * 1000);
    $body = json_encode(['type' => 'hls']);
    $path = "/v1.0/devices/$camera_id/stream/actions/allocate";
    $contentHash = hash('sha256', $body);
    $stringToSign = "POST\n" . $contentHash . "\n\n" . $path;
    $signStr = $client_id . $token . $timestamp . $stringToSign;
    $sign = strtoupper(hash_hmac('sha256', $signStr, $secret));

    $ch = curl_init($base_url . $path);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
    curl_setopt($ch, CURLOPT_HTTPHEADER, [
        "client_id: $client_id",
        "access_token: $token",
        "sign: $sign",
        "t: $timestamp",
        "sign_method: HMAC-SHA256",
        "Content-Type: application/json",
    ]);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    $raw = curl_exec($ch);
    $data = json_decode($raw, true);

    header('Content-Type: application/json; charset=utf-8');
    $url = $data['result']['url'] ?? null;
    if (!$url) {
        http_response_code(502);
        echo json_encode(['error' => 'stream_failed', 'detail' => $data]);
        exit;
    }
    echo json_encode(['url' => $url]);
    exit;
}

// Default action: unlock
header('Content-Type: text/plain; charset=utf-8');

$timestamp = round(microtime(true) * 1000);
$body = json_encode(['commands' => [['code' => 'switch_1', 'value' => true]]]);
$contentHash = hash('sha256', $body);
$stringToSign = "POST\n" . $contentHash . "\n\n" . "/v1.0/iot-03/devices/$door_id/commands";
$signStr = $client_id . $token . $timestamp . $stringToSign;
$sign = strtoupper(hash_hmac('sha256', $signStr, $secret));

$ch = curl_init("$base_url/v1.0/iot-03/devices/$door_id/commands");
curl_setopt($ch, CURLOPT_POST, true);
curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
curl_setopt($ch, CURLOPT_HTTPHEADER, [
    "client_id: $client_id",
    "access_token: $token",
    "sign: $sign",
    "t: $timestamp",
    "sign_method: HMAC-SHA256",
    "Content-Type: application/json",
]);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_exec($ch);
