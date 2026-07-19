<?php
declare(strict_types=1);

// Integration tests for app/controllers/compass-controller.php, the private
// No More Mr. Nice Guy practice tracker backend (views/compass).
//
// Contract: EVERY branch sits behind Auth::requireAdmin(). This is a
// single-owner personal tool; a signed-in non-admin is 403 on all of it,
// exactly like the anonymous public is 401. Rows carry no user_id.
//
// Runs ONLY against the local scratch DB (127.0.0.1/portfolio): the DB_* env
// overrides below make database.php skip loading app/.env (which points at the
// remote production database). Never run these against prod.
//
// Requires the seeded test users in the local DB:
//   admin@test.local  session token = 64 x 'a'
//   guest@test.local  session token = 64 x 'b'
// Setup applies app/models/compass-model.sql if the tables are absent;
// teardown deletes only the rows this run created (id / day baselines).
//
// Run: /opt/lampp/bin/php tests/compass-controller.test.php

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
const PORT     = 8957;
const API      = 'http://' . HOST . ':' . PORT . '/app/controllers/compass-controller.php';

// Fixture days live far in the past so they can never collide with real
// check-ins on the scratch DB; teardown removes exactly these days.
const FIXTURE_DAYS = ['1999-05-01', '1999-05-02', '1999-05-03'];

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
    $opts = ['http' => ['method' => $method, 'ignore_errors' => true, 'timeout' => 15]];
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

// Apply the schema statement-by-statement (CREATE TABLE IF NOT EXISTS
// throughout, so this is a no-op once the tables exist).
$schema = (string) file_get_contents(DOC_ROOT . '/app/models/compass-model.sql');
$schema = preg_replace('/^\s*--.*$/m', '', $schema); // strip comments BEFORE splitting on ';'
foreach (array_filter(array_map('trim', explode(';', $schema))) as $sql) {
    $pdo->exec($sql);
}

$catchBaseline    = (int) $pdo->query('SELECT COALESCE(MAX(id), 0) FROM compass_catches')->fetchColumn();
$activityBaseline = (int) $pdo->query('SELECT COALESCE(MAX(id), 0) FROM compass_activities')->fetchColumn();

register_shutdown_function(function () use ($pdo, $catchBaseline, $activityBaseline) {
    $days = "'" . implode("','", FIXTURE_DAYS) . "'";
    $pdo->exec("DELETE FROM compass_checkins WHERE day IN ($days)");
    $pdo->exec("DELETE FROM compass_catches WHERE id > $catchBaseline");
    $pdo->exec("DELETE FROM compass_activities WHERE id > $activityBaseline");
});

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
//  The gate: admin only, on every branch
// ------------------------------------------------------------------

echo "compass controller: gate\n";

$res = request('GET', API . '?resource=state');
check('anonymous GET is 401', $res['status'] === 401, "got {$res['status']}");
check('no wildcard CORS header', !hasHeader($res['headers'], 'Access-Control-Allow-Origin'));
check('no-store on responses', hasHeader($res['headers'], 'Cache-Control'));

$res = request('GET', API . '?resource=state', $GUEST_SID);
check('signed-in non-admin is 403 on reads', $res['status'] === 403, "got {$res['status']}");

$res = request('POST', API . '?resource=checkin', $GUEST_SID, ['day' => FIXTURE_DAYS[0], 'practices' => []]);
check('signed-in non-admin is 403 on writes', $res['status'] === 403, "got {$res['status']}");

$res = request('GET', API . '?resource=state', $ADMIN_SID);
check('admin reads state (200)', $res['status'] === 200, "got {$res['status']}");
check('state carries checkins, catches and activities arrays',
    is_array($res['body']['checkins'] ?? null)
    && is_array($res['body']['catches'] ?? null)
    && is_array($res['body']['activities'] ?? null),
    json_encode($res['body']));

$res = request('GET', API . '?resource=nonsense', $ADMIN_SID);
check('unknown resource is 400', $res['status'] === 400, "got {$res['status']}");

// ------------------------------------------------------------------
//  Check-ins: one row per day, upserted
// ------------------------------------------------------------------

echo "compass controller: check-ins\n";

$res = request('POST', API . '?resource=checkin', $ADMIN_SID, [
    'day' => FIXTURE_DAYS[0],
    'practices' => ['seen' => true, 'present' => true, 'direct' => false],
    'note' => 'first day of doing this properly',
]);
check('admin logs a day (200)', $res['status'] === 200, "got {$res['status']}: " . json_encode($res['body']));
check('check-in echoes practices as booleans',
    ($res['body']['practices']['seen'] ?? null) === true
    && ($res['body']['practices']['direct'] ?? null) === false,
    json_encode($res['body']));
check('check-in echoes the note', ($res['body']['note'] ?? '') === 'first day of doing this properly');

$res = request('POST', API . '?resource=checkin', $ADMIN_SID, [
    'day' => FIXTURE_DAYS[0],
    'practices' => ['seen' => true, 'present' => true, 'direct' => true, 'lead' => true],
]);
check('same day again updates in place (200)', $res['status'] === 200, "got {$res['status']}");
check('updated day now has the new practices', ($res['body']['practices']['direct'] ?? null) === true);

