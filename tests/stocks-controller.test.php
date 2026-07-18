<?php
declare(strict_types=1);

// Integration tests for app/controllers/stocks-controller.php (the unlisted
// views/stocks watchlist backend; the cron script reads the JSON file
// directly, so gating the HTTP surface does not affect it).
//
// SEC-02: the whole controller is a single-owner tool, so every branch
// (reads included) must be behind Auth::requireAdmin(), and the wildcard
// CORS header must be gone (cookie auth + '*' is invalid and dangerous).
//
// Runs ONLY against the local scratch DB (127.0.0.1/portfolio): the DB_* env
// overrides below make database.php skip loading app/.env (which points at the
// remote production database). Never run these against prod.
//
// Requires the seeded test users in the local DB:
//   admin@test.local  session token = 64 x 'a'
//   guest@test.local  session token = 64 x 'b'
//
// The ticker store is a JSON file (app/cache/stocks.json); the suite backs it
// up before running and restores it afterwards.
//
// Run: /opt/lampp/bin/php tests/stocks-controller.test.php

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit('CLI only');
}

const DB_DSN   = 'mysql:host=127.0.0.1;port=3306;dbname=portfolio;charset=utf8mb4';
const DB_USER  = 'portfolio_dev';
const DB_PASS  = 'R2miswz1pNKOxdl4';
const PHP_BIN  = PHP_BINARY;
const DOC_ROOT = __DIR__ . '/..';
const HOST     = '127.0.0.1';
const PORT     = 8956;
const API      = 'http://' . HOST . ':' . PORT . '/app/controllers/stocks-controller.php';
const STORE    = DOC_ROOT . '/app/cache/stocks.json';

$ADMIN_SID = str_repeat('a', 64);
$GUEST_SID = str_repeat('b', 64);

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

