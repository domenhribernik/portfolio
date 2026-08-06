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
//  Server-side still capture
// ------------------------------------------------------------------
//
// The Tesla browser only paints <video>, and anything decoded from it, while
// the car is in Park, so views/vrata/frame cannot touch the HLS feed itself.
// It asks for a snapshot instead: ffmpeg pulls one frame here and writes it
// under shots/ for the page to point a plain <img> at.
//
// Each capture gets a fresh random name so the still is not sitting at a
// guessable URL, and so the browser can never serve a stale cached copy. Only
// the newest few are kept.

const VRATA_SNAPSHOT_DIR = __DIR__ . '/../../views/vrata/frame/shots';
const VRATA_SNAPSHOT_KEEP = 3;       // newest files to keep on disk
const VRATA_SNAPSHOT_TRIES = 6;      // grabs before giving up on the warm-up
const VRATA_SNAPSHOT_GAP = 3;        // seconds between grabs
const VRATA_SNAPSHOT_TIMEOUT = 25;   // hard kill for one ffmpeg run
const VRATA_SNAPSHOT_BUDGET = 45;    // total seconds of retrying
const VRATA_BLANK_LUMA = 6;          // mean luma below this is the placeholder

/** True when PHP is actually allowed to run external commands. */
function vrata_exec_available(): bool
{
    if (!function_exists('exec')) return false;
    $disabled = array_map('trim', explode(',', (string) ini_get('disable_functions')));
    return !in_array('exec', $disabled, true);
}

/**
 * Resolves an ffmpeg to run. Shared hosting rarely has one on PATH, so a
 * static build dropped at app/bin/ffmpeg over SFTP is picked up with no
 * configuration; FFMPEG_BIN in .env still wins if set.
 */
function vrata_ffmpeg_bin(): ?string
{
    static $resolved = false;
    static $bin = null;
    if ($resolved) return $bin;
    $resolved = true;

    // A configured path is preferred but still verified: an FFMPEG_BIN typo
    // must not send us into the retry loop only to fail 15s later.
    $env = $_ENV['FFMPEG_BIN'] ?? getenv('FFMPEG_BIN');
    if (is_string($env) && $env !== '') {
        if (str_contains($env, '/')) {
            if (is_executable($env)) return $bin = $env;
        } elseif (($found = vrata_which($env)) !== null) {
            return $bin = $found;
        }
    }

    $bundled = __DIR__ . '/../bin/ffmpeg';
    if (is_file($bundled)) {
        // SFTP uploads usually drop the executable bit; restore it once.
        if (!is_executable($bundled)) @chmod($bundled, 0755);
        if (is_executable($bundled)) return $bin = $bundled;
    }

    if (($found = vrata_which('ffmpeg')) !== null) {
        return $bin = $found;
    }

    foreach (['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/bin/ffmpeg'] as $path) {
        if (is_executable($path)) return $bin = $path;
    }

    return $bin = null;
}

/** Resolves a bare command name on PATH, or null. */
function vrata_which(string $name): ?string
{
    if (!vrata_exec_available()) return null;
    // No `env` wrapper: `command` is a shell builtin, so env would try to exec
    // a binary by that name and always report 127.
    exec('command -v ' . escapeshellarg($name) . ' 2>/dev/null', $out, $code);
    return $code === 0 && isset($out[0]) && $out[0] !== '' ? $out[0] : null;
}

/** Pulls a single frame off the HLS URL into $dest. */
function vrata_grab_frame(string $url, string $dest): bool
{
    $ffmpeg = vrata_ffmpeg_bin();
    if ($ffmpeg === null || !vrata_exec_available()) return false;

    // XAMPP exports LD_LIBRARY_PATH=/opt/lampp/lib, whose old libstdc++ breaks
    // the system ffmpeg; run it with that unset.
    //
    // ffmpeg must not keep reading the live playlist: it blocks indefinitely
    // waiting for the next segment and ignores TERM inside a TLS read, hence
    // -frames:v 1 plus timeout's -k kill.
    $cmd = 'env -u LD_LIBRARY_PATH timeout -k 3 ' . VRATA_SNAPSHOT_TIMEOUT
        . ' ' . escapeshellarg($ffmpeg) . ' -y -loglevel error -nostdin'
        . ' -i ' . escapeshellarg($url)
        . ' -frames:v 1 -update 1 -q:v 4 ' . escapeshellarg($dest)
        . ' </dev/null 2>&1';
    exec($cmd, $out, $code);
    return $code === 0 && is_file($dest) && filesize($dest) > 0;
}

/** Mean luma 0-255 of a JPEG, or null if it can't be read. */
function vrata_mean_luma(string $file): ?float
{
    if (!function_exists('imagecreatefromjpeg')) return null;
    $img = @imagecreatefromjpeg($file);
    if (!$img) return null;

    $w = imagesx($img);
    $h = imagesy($img);
    $stepX = max(1, (int) ($w / 32));
    $stepY = max(1, (int) ($h / 18));
    $sum = 0.0;
    $n = 0;
    for ($y = 0; $y < $h; $y += $stepY) {
        for ($x = 0; $x < $w; $x += $stepX) {
            $rgb = imagecolorat($img, $x, $y);
            $sum += 0.299 * (($rgb >> 16) & 0xFF)
                  + 0.587 * (($rgb >> 8) & 0xFF)
                  + 0.114 * ($rgb & 0xFF);
            $n++;
        }
    }
    imagedestroy($img);
    return $n > 0 ? $sum / $n : null;
}