$count = (int) $pdo->query(
    "SELECT COUNT(*) FROM compass_checkins WHERE day = '" . FIXTURE_DAYS[0] . "'"
)->fetchColumn();
check('upsert keeps a single row per day', $count === 1, "got $count rows");

$res = request('GET', API . '?resource=state', $ADMIN_SID);
$days = array_column($res['body']['checkins'], 'day');
check('state now carries the logged day', in_array(FIXTURE_DAYS[0], $days, true));

// Validation.
$res = request('POST', API . '?resource=checkin', $ADMIN_SID, ['day' => 'someday', 'practices' => []]);
check('bad day is rejected (422)', $res['status'] === 422, "got {$res['status']}");

$res = request('POST', API . '?resource=checkin', $ADMIN_SID, [
    'day' => FIXTURE_DAYS[1], 'practices' => ['seen' => true, 'hacked' => true],
]);
check('unknown practice key is rejected (422)', $res['status'] === 422, "got {$res['status']}");

$res = request('POST', API . '?resource=checkin', $ADMIN_SID, [
    'day' => FIXTURE_DAYS[1], 'practices' => [], 'note' => str_repeat('x', 5000),
]);
check('over-long note is rejected (422)', $res['status'] === 422, "got {$res['status']}");

$res = request('GET', API . '?resource=checkin', $ADMIN_SID);
check('checkin only accepts POST (405)', $res['status'] === 405, "got {$res['status']}");

// ------------------------------------------------------------------
//  Catch log: pattern slips, logged in the moment
// ------------------------------------------------------------------

echo "compass controller: catches\n";

$res = request('POST', API . '?resource=catch', $ADMIN_SID, [
    'pattern' => 'covert',
    'note' => 'sent flowers, then got cold when she did not gush about them',
    'instead' => 'give the gift OR name what I want. Never both bundled silently.',
]);
check('admin logs a catch (201)', $res['status'] === 201, "got {$res['status']}: " . json_encode($res['body']));
$catchId = (int) ($res['body']['id'] ?? 0);
check('catch echoes its row with a timestamp',
    ($res['body']['pattern'] ?? '') === 'covert' && !empty($res['body']['caught_at']));

$res = request('GET', API . '?resource=state', $ADMIN_SID);
$catchIds = array_map('intval', array_column($res['body']['catches'], 'id'));
check('state carries the new catch', in_array($catchId, $catchIds, true));

$res = request('POST', API . '?resource=catch', $ADMIN_SID, ['pattern' => 'martyrdom']);
check('unknown pattern is rejected (422)', $res['status'] === 422, "got {$res['status']}");

$res = request('POST', API . '?resource=catch', $ADMIN_SID, [
    'pattern' => 'deer', 'note' => str_repeat('y', 5000),
]);
check('over-long catch note is rejected (422)', $res['status'] === 422, "got {$res['status']}");

$res = request('DELETE', API . '?resource=catch&id=' . $catchId, $ADMIN_SID);
check('admin deletes a catch', $res['status'] === 200, "got {$res['status']}");

$res = request('DELETE', API . '?resource=catch&id=' . $catchId, $ADMIN_SID);
check('deleting it again is 404', $res['status'] === 404, "got {$res['status']}");

// ------------------------------------------------------------------
//  Workbook: Breaking Free activity states
// ------------------------------------------------------------------

echo "compass controller: activities\n";

$res = request('POST', API . '?resource=activity', $ADMIN_SID, [
    'num' => 46, 'status' => 'doing', 'note' => 'drafting my rules',
]);
check('admin marks an activity (200)', $res['status'] === 200, "got {$res['status']}: " . json_encode($res['body']));
check('activity echoes num, status and note',
    (int) ($res['body']['num'] ?? 0) === 46 && ($res['body']['status'] ?? '') === 'doing'
    && ($res['body']['note'] ?? '') === 'drafting my rules');

$res = request('POST', API . '?resource=activity', $ADMIN_SID, ['num' => 46, 'status' => 'done']);
check('same activity again updates in place', $res['status'] === 200 && ($res['body']['status'] ?? '') === 'done');

$count = (int) $pdo->query('SELECT COUNT(*) FROM compass_activities WHERE activity_num = 46')->fetchColumn();
check('upsert keeps a single row per activity', $count === 1, "got $count rows");

$res = request('GET', API . '?resource=state', $ADMIN_SID);
$act46 = null;
foreach ($res['body']['activities'] as $a) {
    if ((int) $a['num'] === 46) $act46 = $a;
}
check('state carries the workbook row', $act46 !== null && $act46['status'] === 'done');

$res = request('POST', API . '?resource=activity', $ADMIN_SID, ['num' => 47, 'status' => 'done']);
check('activity number out of range is rejected (422)', $res['status'] === 422, "got {$res['status']}");

$res = request('POST', API . '?resource=activity', $ADMIN_SID, ['num' => 3, 'status' => 'skipped']);
check('unknown status is rejected (422)', $res['status'] === 422, "got {$res['status']}");

echo "\n$passed passed, $failed failed\n";
exit($failed === 0 ? 0 : 1);