/** @return array{status:int, body:mixed, headers:string[]} */
function request(string $method, string $url, ?string $sid = null, ?array $body = null): array
{
    $headers = [];
    if ($sid !== null) {
        $headers[] = 'Cookie: portfolio_sid=' . $sid;
    }
    $opts = ['http' => ['method' => $method, 'ignore_errors' => true, 'timeout' => 10]];
    if ($body !== null) {
        $headers[] = 'Content-Type: application/json';
        $opts['http']['content'] = json_encode($body);
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

function hasHeader(array $headers, string $name): bool
{
    foreach ($headers as $h) {
        if (stripos($h, $name . ':') === 0) {
            return true;
        }
    }
    return false;
}

function storedTickers(): array
{
    if (!file_exists(STORE)) return [];
    $data = json_decode((string) file_get_contents(STORE), true);
    return is_array($data) ? $data : [];
}

// ------------------------------------------------------------------
//  Fixtures
// ------------------------------------------------------------------

$pdo = new PDO(DB_DSN, DB_USER, DB_PASS, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
$adminId = (int) $pdo->query("SELECT id FROM users WHERE email = 'admin@test.local'")->fetchColumn();
$guestId = (int) $pdo->query("SELECT id FROM users WHERE email = 'guest@test.local'")->fetchColumn();
if ($adminId === 0 || $guestId === 0) {
    fwrite(STDERR, "Missing admin/guest fixture users in local DB\n");
    exit(1);
}

$storeBackup = file_exists(STORE) ? file_get_contents(STORE) : null;

register_shutdown_function(function () use ($storeBackup) {
    if ($storeBackup !== null) {
        file_put_contents(STORE, $storeBackup);
    } elseif (file_exists(STORE)) {
        unlink(STORE);
    }
});

file_put_contents(STORE, json_encode(['AAPL']));

// ------------------------------------------------------------------
//  Boot the built-in server against the LOCAL scratch DB
// ------------------------------------------------------------------

$nullDev = PHP_OS_FAMILY === 'Windows' ? 'NUL' : '/dev/null';
$serverEnv = [
    'DB_HOST'   => '127.0.0.1',
    'DB_PORT'   => '3306',
    'DB_NAME'   => 'portfolio',
    'DB_USER_W' => DB_USER,
    'DB_PASS_W' => DB_PASS,
    'DB_USER_R' => DB_USER,
    'DB_PASS_R' => DB_PASS,
    'PATH'      => getenv('PATH') ?: '/usr/bin:/bin',
];
if (PHP_OS_FAMILY === 'Windows') {
    $serverEnv['SystemRoot'] = getenv('SystemRoot') ?: 'C:\\Windows';
}

$server = proc_open(
    [PHP_BIN, '-d', 'variables_order=EGPCS', '-S', HOST . ':' . PORT, '-t', DOC_ROOT],
    [1 => ['file', $nullDev, 'w'], 2 => ['file', $nullDev, 'w']],
    $pipes,
    DOC_ROOT,
    $serverEnv
);

register_shutdown_function(function () use ($server) {
    if (is_resource($server)) {
        proc_terminate($server);
    }
});

$ready = false;
for ($i = 0; $i < 50; $i++) {
    $sock = @fsockopen(HOST, PORT, $errno, $errstr, 0.2);
    if ($sock) {
        fclose($sock);
        $ready = true;
        break;
    }
    usleep(100_000);
}
if (!$ready) {
    fwrite(STDERR, "Built-in PHP server did not start on port " . PORT . "\n");
    exit(1);
}

// ------------------------------------------------------------------
//  Tests
// ------------------------------------------------------------------

echo "stocks controller\n";

// Every branch is admin-only: this is a single-owner tool.
$res = request('GET', API);
check('anonymous GET is 401', $res['status'] === 401, "got {$res['status']}");
check('no wildcard CORS header', !hasHeader($res['headers'], 'Access-Control-Allow-Origin'));

$res = request('GET', API, $GUEST_SID);
check('non-admin GET is 403', $res['status'] === 403, "got {$res['status']}");

$res = request('GET', API, $ADMIN_SID);
check('admin GET is 200', $res['status'] === 200, "got {$res['status']}");
check('admin GET returns the ticker list', $res['body'] === ['AAPL'], json_encode($res['body']));

// Writes: anonymous and non-admin are rejected and persist nothing.
$res = request('POST', API, null, ['ticker' => 'MSFT']);
check('anonymous POST is 401', $res['status'] === 401, "got {$res['status']}");
check('anonymous POST persists nothing', storedTickers() === ['AAPL']);

$res = request('POST', API, $GUEST_SID, ['ticker' => 'MSFT']);
check('non-admin POST is 403', $res['status'] === 403, "got {$res['status']}");
check('non-admin POST persists nothing', storedTickers() === ['AAPL']);

$res = request('DELETE', API, null, ['ticker' => 'AAPL']);
check('anonymous DELETE is 401', $res['status'] === 401, "got {$res['status']}");
check('anonymous DELETE persists nothing', storedTickers() === ['AAPL']);

// The tool still works for its owner.
$res = request('POST', API, $ADMIN_SID, ['ticker' => 'MSFT']);
check('admin POST adds a ticker (200)', $res['status'] === 200, "got {$res['status']}");
check('added ticker persists', storedTickers() === ['AAPL', 'MSFT'], json_encode(storedTickers()));

$res = request('POST', API, $ADMIN_SID, ['ticker' => 'not a ticker!']);
check('admin POST still validates ticker format (400)', $res['status'] === 400, "got {$res['status']}");

$res = request('DELETE', API, $ADMIN_SID, ['ticker' => 'AAPL']);
check('admin DELETE removes a ticker (200)', $res['status'] === 200, "got {$res['status']}");
check('removed ticker is gone', storedTickers() === ['MSFT'], json_encode(storedTickers()));

echo "\n$passed passed, $failed failed\n";
exit($failed === 0 ? 0 : 1);
