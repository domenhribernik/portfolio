<?php
declare(strict_types=1);

// Integration tests for app/proxys/vrata.php (the door unlock / camera
// stream backend of the standalone views/vrata PWA).
//
// SEC-03: the unlock used to run on a bare GET with the shared key in the
// query string. Now the contract is: POST only (405 otherwise), JSON body
// only (415 otherwise), key accepted ONLY from the body (never the URL),
// same-origin enforced, session users with a role in the 'vrata' project
// (admins implicitly) pass without a key, failed key attempts are rate
// limited per IP, and there is no wildcard CORS header.
//
// No real Tuya calls: a second built-in server serves
// tests/fixtures/tuya-stub.php and TUYA_BASE_URL points at it. The stub logs
// every call it receives, so the tests can also assert that NOTHING reaches
// the door on denied requests.
//
// Runs ONLY against the local scratch DB (127.0.0.1/portfolio): the DB_* env
// overrides below make database.php skip loading app/.env (which points at
// the remote production database). Never run these against prod.
//
// Requires the seeded test users in the local DB:
//   admin@test.local  session token = 64 x 'a'
//   guest@test.local  session token = 64 x 'b'
//
// Run: /opt/lampp/bin/php tests/vrata.test.php

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit('CLI only');
}

const DB_DSN    = 'mysql:host=127.0.0.1;port=3306;dbname=portfolio;charset=utf8mb4';
const DB_USER   = 'portfolio_dev';
const DB_PASS   = 'R2miswz1pNKOxdl4';
const PHP_BIN   = PHP_BINARY;
const DOC_ROOT  = __DIR__ . '/..';
const HOST      = '127.0.0.1';
const PORT      = 8959;
const STUB_PORT = 8960;
const API       = 'http://' . HOST . ':' . PORT . '/app/proxys/vrata.php';
const VRATA_KEY = 'test-vrata-key-123';

$ADMIN_SID = str_repeat('a', 64);
$GUEST_SID = str_repeat('b', 64);

$attemptsFile = __DIR__ . '/vrata-attempts.test.json';
$stubLog      = __DIR__ . '/tuya-stub.test.log';

$passed = 0;
$failed = 0;

function check(string $name, bool $cond, string $detail = ''): void
{
    global $passed, $failed;
    if ($cond) {
        $passed++;
        echo "  ok  $name\n";
    } else {
        $failed++;
        echo "FAIL  $name" . ($detail !== '' ? "  ($detail)" : '') . "\n";
    }
}

/**
 * @param string[] $extraHeaders
 * @return array{status:int, body:mixed, headers:string[]}
 */
function request(string $method, string $url, ?string $sid = null, ?string $content = null, array $extraHeaders = []): array
{
    $headers = $extraHeaders;
    if ($sid !== null) {
        $headers[] = 'Cookie: portfolio_sid=' . $sid;
    }
    $opts = ['http' => ['method' => $method, 'ignore_errors' => true, 'timeout' => 10]];
    if ($content !== null) {
        $opts['http']['content'] = $content;
    }
    if ($headers) $opts['http']['header'] = implode("\r\n", $headers);
    $raw = @file_get_contents($url, false, stream_context_create($opts));
    $status = 0;
    foreach ($http_response_header ?? [] as $h) {
        if (preg_match('#^HTTP/\S+\s+(\d{3})#', $h, $m)) {
            $status = (int) $m[1];
        }
    }
    return [
        'status'  => $status,
        'body'    => $raw !== false ? json_decode($raw, true) : null,
        'headers' => $http_response_header ?? [],
    ];
}

/** POST a JSON body (the PWA's request shape). */
function postJson(string $url, array $body, ?string $sid = null, array $extraHeaders = []): array
{
    $extraHeaders[] = 'Content-Type: application/json';
    return request('POST', $url, $sid, json_encode($body), $extraHeaders);
}

function hasHeader(array $headers, string $name): bool
{
    foreach ($headers as $h) {
        if (stripos($h, $name . ':') === 0) {
            return true;
        }
    }
    return false;
}

/** @return array<int, array{path:string, method:string, body:string}> */
function stubCalls(): array
{
    global $stubLog;
    if (!file_exists($stubLog)) return [];
    $lines = array_filter(explode("\n", (string) file_get_contents($stubLog)));
    return array_values(array_map(fn($l) => json_decode($l, true), $lines));
}

