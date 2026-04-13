<?php
header('Content-Type: application/json');
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
$apiKey = htmlspecialchars($_ENV['NASA_API_KEY']);

function fetchUrl($url) {
    $ch = curl_init();
    curl_setopt($ch, CURLOPT_URL, $url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_TIMEOUT, 10);
    curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true); // Important for HTTPS

    $response = curl_exec($ch);

    if (curl_errno($ch)) {
        error_log('cURL error: ' . curl_error($ch));
        curl_close($ch);
        return false;
    }

    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($httpCode !== 200) {
        error_log("API returned HTTP code: $httpCode");
        return false;
    }

    return $response;
}

$cacheFile = __DIR__ . '/../cache/apod-cache.json';
$today = date('Y-m-d');
$cachedData = file_exists($cacheFile) ? json_decode(file_get_contents($cacheFile), true) : null;

if ($cachedData && isset($cachedData['date']) && $cachedData['date'] === $today) {
    echo json_encode($cachedData);
    exit;
}

$apiUrl = "https://api.nasa.gov/planetary/apod?api_key={$apiKey}&date={$today}";
$response = fetchUrl($apiUrl);

if ($response) {
    $newData = json_decode($response, true);

    if (isset($newData['date'])) {
        file_put_contents($cacheFile, json_encode($newData));
        echo json_encode($newData);
        exit;
    }
}
?>
