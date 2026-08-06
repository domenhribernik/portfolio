<?php
declare(strict_types=1);

// Integration tests for beseda-controller.php: the streak merge, its input
// validation, and isolation between accounts.
//
// The behaviour that matters most here is that POST merges rather than
// replaces. The client re-uploads its whole local history on every sign-in, so
// a replace (or a failed upsert) would silently shorten someone's streak, and
// a streak is the entire retention mechanic of the feature.
//
// Runs ONLY against the local scratch DB (127.0.0.1/portfolio): the DB_* env
// overrides below make database.php skip loading app/.env, which points at
// the remote production database. Never run these against prod.
//
// Requires the seeded test users in the local DB:
//   admin@test.local  session token = 64 x 'a'
//   guest@test.local  session token = 64 x 'b'
//
// Run: /opt/lampp/bin/php tests/beseda-controller.test.php

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit('CLI only');
}

const DB_DSN   = 'mysql:host=127.0.0.1;port=3306;dbname=portfolio;charset=utf8mb4';
const DB_USER  = 'portfolio_dev';
const DB_PASS  = 'R2miswz1pNKOxdl4';
const PHP_BIN  = '/opt/lampp/bin/php';
const DOC_ROOT = __DIR__ . '/..';
const HOST     = '127.0.0.1';
const PORT     = 8937;
const API      = 'http://' . HOST . ':' . PORT . '/app/controllers/beseda-controller.php';

$ADMIN_SID = str_repeat('a', 64);
$GUEST_SID = str_repeat('b', 64);

// ------------------------------------------------------------------
//  Tiny assertion runner
// ------------------------------------------------------------------

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

/** @return array{status:int, body:mixed, headers:array} */
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
    $opts['http']['header'] = implode("\r\n", $headers);
    $raw = file_get_contents($url, false, stream_context_create($opts));
    $status = 0;
    $seen = $http_response_header ?? [];
    foreach ($seen as $h) {
        if (preg_match('#^HTTP/\S+\s+(\d{3})#', $h, $m)) {
            $status = (int) $m[1];
        }
    }
    return ['status' => $status, 'body' => $raw !== false ? json_decode($raw, true) : null, 'headers' => $seen];
}

// ------------------------------------------------------------------
//  Fixtures
// ------------------------------------------------------------------

$pdo = new PDO(DB_DSN, DB_USER, DB_PASS, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);

