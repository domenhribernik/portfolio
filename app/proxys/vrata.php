<?php
declare(strict_types=1);
define('SECURE_ACCESS', true);

// Backend for the standalone views/vrata PWA: unlocks a physical door and
// allocates the camera's HLS stream via the Tuya cloud.
//
// SEC-03 hardening: the unlock is a state-changing, real-world action, so it
// is POST-only (a bare GET from a link-preview/prefetch bot must never open
// the door), the shared key is read from the JSON body only (never the URL,
// where it would leak into access logs, history, Referer and prefetch), it is
// same-origin gated, and failed key attempts are rate limited per IP. A
// signed-in user with a role in the 'vrata' project (admins implicitly) is
// authorized without needing the key at all.

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
// No Access-Control-Allow-Origin: this opens a door; every consumer is the
// same-origin PWA and wildcard CORS is incompatible with that.

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

require_once __DIR__ . '/../config/dev-mode.php';
require_once __DIR__ . '/../config/database.php'; // also loads .env (Tuya + VRATA_KEY)
require_once __DIR__ . '/../config/auth.php';

function vrata_respond(int $code, array $payload): never
{
    http_response_code($code);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE);
    exit;
}

function vrata_env(string $name): string
{
    $v = $_ENV[$name] ?? getenv($name);
    return is_string($v) ? $v : '';
}

// ------------------------------------------------------------------
//  Per-IP rate limiting for shared-key attempts (a file of timestamps)
// ------------------------------------------------------------------

function vrata_attempts_file(): string
{
    $override = getenv('VRATA_ATTEMPTS_FILE');
    return is_string($override) && $override !== ''
        ? $override
        : __DIR__ . '/../cache/vrata-attempts.json';
}

function vrata_window(): int
{
    $w = (int) (getenv('VRATA_ATTEMPT_WINDOW') ?: 900);
    return $w > 0 ? $w : 900;
}

function vrata_max_attempts(): int
{
    $m = (int) (getenv('VRATA_MAX_ATTEMPTS') ?: 10);
    return $m > 0 ? $m : 10;
}

function vrata_load_attempts(): array
{
    $file = vrata_attempts_file();
    if (!is_file($file)) return [];
    $data = json_decode((string) file_get_contents($file), true);
    return is_array($data) ? $data : [];
}

function vrata_save_attempts(array $data): void
{
    file_put_contents(vrata_attempts_file(), json_encode($data), LOCK_EX);
}

/** Timestamps of this IP's failed attempts still inside the window. */
function vrata_recent_failures(string $ip): array
{
    $cutoff = time() - vrata_window();
    $all = vrata_load_attempts();
    return array_values(array_filter(
        $all[$ip] ?? [],
        fn($t) => (int) $t >= $cutoff
    ));
}

function vrata_locked_out(string $ip): bool
{
    return count(vrata_recent_failures($ip)) >= vrata_max_attempts();
}

function vrata_record_failure(string $ip): void
{
    $all = vrata_load_attempts();
    $recent = vrata_recent_failures($ip);
    $recent[] = time();
    $all[$ip] = $recent;
    vrata_save_attempts($all);
}

function vrata_clear_failures(string $ip): void
{
    $all = vrata_load_attempts();
    unset($all[$ip]);
    vrata_save_attempts($all);
}

// ------------------------------------------------------------------
//  Request guards
// ------------------------------------------------------------------

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    vrata_respond(405, ['error' => 'method_not_allowed']);
}

// CSRF backstop, same convention as the auth system.
Auth::assertSameOrigin();

// JSON bodies only (blocks form-based CSRF; the PWA always posts JSON).
$contentType = $_SERVER['CONTENT_TYPE'] ?? ($_SERVER['HTTP_CONTENT_TYPE'] ?? '');
if (stripos($contentType, 'application/json') === false) {
    vrata_respond(415, ['error' => 'json_required']);
}

$body = json_decode((string) file_get_contents('php://input'), true);
if (!is_array($body)) $body = [];

// ------------------------------------------------------------------
//  Authorization: a vrata project role OR the shared key (body only)
// ------------------------------------------------------------------

$user = Auth::currentUser();