/**
 * Grabs frames until the camera's black "waking up" placeholder gives way to
 * real picture, then publishes the still. Never returns.
 */
function vrata_snapshot(string $url): never
{
    @set_time_limit(90);

    // Bail before the retry loop: with no ffmpeg to run, every grab fails
    // instantly and the retries only burn 15s of the caller's time. Report
    // what was searched, since prod has no console to check.
    if (!vrata_exec_available()) {
        vrata_respond(502, ['error' => 'exec_disabled']);
    }
    if (vrata_ffmpeg_bin() === null) {
        // The common SFTP mistake: the binary is there but arrived without its
        // executable bit, and PHP cannot chmod a file it does not own. Saying
        // "missing" about a file sitting in place would send you hunting.
        if (is_file(__DIR__ . '/../bin/ffmpeg')) {
            vrata_respond(502, [
                'error' => 'ffmpeg_not_executable',
                'fix' => 'chmod 755 app/bin/ffmpeg',
            ]);
        }
        vrata_respond(502, [
            'error' => 'ffmpeg_missing',
            'looked_in' => ['FFMPEG_BIN', 'app/bin/ffmpeg', 'PATH',
                            '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/bin/ffmpeg'],
        ]);
    }

    $tmp = tempnam(sys_get_temp_dir(), 'vrata') ?: null;
    if ($tmp === null) {
        vrata_respond(500, ['error' => 'tmp_failed']);
    }
    $tmpJpg = $tmp . '.jpg';
    @unlink($tmp);

    $got = false;
    $blank = false;
    $deadline = time() + VRATA_SNAPSHOT_BUDGET;
    for ($i = 0; $i < VRATA_SNAPSHOT_TRIES; $i++) {
        if ($i > 0) {
            if (time() >= $deadline) break;
            sleep(VRATA_SNAPSHOT_GAP);
        }
        if (!vrata_grab_frame($url, $tmpJpg)) continue;

        $got = true;
        $luma = vrata_mean_luma($tmpJpg);
        // Unreadable luma (no GD) means we cannot tell, so take what we have.
        if ($luma === null || $luma >= VRATA_BLANK_LUMA) {
            $blank = false;
            break;
        }
        $blank = true;
    }

    if (!$got) {
        // ffmpeg exists and ran (the guards above proved it), so this is the
        // camera or the stream, not the deploy.
        @unlink($tmpJpg);
        vrata_respond(502, ['error' => 'capture_failed']);
    }

    $bytes = @file_get_contents($tmpJpg);
    @unlink($tmpJpg);
    if ($bytes === false || $bytes === '') {
        vrata_respond(502, ['error' => 'capture_failed']);
    }

    if (!is_dir(VRATA_SNAPSHOT_DIR) && !@mkdir(VRATA_SNAPSHOT_DIR, 0775, true) && !is_dir(VRATA_SNAPSHOT_DIR)) {
        // The web server user needs write access to views/vrata/frame/.
        vrata_respond(500, ['error' => 'write_failed']);
    }

    $name = 'shot-' . bin2hex(random_bytes(16)) . '.jpg';
    if (@file_put_contents(VRATA_SNAPSHOT_DIR . '/' . $name, $bytes, LOCK_EX) === false) {
        vrata_respond(500, ['error' => 'write_failed']);
    }
    @chmod(VRATA_SNAPSHOT_DIR . '/' . $name, 0664);
    vrata_prune_snapshots();

    vrata_respond(200, [
        'ok' => true,
        'ts' => time(),
        'file' => 'shots/' . $name,
        // True when every grab came back black: the picture is a placeholder,
        // so the page can say "camera still waking" instead of lying.
        'blank' => $blank,
    ]);
}

/** Keeps only the newest few stills; the rest are dead weight. */
function vrata_prune_snapshots(): void
{
    $files = glob(VRATA_SNAPSHOT_DIR . '/shot-*.jpg') ?: [];
    if (count($files) <= VRATA_SNAPSHOT_KEEP) return;

    usort($files, fn($a, $b) => filemtime($b) <=> filemtime($a));
    foreach (array_slice($files, VRATA_SNAPSHOT_KEEP) as $old) {
        @unlink($old);
    }
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
if (!in_array($action, ['unlock', 'stream', 'snapshot'], true)) {
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

/** Allocates a fresh HLS URL for the camera, or null on failure. */
function vrata_allocate_stream(string $client_id, string $secret, string $base_url, string $camera_id, string $token): ?string
{
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
    return is_string($url) && $url !== '' ? $url : null;
}

if ($action === 'stream' || $action === 'snapshot') {
    if ($camera_id === '') {
        vrata_respond(500, ['error' => 'camera_not_configured']);
    }

    $url = vrata_allocate_stream($client_id, $secret, $base_url, $camera_id, $token);
    if ($url === null) {
        vrata_respond(502, ['error' => 'stream_failed']);
    }

    if ($action === 'stream') {
        vrata_respond(200, ['url' => $url]);
    }

    vrata_snapshot($url);   // never returns
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
