<?php
header('Content-Type: text/plain; charset=utf-8');
header('Access-Control-Allow-Origin: *'); // Or your specific domain

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
$client_id = $_ENV['TUYA_CLIENT_ID'];
$secret = $_ENV['TUYA_SECRET'];
$device_id = $_ENV['TUYA_DEVICE_ID'];
$base_url = $_ENV['TUYA_BASE_URL'];
$vrata_key = $_ENV['VRATA_KEY'];

if (!isset($_GET['key']) || !is_string($_GET['key']) || !hash_equals($vrata_key, $_GET['key'])) {
    http_response_code(403);
    exit;
}

// Step 1 — get token
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

// Step 2 — send command
$timestamp = round(microtime(true) * 1000);
$body = json_encode(['commands' => [['code' => 'switch_1', 'value' => true]]]);
$contentHash = hash('sha256', $body);
$stringToSign = "POST\n" . $contentHash . "\n\n" . "/v1.0/iot-03/devices/$device_id/commands";
$signStr = $client_id . $token . $timestamp . $stringToSign;
$sign = strtoupper(hash_hmac('sha256', $signStr, $secret));

$ch = curl_init("$base_url/v1.0/iot-03/devices/$device_id/commands");
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
?>