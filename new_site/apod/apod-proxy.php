<?php
// apod-proxy.php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *'); // Or your specific domain

require __DIR__ . '/../vendor/autoload.php';

$dotenv = Dotenv\Dotenv::createImmutable(__DIR__);
$dotenv->load();

$apiKey = getenv('NASA_API_KEY');
$cacheFile = 'apod-cache.json';
$cacheTime = 86400; // 24 hours

// Serve from cache if fresh
if (file_exists($cacheFile) && (time() - filemtime($cacheFile) < $cacheTime)) {
    echo file_get_contents($cacheFile);
    exit;
}

// Fetch fresh data
$response = file_get_contents("https://api.nasa.gov/planetary/apod?api_key=$apiKey");
file_put_contents($cacheFile, $response);
echo $response;
?>