if ($user !== null && Auth::hasProjectRole('vrata')) {
    // Signed-in, authorized: no key required.
} else {
    $providedKey = isset($body['key']) && is_string($body['key']) ? $body['key'] : '';
    if ($providedKey === '') {
        // No key and no qualifying session: distinguish "sign in" from
        // "you don't have access" so the PWA can react sensibly.
        vrata_respond($user !== null ? 403 : 401, [
            'error' => $user !== null ? 'forbidden' : 'auth_required',
        ]);
    }

    $ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
    if (vrata_locked_out($ip)) {
        vrata_respond(429, ['error' => 'too_many_attempts']);
    }

    $expectedKey = vrata_env('VRATA_KEY');
    if ($expectedKey === '' || !hash_equals($expectedKey, $providedKey)) {
        vrata_record_failure($ip);
        vrata_respond(403, ['error' => 'forbidden']);
    }
    vrata_clear_failures($ip);
}

$action = isset($body['action']) && is_string($body['action']) ? $body['action'] : 'unlock';
if (!in_array($action, ['unlock', 'stream'], true)) {
    vrata_respond(400, ['error' => 'unknown_action']);
}

// ------------------------------------------------------------------
//  Tuya cloud
// ------------------------------------------------------------------

$client_id = vrata_env('TUYA_CLIENT_ID');
$secret    = vrata_env('TUYA_SECRET');
$door_id   = vrata_env('TUYA_DOOR_ID');
$camera_id = vrata_env('TUYA_CAMERA_ID');
$base_url  = vrata_env('TUYA_BASE_URL');

// Step 1 — get an access token (shared by all actions).
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
$response = json_decode((string) curl_exec($ch), true);
$token = $response['result']['access_token'] ?? null;

if (!$token) {
    vrata_respond(502, ['error' => 'token_failed']);
}

if ($action === 'stream') {
    if ($camera_id === '') {
        vrata_respond(500, ['error' => 'camera_not_configured']);
    }

    $timestamp = round(microtime(true) * 1000);
    $streamBody = json_encode(['type' => 'hls']);
    $path = "/v1.0/devices/$camera_id/stream/actions/allocate";
    $contentHash = hash('sha256', $streamBody);
    $stringToSign = "POST\n" . $contentHash . "\n\n" . $path;
    $signStr = $client_id . $token . $timestamp . $stringToSign;
    $sign = strtoupper(hash_hmac('sha256', $signStr, $secret));

    $ch = curl_init($base_url . $path);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, $streamBody);
    curl_setopt($ch, CURLOPT_HTTPHEADER, [
        "client_id: $client_id",
        "access_token: $token",
        "sign: $sign",
        "t: $timestamp",
        "sign_method: HMAC-SHA256",
        "Content-Type: application/json",
    ]);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    $data = json_decode((string) curl_exec($ch), true);

    $url = $data['result']['url'] ?? null;
    if (!$url) {
        vrata_respond(502, ['error' => 'stream_failed']);
    }
    vrata_respond(200, ['url' => $url]);
}

// Default action: unlock.
$timestamp = round(microtime(true) * 1000);
$cmdBody = json_encode(['commands' => [['code' => 'switch_1', 'value' => true]]]);
$contentHash = hash('sha256', $cmdBody);
$stringToSign = "POST\n" . $contentHash . "\n\n" . "/v1.0/iot-03/devices/$door_id/commands";
$signStr = $client_id . $token . $timestamp . $stringToSign;
$sign = strtoupper(hash_hmac('sha256', $signStr, $secret));

$ch = curl_init("$base_url/v1.0/iot-03/devices/$door_id/commands");
curl_setopt($ch, CURLOPT_POST, true);
curl_setopt($ch, CURLOPT_POSTFIELDS, $cmdBody);
curl_setopt($ch, CURLOPT_HTTPHEADER, [
    "client_id: $client_id",
    "access_token: $token",
    "sign: $sign",
    "t: $timestamp",
    "sign_method: HMAC-SHA256",
    "Content-Type: application/json",
]);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
$data = json_decode((string) curl_exec($ch), true);

if (!is_array($data) || ($data['success'] ?? false) !== true) {
    vrata_respond(502, ['error' => 'unlock_failed']);
}
vrata_respond(200, ['ok' => true]);