$pdo->exec('CREATE TABLE IF NOT EXISTS beseda_activity (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    day DATE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_beseda_activity_user_day (user_id, day),
    INDEX idx_beseda_activity_user (user_id),
    CONSTRAINT fk_beseda_activity_user FOREIGN KEY (user_id)
        REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci');

$adminId = (int) $pdo->query("SELECT id FROM users WHERE email = 'admin@test.local'")->fetchColumn();
$guestId = (int) $pdo->query("SELECT id FROM users WHERE email = 'guest@test.local'")->fetchColumn();
if ($adminId === 0 || $guestId === 0) {
    fwrite(STDERR, "Missing seeded test users in local DB\n");
    exit(1);
}

function teardown(PDO $pdo, int $adminId, int $guestId): void
{
    $stmt = $pdo->prepare('DELETE FROM beseda_activity WHERE user_id IN (?, ?)');
    $stmt->execute([$adminId, $guestId]);
}

teardown($pdo, $adminId, $guestId); // clean leftovers from a crashed run

$server = proc_open(
    [PHP_BIN, '-d', 'variables_order=EGPCS', '-S', HOST . ':' . PORT, '-t', DOC_ROOT],
    [1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']],
    $pipes,
    DOC_ROOT,
    [
        'DB_HOST'   => '127.0.0.1',
        'DB_PORT'   => '3306',
        'DB_NAME'   => 'portfolio',
        'DB_USER_W' => DB_USER,
        'DB_PASS_W' => DB_PASS,
        'DB_USER_R' => DB_USER,
        'DB_PASS_R' => DB_PASS,
        'PATH'      => getenv('PATH') ?: '/usr/bin:/bin',
    ]
);

register_shutdown_function(function () use ($server, $pdo, $adminId, $guestId) {
    if (is_resource($server)) {
        proc_terminate($server);
    }
    teardown($pdo, $adminId, $guestId);
});

// Wait for the server to accept connections.
for ($i = 0; $i < 50; $i++) {
    $probe = @fsockopen(HOST, PORT, $errno, $errstr, 0.2);
    if ($probe) { fclose($probe); break; }
    usleep(100000);
}

$today = (new DateTimeImmutable('today'))->format('Y-m-d');
$yesterday = (new DateTimeImmutable('yesterday'))->format('Y-m-d');
$tomorrow = (new DateTimeImmutable('tomorrow'))->format('Y-m-d');

// ------------------------------------------------------------------
//  Session probe and gating
// ------------------------------------------------------------------

$res = request('GET', API . '?resource=session');
check('session probe reports a signed-out visitor', ($res['body']['demo'] ?? null) === true);
check('signed-out probe carries no viewer',
    is_array($res['body']) && array_key_exists('viewer', $res['body']) && $res['body']['viewer'] === null);

$res = request('GET', API . '?resource=session', $GUEST_SID);
check('session probe reports a signed-in visitor', ($res['body']['demo'] ?? null) === false);
check('signed-in probe names the viewer', !empty($res['body']['viewer']['display_name']));

$res = request('GET', API . '?resource=session');
$cors = array_filter($res['headers'], fn ($h) => stripos($h, 'Access-Control-Allow-Origin') === 0);
check('no wildcard CORS header on a cookie-authed endpoint', $cors === []);
$noStore = array_filter($res['headers'], fn ($h) => stripos($h, 'Cache-Control: no-store') === 0);
check('responses are not cacheable', $noStore !== []);

$res = request('OPTIONS', API . '?resource=session');
check('preflight is answered', $res['status'] === 204, "got {$res['status']}");

$res = request('GET', API . '?resource=streak');
check('reading a streak signed out is refused', $res['status'] === 401, "got {$res['status']}");

$res = request('POST', API . '?resource=streak', null, ['days' => [$today]]);
check('writing a streak signed out is refused', $res['status'] === 401, "got {$res['status']}");

$res = request('GET', API . '?resource=nonsense', $GUEST_SID);
check('an unknown resource is rejected', $res['status'] === 400, "got {$res['status']}");

// ------------------------------------------------------------------
//  The merge
// ------------------------------------------------------------------

$res = request('GET', API . '?resource=streak', $GUEST_SID);
check('a new learner has no history', ($res['body']['days'] ?? null) === []);

$res = request('POST', API . '?resource=streak', $GUEST_SID, ['days' => [$yesterday, $today]]);
check('uploading days stores them', ($res['body']['days'] ?? []) === [$yesterday, $today],
    json_encode($res['body']['days'] ?? null));

$res = request('POST', API . '?resource=streak', $GUEST_SID, ['days' => [$yesterday, $today]]);
check('re-uploading the same history changes nothing', ($res['body']['days'] ?? []) === [$yesterday, $today],
    json_encode($res['body']['days'] ?? null));

// The sign-in case: the browser knows a day the account does not.
$older = (new DateTimeImmutable('-5 days'))->format('Y-m-d');
$res = request('POST', API . '?resource=streak', $GUEST_SID, ['days' => [$older]]);
check('a merge adds to history instead of replacing it',
    ($res['body']['days'] ?? []) === [$older, $yesterday, $today],
    json_encode($res['body']['days'] ?? null));

$res = request('GET', API . '?resource=streak', $GUEST_SID);
check('the stored history survives a reload', ($res['body']['days'] ?? []) === [$older, $yesterday, $today]);

// ------------------------------------------------------------------
//  Validation
// ------------------------------------------------------------------

$res = request('POST', API . '?resource=streak', $GUEST_SID, ['days' => 'today']);
check('a non-array days field is rejected', $res['status'] === 400, "got {$res['status']}");

$res = request('POST', API . '?resource=streak', $GUEST_SID, ['days' => array_fill(0, 501, $today)]);
check('an oversized upload is rejected', $res['status'] === 400, "got {$res['status']}");

$before = request('GET', API . '?resource=streak', $GUEST_SID)['body']['days'];
$res = request('POST', API . '?resource=streak', $GUEST_SID,
    ['days' => ['not-a-date', '2026-13-01', '2026-02-31', '', 42, null]]);
check('nonsense entries are skipped without failing the request', $res['status'] === 200, "got {$res['status']}");
check('nonsense entries store nothing', ($res['body']['days'] ?? []) === $before,
    json_encode($res['body']['days'] ?? null));

$res = request('POST', API . '?resource=streak', $GUEST_SID, ['days' => [$tomorrow]]);
check('a clock one day ahead is accepted', in_array($tomorrow, $res['body']['days'] ?? [], true));

$farFuture = (new DateTimeImmutable('+30 days'))->format('Y-m-d');
$res = request('POST', API . '?resource=streak', $GUEST_SID, ['days' => [$farFuture]]);
check('a day far in the future is dropped', !in_array($farFuture, $res['body']['days'] ?? [], true));

$ancient = (new DateTimeImmutable('-10 years'))->format('Y-m-d');
$res = request('POST', API . '?resource=streak', $GUEST_SID, ['days' => [$ancient]]);
check('an implausibly old day is dropped', !in_array($ancient, $res['body']['days'] ?? [], true));

// ------------------------------------------------------------------
//  Isolation
// ------------------------------------------------------------------

$adminOnly = (new DateTimeImmutable('-3 days'))->format('Y-m-d');
request('POST', API . '?resource=streak', $ADMIN_SID, ['days' => [$adminOnly]]);

$res = request('GET', API . '?resource=streak', $GUEST_SID);
check("one learner's days never appear in another's streak",
    !in_array($adminOnly, $res['body']['days'] ?? [], true),
    json_encode($res['body']['days'] ?? null));

$res = request('GET', API . '?resource=streak', $ADMIN_SID);
check('each account reads only its own history', ($res['body']['days'] ?? []) === [$adminOnly],
    json_encode($res['body']['days'] ?? null));

// ------------------------------------------------------------------

echo "\n$passed passed, $failed failed\n";
exit($failed === 0 ? 0 : 1);
