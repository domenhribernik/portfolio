<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');

$cacheFile = __DIR__ . '/otd-cache.json';
$language = 'en';
$month = date('n');
$day = date('j');

$cacheValid = false;
if (file_exists($cacheFile)) {
    $fileDate = date('Y-m-d', filemtime($cacheFile));
    if ($fileDate === date('Y-m-d')) {
        $cacheValid = true;
    }
}

if ($cacheValid) {
    readfile($cacheFile);
    exit;
}

$baseUrl = "https://api.wikimedia.org/feed/v1/wikipedia/{$language}/onthisday";
$types = ['selected', 'events', 'births', 'deaths'];
$userAgent = 'domenhribernik.com/1.0 (your-email@example.com)';

$multiHandle = curl_multi_init();
$handles = [];

foreach ($types as $type) {
    $ch = curl_init();
    curl_setopt_array($ch, [
        CURLOPT_URL => "{$baseUrl}/{$type}/{$month}/{$day}",
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 10,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_HTTPHEADER => [
            'User-Agent: ' . $userAgent,
            'Accept: application/json'
        ]
    ]);
    curl_multi_add_handle($multiHandle, $ch);
    $handles[$type] = $ch;
}

$running = null;
do {
    curl_multi_exec($multiHandle, $running);
    curl_multi_select($multiHandle);
} while ($running > 0);

$data = [];
foreach ($handles as $type => $ch) {
    $response = curl_multi_getcontent($ch);
    if ($response && curl_getinfo($ch, CURLINFO_HTTP_CODE) === 200) {
        $decoded = json_decode($response, true);
        if (json_last_error() === JSON_ERROR_NONE) {
            $data[$type] = $decoded;
        }
    }
    curl_multi_remove_handle($multiHandle, $ch);
    curl_close($ch);
}

curl_multi_close($multiHandle);

if (empty($data)) {
    http_response_code(503);
    echo json_encode(['error' => 'Failed to fetch data from Wikipedia']);
    exit;
}

file_put_contents($cacheFile, json_encode($data, JSON_PRETTY_PRINT));

echo json_encode($data);
?>