function clearStubLog(): void
{
    global $stubLog;
    @unlink($stubLog);
}

// ------------------------------------------------------------------
//  DB fixtures
// ------------------------------------------------------------------

$pdo = new PDO(DB_DSN, DB_USER, DB_PASS, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);

$pdo->exec("INSERT INTO projects (project_key, name) VALUES ('vrata', 'Vrata')
            ON DUPLICATE KEY UPDATE active = 1");
$projectId = (int) $pdo->query("SELECT id FROM projects WHERE project_key = 'vrata'")->fetchColumn();

$adminId = (int) $pdo->query("SELECT id FROM users WHERE email = 'admin@test.local'")->fetchColumn();
$guestId = (int) $pdo->query("SELECT id FROM users WHERE email = 'guest@test.local'")->fetchColumn();
if ($adminId === 0 || $guestId === 0) {
    fwrite(STDERR, "Missing admin/guest fixture users in local DB\n");
    exit(1);
}

// Clean slate: guest starts without a role in the project.
$pdo->prepare('DELETE FROM user_project_roles WHERE user_id = ? AND project_id = ?')
    ->execute([$guestId, $projectId]);

register_shutdown_function(function () use ($pdo, $guestId, $projectId, $attemptsFile) {
    $pdo->prepare('DELETE FROM user_project_roles WHERE user_id = ? AND project_id = ?')
        ->execute([$guestId, $projectId]);
    @unlink($attemptsFile);
    clearStubLog();
});

@unlink($attemptsFile);
clearStubLog();

// ------------------------------------------------------------------
//  Boot two built-in servers: the proxy and the fake Tuya cloud
// ------------------------------------------------------------------

$nullDev = PHP_OS_FAMILY === 'Windows' ? 'NUL' : '/dev/null';
$commonEnv = [
    'PATH'          => getenv('PATH') ?: '/usr/bin:/bin',
    'TUYA_STUB_LOG' => $stubLog,
];
if (PHP_OS_FAMILY === 'Windows') {
    $commonEnv['SystemRoot'] = getenv('SystemRoot') ?: 'C:\\Windows';
}

$proxyEnv = $commonEnv + [
    'DB_HOST'   => '127.0.0.1',
    'DB_PORT'   => '3306',
    'DB_NAME'   => 'portfolio',
    'DB_USER_W' => DB_USER,
    'DB_PASS_W' => DB_PASS,
    'DB_USER_R' => DB_USER,
    'DB_PASS_R' => DB_PASS,

    'VRATA_KEY'            => VRATA_KEY,
    'VRATA_ATTEMPTS_FILE'  => $attemptsFile,
    'VRATA_MAX_ATTEMPTS'   => '3',
    'VRATA_ATTEMPT_WINDOW' => '900',

    'TUYA_CLIENT_ID' => 'stub-client',
    'TUYA_SECRET'    => 'stub-secret',
    'TUYA_DOOR_ID'   => 'stub-door',
    'TUYA_CAMERA_ID' => 'stub-camera',
    'TUYA_BASE_URL'  => 'http://' . HOST . ':' . STUB_PORT . '/tests/fixtures/tuya-stub.php',
];

$servers = [];
foreach ([[PORT, $proxyEnv], [STUB_PORT, $commonEnv]] as [$port, $env]) {
    $servers[] = proc_open(
        [PHP_BIN, '-d', 'variables_order=EGPCS', '-S', HOST . ':' . $port, '-t', DOC_ROOT],
        [1 => ['file', $nullDev, 'w'], 2 => ['file', $nullDev, 'w']],
        $pipes,
        DOC_ROOT,
        $env
    );
}

register_shutdown_function(function () use ($servers) {
    foreach ($servers as $server) {
        if (is_resource($server)) {
            proc_terminate($server);
        }
    }
});

foreach ([PORT, STUB_PORT] as $port) {
    $ready = false;
    for ($i = 0; $i < 50; $i++) {
        $sock = @fsockopen(HOST, $port, $errno, $errstr, 0.2);
        if ($sock) {
            fclose($sock);
            $ready = true;
            break;
        }
        usleep(100_000);
    }
    if (!$ready) {
        fwrite(STDERR, "Built-in PHP server did not start on port $port\n");
        exit(1);
    }
}

// ------------------------------------------------------------------
//  Tests
// ------------------------------------------------------------------

echo "vrata proxy\n";

// The original exploit: a bare GET with the key in the URL must never unlock.
$res = request('GET', API . '?key=' . VRATA_KEY);
check('GET with key in URL is 405', $res['status'] === 405, "got {$res['status']}");
check('no wildcard CORS header', !hasHeader($res['headers'], 'Access-Control-Allow-Origin'));
check('denied GET reaches Tuya zero times', stubCalls() === [], json_encode(stubCalls()));

$res = request('GET', API);
check('plain GET is 405', $res['status'] === 405, "got {$res['status']}");

// The key is only read from the body: a correct key in the URL of a POST
// counts as no key at all.
$res = postJson(API . '?key=' . VRATA_KEY, []);
check('POST with key only in URL is 401', $res['status'] === 401, "got {$res['status']}");

// CSRF backstops: JSON bodies only, same origin only.
$res = request('POST', API, null, 'key=' . VRATA_KEY, ['Content-Type: application/x-www-form-urlencoded']);
check('form-encoded POST is 415', $res['status'] === 415, "got {$res['status']}");

$res = postJson(API, ['key' => VRATA_KEY], null, ['Origin: https://evil.example']);
check('cross-origin POST is 403', $res['status'] === 403, "got {$res['status']}");

// Anonymous with no key: 401. Signed in without a role and no key: 403.
$res = postJson(API, []);
check('anonymous POST without key is 401', $res['status'] === 401, "got {$res['status']}");

$res = postJson(API, [], $GUEST_SID);
check('role-less session without key is 403', $res['status'] === 403, "got {$res['status']}");

check('nothing has reached Tuya so far', stubCalls() === [], json_encode(stubCalls()));

// Wrong keys are rejected and rate limited (VRATA_MAX_ATTEMPTS=3 here).
$res = postJson(API, ['key' => 'wrong-key']);
check('wrong key is 403', $res['status'] === 403, "got {$res['status']}");
postJson(API, ['key' => 'wrong-key']);
postJson(API, ['key' => 'wrong-key']);
$res = postJson(API, ['key' => 'wrong-key']);
check('4th wrong key is 429', $res['status'] === 429, "got {$res['status']}");
$res = postJson(API, ['key' => VRATA_KEY]);
check('even the correct key is 429 while locked out', $res['status'] === 429, "got {$res['status']}");
check('locked-out attempts reach Tuya zero times', stubCalls() === [], json_encode(stubCalls()));

// Reset the limiter and take the happy path: unlock with the shared key.
@unlink($attemptsFile);
$res = postJson(API, ['key' => VRATA_KEY]);
check('correct key unlock is 200', $res['status'] === 200, "got {$res['status']} " . json_encode($res['body']));
check('unlock responds ok', ($res['body']['ok'] ?? false) === true, json_encode($res['body']));
$calls = stubCalls();
check('unlock calls Tuya token then commands', count($calls) === 2
    && str_contains($calls[0]['path'] ?? '', '/token')
    && str_contains($calls[1]['path'] ?? '', '/commands'), json_encode($calls));
check('unlock sends switch_1 true', str_contains($calls[1]['body'] ?? '', 'switch_1'));

// The camera stream works the same way (key in body, POST).
clearStubLog();
$res = postJson(API, ['key' => VRATA_KEY, 'action' => 'stream']);
check('stream with key is 200', $res['status'] === 200, "got {$res['status']} " . json_encode($res['body']));
check('stream returns the HLS url', ($res['body']['url'] ?? '') === 'https://stub.example/cam.m3u8', json_encode($res['body']));

$res = postJson(API, ['key' => VRATA_KEY, 'action' => 'reboot']);
check('unknown action is 400', $res['status'] === 400, "got {$res['status']}");

// Session path: a role in the vrata project unlocks without any key.
$pdo->prepare('INSERT INTO user_project_roles (user_id, project_id, role) VALUES (?, ?, ?)')
    ->execute([$guestId, $projectId, 'user']);

clearStubLog();
$res = postJson(API, [], $GUEST_SID);
check('vrata-role session without key is 200', $res['status'] === 200, "got {$res['status']} " . json_encode($res['body']));
check('role unlock responds ok', ($res['body']['ok'] ?? false) === true);

$res = postJson(API, [], $ADMIN_SID);
check('admin session without key is 200 (implicit project access)', $res['status'] === 200, "got {$res['status']}");

echo "\n$passed passed, $failed failed\n";
exit($failed === 0 ? 0 : 1);
