<?php
declare(strict_types=1);

// Fake Tuya cloud for tests/vrata.test.php. The suite boots a second PHP
// built-in server with TUYA_BASE_URL pointed at this file, so the proxy's
// outbound calls land here instead of the real door. Records every call to
// the TUYA_STUB_LOG file (one JSON line each) and answers canned success
// payloads. Loopback only, so it is inert if it ever reaches a real host.

if (($_SERVER['REMOTE_ADDR'] ?? '') !== '127.0.0.1') {
    http_response_code(403);
    exit;
}

$entry = [
    'path'   => $_SERVER['PATH_INFO'] ?? ($_SERVER['REQUEST_URI'] ?? ''),
    'method' => $_SERVER['REQUEST_METHOD'],
    'body'   => file_get_contents('php://input'),
];
$log = getenv('TUYA_STUB_LOG');
if (is_string($log) && $log !== '') {
    file_put_contents($log, json_encode($entry) . "\n", FILE_APPEND | LOCK_EX);
}

$path = (string) $entry['path'];

// This file doubles as the stream edge, so the snapshot pipeline runs against
// a realistic playlist tree: a master pointing at a media playlist pointing at
// a relative segment URI. Every step is one the proxy has to resolve.
//
// The segment is **AES-128 encrypted**, because the real Tuya stream is: its
// playlists carry an EXT-X-KEY and the .ts bytes are ciphertext. A plaintext
// fixture passes while production fails, which is exactly what happened once.
$self = 'http://' . ($_SERVER['HTTP_HOST'] ?? '127.0.0.1') . ($_SERVER['SCRIPT_NAME'] ?? '');
$hlsKey = (string) hex2bin('000102030405060708090a0b0c0d0e0f');
$hlsIv  = '101112131415161718191a1b1c1d1e1f';

if (str_contains($path, '/hls/cam.m3u8')) {
    header('Content-Type: application/vnd.apple.mpegurl');
    echo "#EXTM3U\n#EXT-X-VERSION:3\n"
        . "#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=160x90\n"
        . "media.m3u8\n";
    exit;
}
if (str_contains($path, '/hls/media.m3u8')) {
    header('Content-Type: application/vnd.apple.mpegurl');
    echo "#EXTM3U\n#EXT-X-VERSION:3\n"
        . '#EXT-X-KEY:METHOD=AES-128,URI="' . $self . '/hls/key.bin",IV=0x' . $hlsIv . "\n"
        . "#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:0.5,\nseg1.ts\n";
    exit;
}
if (str_contains($path, '/hls/key.bin')) {
    header('Content-Type: application/octet-stream');
    echo $hlsKey;
    exit;
}
if (str_contains($path, '/hls/seg1.ts')) {
    header('Content-Type: video/mp2t');
    echo openssl_encrypt(
        (string) file_get_contents(__DIR__ . '/vrata-seg.ts'),
        'aes-128-cbc',
        $hlsKey,
        OPENSSL_RAW_DATA,
        (string) hex2bin($hlsIv)
    );
    exit;
}

header('Content-Type: application/json; charset=utf-8');
if (str_contains($path, '/token')) {
    echo json_encode(['success' => true, 'result' => ['access_token' => 'stub-token']]);
} elseif (str_contains($path, '/stream/')) {
    echo json_encode(['success' => true, 'result' => ['url' => $self . '/hls/cam.m3u8']]);
} else {
    echo json_encode(['success' => true]);
}
