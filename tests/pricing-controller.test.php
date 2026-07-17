<?php
declare(strict_types=1);

// Integration tests for app/controllers/pricing-controller.php (the unlisted
// views/pricing quote calculator backend + the admin Leads inbox it feeds).
//
// Runs ONLY against the local scratch DB (127.0.0.1/portfolio): the DB_* env
// overrides below make database.php skip loading app/.env (which points at the
// remote production database). Never run these against prod.
//
// Requires the seeded test users in the local DB:
//   admin@test.local  session token = 64 x 'a'
//   guest@test.local  session token = 64 x 'b'
//
// Setup ensures pricing_quotes exists with the hashed-IP column; teardown
// deletes only the rows this suite inserted (id baseline).
//
// Run: /opt/lampp/bin/php tests/pricing-controller.test.php

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
const PORT     = 8953;
const API      = 'http://' . HOST . ':' . PORT . '/app/controllers/pricing-controller.php';

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

/** @return array{status:int, body:mixed} */
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
    return ['status' => $status, 'body' => $raw !== false ? json_decode($raw, true) : null];
}

// A valid quote submission body (matches what views/pricing/script.js POSTs).
function quoteBody(array $overrides = []): array
{
    return array_merge([
        'selections'        => ['pages' => '2-3', 'design' => 'template', 'features' => ['gallery']],
        'suggested_package' => 'BASIC',
        'total_price'       => 490,
        'special_requests'  => '',
    ], $overrides);
}

// ------------------------------------------------------------------
//  DB fixtures
// ------------------------------------------------------------------

$pdo = new PDO(DB_DSN, DB_USER, DB_PASS, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
$pdo->exec(file_get_contents(DOC_ROOT . '/app/models/pricing-quotes-model.sql'));

// Ensure the hashed-IP migration is applied on a pre-existing local table
// (CREATE TABLE IF NOT EXISTS above is a no-op if the table already exists).
// MariaDB (local XAMPP) supports IF EXISTS / IF NOT EXISTS on ALTER.
$cols = $pdo->query("SHOW COLUMNS FROM pricing_quotes")->fetchAll(PDO::FETCH_COLUMN);
if (in_array('ip_address', $cols, true)) {
    $pdo->exec("ALTER TABLE pricing_quotes DROP COLUMN ip_address");
}
if (!in_array('ip_hash', $cols, true)) {
    $pdo->exec("ALTER TABLE pricing_quotes ADD COLUMN ip_hash CHAR(64) NULL AFTER id");
}

$adminId = (int) $pdo->query("SELECT id FROM users WHERE email = 'admin@test.local'")->fetchColumn();
$guestId = (int) $pdo->query("SELECT id FROM users WHERE email = 'guest@test.local'")->fetchColumn();
if ($adminId === 0 || $guestId === 0) {
    fwrite(STDERR, "Missing admin/guest fixture users in local DB\n");
    exit(1);
}

$BASELINE_ID = (int) $pdo->query('SELECT COALESCE(MAX(id), 0) FROM pricing_quotes')->fetchColumn();

function teardown(PDO $pdo): void
{
    global $BASELINE_ID;
    $stmt = $pdo->prepare('DELETE FROM pricing_quotes WHERE id > ?');
    $stmt->execute([$BASELINE_ID]);
}

function rowCount(PDO $pdo): int
{
    global $BASELINE_ID;
    $stmt = $pdo->prepare('SELECT COUNT(*) FROM pricing_quotes WHERE id > ?');
    $stmt->execute([$BASELINE_ID]);
    return (int) $stmt->fetchColumn();
}

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

register_shutdown_function(function () use ($server, $pdo) {
    if (is_resource($server)) {
        proc_terminate($server);
    }
    teardown($pdo);
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

echo "pricing controller\n";

// Tracer: a public visitor can submit a quote and it persists.
$before = rowCount($pdo);
$res = request('POST', API, null, quoteBody());
check('public POST creates a quote (200)', $res['status'] === 200, "got {$res['status']}");
check('POST returns the new id', is_int($res['body']['id'] ?? null) && $res['body']['id'] > 0);
check('POST persists one row', rowCount($pdo) === $before + 1);
$newId = (int) ($res['body']['id'] ?? 0);

// Privacy: the IP is stored as a daily sha256 hash, never the raw address, and
// the hash is never returned to the client.
$stored = null;
if ($newId) {
    $stmt = $pdo->prepare('SELECT ip_hash FROM pricing_quotes WHERE id = ?');
    $stmt->execute([$newId]);
    $stored = $stmt->fetchColumn();
}
$expectHash = hash('sha256', '127.0.0.1|' . gmdate('Y-m-d'));
check('IP is stored as a 64-char sha256 hash', is_string($stored) && preg_match('/^[0-9a-f]{64}$/', $stored) === 1, "got " . var_export($stored, true));
check('stored hash matches sha256(ip + daily salt)', $stored === $expectHash);
check('raw IP is never in the stored value', $stored !== '127.0.0.1');
check('POST response never leaks ip_hash or ip_address',
    !array_key_exists('ip_hash', $res['body'] ?? []) && !array_key_exists('ip_address', $res['body'] ?? []));

// Validation: bad package / missing selections rejected, nothing persisted.
$before = rowCount($pdo);
$res = request('POST', API, null, quoteBody(['suggested_package' => 'GOLD']));
check('invalid package returns 400', $res['status'] === 400, "got {$res['status']}");
$res = request('POST', API, null, ['suggested_package' => 'BASIC', 'total_price' => 100]);
check('missing selections returns 400', $res['status'] === 400, "got {$res['status']}");
check('invalid submissions persist nothing', rowCount($pdo) === $before);

// Admin leads inbox: listing requires admin.
$res = request('GET', API . '?all=1', null);
check('anonymous list is 401', $res['status'] === 401, "got {$res['status']}");
$res = request('GET', API . '?all=1', $GUEST_SID);
check('non-admin list is 403', $res['status'] === 403, "got {$res['status']}");
$res = request('GET', API . '?all=1', $ADMIN_SID);
check('admin list is 200', $res['status'] === 200, "got {$res['status']}");
check('admin list returns an array', is_array($res['body']));
check('admin list omits ip_hash', is_array($res['body']) && (empty($res['body']) || !array_key_exists('ip_hash', $res['body'][0])));

// Delete: admin-gated hard delete.
$res = request('DELETE', API . '?id=' . $newId, null);
check('anonymous delete is 401', $res['status'] === 401, "got {$res['status']}");
$res = request('DELETE', API . '?id=' . $newId, $GUEST_SID);
check('non-admin delete is 403', $res['status'] === 403, "got {$res['status']}");

$before = rowCount($pdo);
$res = request('DELETE', API . '?id=' . $newId, $ADMIN_SID);
check('admin delete is 200', $res['status'] === 200, "got {$res['status']}");
check('admin delete removes the row', rowCount($pdo) === $before - 1);

$res = request('DELETE', API . '?id=' . $newId, $ADMIN_SID);
check('deleting a missing quote is 404', $res['status'] === 404, "got {$res['status']}");

$res = request('DELETE', API, $ADMIN_SID);
check('delete without id is 405', $res['status'] === 405, "got {$res['status']}");

echo "\n$passed passed, $failed failed\n";
exit($failed === 0 ? 0 : 1);
