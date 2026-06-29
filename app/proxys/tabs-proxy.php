<?php
// Songsterr tab search for the music view. Songsterr's API is free and
// keyless but has no CORS support, so the frontend goes through here.
// GET ?q=<song name> -> { found, url, artist, title }
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');

const CACHE_TTL_SECONDS = 30 * 24 * 3600;
const CACHE_MAX_ENTRIES = 500;

$query = trim((string) ($_GET['q'] ?? ''));
if ($query === '' || mb_strlen($query) > 120) {
    http_response_code(400);
    echo json_encode(['error' => 'q parameter is required (max 120 chars)']);
    exit;
}

$cacheFile = __DIR__ . '/../cache/tabs-cache.json';
$cache = file_exists($cacheFile) ? (json_decode(file_get_contents($cacheFile), true) ?: []) : [];
$key = md5(mb_strtolower($query));

if (isset($cache[$key]) && time() - ($cache[$key]['ts'] ?? 0) < CACHE_TTL_SECONDS) {
    echo json_encode($cache[$key]['data']);
    exit;
}

function fetchUrl($url)
{
    $ch = curl_init();
    curl_setopt($ch, CURLOPT_URL, $url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_TIMEOUT, 10);
    curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
    curl_setopt($ch, CURLOPT_USERAGENT, 'domenhribernik.com music player');

    $response = curl_exec($ch);
    if (curl_errno($ch)) {
        error_log('Tabs proxy cURL error: ' . curl_error($ch));
        curl_close($ch);
        return false;
    }
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    return $httpCode === 200 ? $response : false;
}

$apiUrl = 'https://www.songsterr.com/api/songs?size=5&pattern=' . urlencode($query);
$response = fetchUrl($apiUrl);

if ($response === false) {
    // offline or Songsterr down: serve a stale hit if we have one
    if (isset($cache[$key])) {
        echo json_encode($cache[$key]['data']);
        exit;
    }
    http_response_code(503);
    echo json_encode(['error' => 'Tab search is unavailable right now']);
    exit;
}

$songs = json_decode($response, true);
$result = ['found' => false];

if (is_array($songs) && count($songs)) {
    $song = $songs[0];
    foreach ($songs as $candidate) {
        if (!empty($candidate['hasChords'])) {
            $song = $candidate;
            break;
        }
    }
    if (isset($song['songId'], $song['artist'], $song['title'])) {
        $slug = strtolower(trim(preg_replace('/[^a-z0-9]+/i', '-', $song['artist'] . ' ' . $song['title']), '-'));
        $result = [
            'found'  => true,
            'url'    => "https://www.songsterr.com/a/wsa/{$slug}-tab-s{$song['songId']}",
            'artist' => $song['artist'],
            'title'  => $song['title'],
        ];
    }
}

$cache[$key] = ['ts' => time(), 'data' => $result];
if (count($cache) > CACHE_MAX_ENTRIES) {
    uasort($cache, fn($a, $b) => ($b['ts'] ?? 0) <=> ($a['ts'] ?? 0));
    $cache = array_slice($cache, 0, CACHE_MAX_ENTRIES, true);
}
file_put_contents($cacheFile, json_encode($cache));

echo json_encode($result);
