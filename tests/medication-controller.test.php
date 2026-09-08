<?php
declare(strict_types=1);

// Integration tests for app/controllers/medication-controller.php, the private
// medication tracker backend (views/medication).
//
// Contract: EVERY branch sits behind Auth::requireAdmin(). This is a
// single-owner personal tool; a signed-in non-admin is 403 on all of it,
// reads included, exactly like the anonymous public is 401. Rows carry no
// user_id.
//
// Runs ONLY against the local scratch DB (127.0.0.1/portfolio): the DB_* env
// overrides below make database.php skip loading app/.env (which points at the
// remote production database). Never run these against prod.
//
// Requires the seeded test users in the local DB:
//   admin@test.local  session token = 64 x 'a'
//   guest@test.local  session token = 64 x 'b'
// Setup applies app/models/medication-model.sql if the tables are absent;
// teardown deletes only the rows this run created (id baselines).
//
// Run: /opt/lampp/bin/php tests/medication-controller.test.php

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
const PORT     = 8962;
const API      = 'http://' . HOST . ':' . PORT . '/app/controllers/medication-controller.php';

// Fixture days live far in the past so they can never collide with real doses
// on the scratch DB. Dose rows cascade off the medications this run creates,
// so the id baseline alone is enough to clean up.
const DAY_A = '1999-05-01';
const DAY_B = '1999-05-02';

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
$schema = (string) file_get_contents(DOC_ROOT . '/app/models/medication-model.sql');
$schema = preg_replace('/^\s*--.*$/m', '', $schema); // strip comments BEFORE splitting on ';'
foreach (array_filter(array_map('trim', explode(';', $schema))) as $sql) {
    $pdo->exec($sql);
}

$medBaseline = (int) $pdo->query('SELECT COALESCE(MAX(id), 0) FROM medication_meds')->fetchColumn();

register_shutdown_function(function () use ($pdo, $medBaseline) {
    // Dose rows cascade off the medications, so this reaches both tables.
    $pdo->exec("DELETE FROM medication_meds WHERE id > $medBaseline");
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

echo "medication controller: gate\n";

$res = request('GET', API . '?resource=state');
check('anonymous GET is 401', $res['status'] === 401, "got {$res['status']}");
check('no wildcard CORS header', !hasHeader($res['headers'], 'Access-Control-Allow-Origin'));
check('no-store on responses', hasHeader($res['headers'], 'Cache-Control'));

$res = request('GET', API . '?resource=state', $GUEST_SID);
check('signed-in non-admin is 403 on reads', $res['status'] === 403, "got {$res['status']}");

$res = request('POST', API . '?resource=med', $GUEST_SID, ['name' => 'MT guest']);
check('signed-in non-admin is 403 on writes', $res['status'] === 403, "got {$res['status']}");

$res = request('PUT', API . '?resource=dose', $GUEST_SID, ['med_id' => 1, 'day' => DAY_A, 'slot' => 0, 'taken' => true]);
check('signed-in non-admin is 403 on dose writes', $res['status'] === 403, "got {$res['status']}");

$res = request('GET', API . '?resource=state', $ADMIN_SID);
check('admin reads state (200)', $res['status'] === 200, "got {$res['status']}");
check('state carries meds, taken and history', is_array($res['body'])
    && isset($res['body']['meds'], $res['body']['taken'], $res['body']['history'], $res['body']['day']));

$res = request('GET', API . '?resource=nonsense', $ADMIN_SID);
check('unknown resource is 400', $res['status'] === 400, "got {$res['status']}");

$res = request('POST', API . '?resource=state', $ADMIN_SID, []);
check('wrong method on a read-only resource is 405', $res['status'] === 405, "got {$res['status']}");

// ------------------------------------------------------------------
//  Medications: create, read, update, soft delete
// ------------------------------------------------------------------

echo "\nmedications\n";

$res = request('POST', API . '?resource=med', $ADMIN_SID, [
    'name' => 'MT Magnesium', 'form' => 'tablet', 'doses_per_day' => 2,
    'starts_on' => null, 'ends_on' => null,
]);
check('create returns 201', $res['status'] === 201, "got {$res['status']}");
check('create echoes the stored row', ($res['body']['name'] ?? '') === 'MT Magnesium'
    && ($res['body']['doses_per_day'] ?? 0) === 2 && ($res['body']['form'] ?? '') === 'tablet');
check('create fills created_on for the history fallback', !empty($res['body']['created_on']));
check('the row never leaks deleted_at', !array_key_exists('deleted_at', $res['body'] ?? []));
$magId = (int) ($res['body']['id'] ?? 0);

$res = request('POST', API . '?resource=med', $ADMIN_SID, ['name' => 'MT Amoxicillin', 'form' => 'capsule', 'doses_per_day' => 3, 'starts_on' => '1999-05-01', 'ends_on' => '1999-05-02']);
$amoxId = (int) ($res['body']['id'] ?? 0);
check('a course keeps both its dates', ($res['body']['starts_on'] ?? '') === '1999-05-01'
    && ($res['body']['ends_on'] ?? '') === '1999-05-02', json_encode($res['body']));

$res = request('GET', API . '?resource=state&day=' . DAY_A, $ADMIN_SID);
$names = array_column($res['body']['meds'] ?? [], 'name');
check('state lists both medications', in_array('MT Magnesium', $names, true) && in_array('MT Amoxicillin', $names, true));
check('state sorts the shelf by name', array_search('MT Amoxicillin', $names, true) < array_search('MT Magnesium', $names, true));

$res = request('PUT', API . '?resource=med&id=' . $magId, $ADMIN_SID, ['name' => 'MT Magnesium B6', 'form' => 'capsule', 'doses_per_day' => 1]);
check('update returns 200 with the new values', $res['status'] === 200
    && ($res['body']['name'] ?? '') === 'MT Magnesium B6' && ($res['body']['doses_per_day'] ?? 0) === 1, json_encode($res['body']));

$res = request('PUT', API . '?resource=med&id=999999', $ADMIN_SID, ['name' => 'MT ghost']);
check('updating a medication that is not there is 404', $res['status'] === 404, "got {$res['status']}");

$res = request('DELETE', API . '?resource=med&id=' . $amoxId, $ADMIN_SID);
check('delete returns 200', $res['status'] === 200, "got {$res['status']}");

$res = request('GET', API . '?resource=state&day=' . DAY_A, $ADMIN_SID);
check('a soft-deleted medication is gone from state',
    !in_array('MT Amoxicillin', array_column($res['body']['meds'] ?? [], 'name'), true));

$row = $pdo->query("SELECT deleted_at FROM medication_meds WHERE id = $amoxId")->fetch(PDO::FETCH_ASSOC);
check('delete is soft: the row survives with a stamp', $row !== false && $row['deleted_at'] !== null);

$res = request('DELETE', API . '?resource=med&id=' . $amoxId, $ADMIN_SID);
check('deleting it again is 404', $res['status'] === 404, "got {$res['status']}");

$res = request('DELETE', API . '?resource=med', $ADMIN_SID);
check('delete without an id is 400', $res['status'] === 400, "got {$res['status']}");

// ------------------------------------------------------------------
//  Validation: the same rules as validateMed() in logic.js
// ------------------------------------------------------------------

echo "\nvalidation\n";

$cases = [
    ['a blank name is 422',            ['name' => '   ']],
    ['a missing name is 422',          []],
    ['a name over 100 chars is 422',   ['name' => str_repeat('x', 101)]],
    ['zero doses a day is 422',        ['name' => 'MT v', 'doses_per_day' => 0]],
    ['thirteen doses a day is 422',    ['name' => 'MT v', 'doses_per_day' => 13]],
    ['a fractional dose count is 422', ['name' => 'MT v', 'doses_per_day' => 2.5]],
    ['a non-numeric dose count is 422',['name' => 'MT v', 'doses_per_day' => 'lots']],
    ['a form outside the list is 422', ['name' => 'MT v', 'form' => 'suppository']],
    ['an unparseable date is 422',     ['name' => 'MT v', 'starts_on' => '08.09.2026']],
    ['an impossible date is 422',      ['name' => 'MT v', 'starts_on' => '2026-02-31']],
    ['ending before starting is 422',  ['name' => 'MT v', 'starts_on' => '1999-05-02', 'ends_on' => '1999-05-01']],
];
foreach ($cases as [$label, $body]) {
    $res = request('POST', API . '?resource=med', $ADMIN_SID, $body);
    check($label, $res['status'] === 422, "got {$res['status']}");
}

$res = request('POST', API . '?resource=med', $ADMIN_SID, ['name' => 'MT One day', 'starts_on' => '1999-05-01', 'ends_on' => '1999-05-01']);
check('a one-day course is accepted', $res['status'] === 201, "got {$res['status']}");
$oneDayId = (int) ($res['body']['id'] ?? 0);

$res = request('POST', API . '?resource=med', $ADMIN_SID, ['name' => 'MT Bare']);
check('a bare medication defaults to one tablet a day', $res['status'] === 201
    && ($res['body']['form'] ?? '') === 'tablet' && ($res['body']['doses_per_day'] ?? 0) === 1);
$bareId = (int) ($res['body']['id'] ?? 0);

// ------------------------------------------------------------------
//  Doses: the idempotent toggle
// ------------------------------------------------------------------

echo "\ndoses\n";

$take = ['med_id' => $magId, 'day' => DAY_A, 'slot' => 0, 'taken' => true];

$res = request('PUT', API . '?resource=dose', $ADMIN_SID, $take);
check('taking a dose returns 200 with a stamp', $res['status'] === 200
    && ($res['body']['taken'] ?? null) === true && !empty($res['body']['taken_at']), json_encode($res['body']));
$firstStamp = $res['body']['taken_at'];

$res = request('PUT', API . '?resource=dose', $ADMIN_SID, $take);
check('taking the same slot again is still 200', $res['status'] === 200);
check('a repeated take keeps the original stamp', ($res['body']['taken_at'] ?? '') === $firstStamp,
    'a retried tap must not re-time the dose');

$count = (int) $pdo->query("SELECT COUNT(*) FROM medication_doses WHERE med_id = $magId AND day = '" . DAY_A . "'")->fetchColumn();
check('a repeated take writes exactly one row', $count === 1, "got $count rows");

$res = request('GET', API . '?resource=state&day=' . DAY_A, $ADMIN_SID);
$mine = array_values(array_filter($res['body']['taken'] ?? [], static fn ($r) => $r['med_id'] === $magId));
check('state reports the taken slot', count($mine) === 1 && $mine[0]['slot'] === 0, json_encode($mine));

$res = request('PUT', API . '?resource=dose', $ADMIN_SID, ['med_id' => $magId, 'day' => DAY_A, 'slot' => 0, 'taken' => false]);
check('releasing a dose returns 200 and no stamp', $res['status'] === 200
    && ($res['body']['taken'] ?? null) === false && ($res['body']['taken_at'] ?? 'x') === null);

$res = request('PUT', API . '?resource=dose', $ADMIN_SID, ['med_id' => $magId, 'day' => DAY_A, 'slot' => 0, 'taken' => false]);
check('releasing it again is a no-op, not an error', $res['status'] === 200, "got {$res['status']}");

$count = (int) $pdo->query("SELECT COUNT(*) FROM medication_doses WHERE med_id = $magId")->fetchColumn();
check('releasing really deletes the row', $count === 0, "got $count rows");

// MT Magnesium B6 was cut to one dose a day, so slot 1 is off its schedule.
$res = request('PUT', API . '?resource=dose', $ADMIN_SID, ['med_id' => $magId, 'day' => DAY_A, 'slot' => 1, 'taken' => true]);
check('a slot past the schedule is 422', $res['status'] === 422, "got {$res['status']}");

$res = request('PUT', API . '?resource=dose', $ADMIN_SID, ['med_id' => $magId, 'day' => DAY_A, 'slot' => -1, 'taken' => true]);
check('a negative slot is 422', $res['status'] === 422, "got {$res['status']}");

$res = request('PUT', API . '?resource=dose', $ADMIN_SID, ['med_id' => $amoxId, 'day' => DAY_A, 'slot' => 0, 'taken' => true]);
check('a dose against a deleted medication is 404', $res['status'] === 404, "got {$res['status']}");

$res = request('PUT', API . '?resource=dose', $ADMIN_SID, ['med_id' => 999999, 'day' => DAY_A, 'slot' => 0, 'taken' => true]);
check('a dose against an unknown medication is 404', $res['status'] === 404, "got {$res['status']}");

$res = request('PUT', API . '?resource=dose', $ADMIN_SID, ['med_id' => $magId, 'day' => 'today', 'slot' => 0, 'taken' => true]);
check('a dose with an unparseable day is 400', $res['status'] === 400, "got {$res['status']}");

$res = request('POST', API . '?resource=dose', $ADMIN_SID, $take);
check('POST on the dose resource is 405', $res['status'] === 405, "got {$res['status']}");

// ------------------------------------------------------------------
//  State is scoped to the day it was asked for
// ------------------------------------------------------------------

echo "\nstate by day\n";

request('PUT', API . '?resource=dose', $ADMIN_SID, ['med_id' => $bareId, 'day' => DAY_A, 'slot' => 0, 'taken' => true]);
request('PUT', API . '?resource=dose', $ADMIN_SID, ['med_id' => $oneDayId, 'day' => DAY_B, 'slot' => 0, 'taken' => true]);

$res = request('GET', API . '?resource=state&day=' . DAY_A, $ADMIN_SID);
check('state returns the asked-for day', ($res['body']['day'] ?? '') === DAY_A);
$ids = array_column($res['body']['taken'] ?? [], 'med_id');
check('day A carries only day A\'s doses', in_array($bareId, $ids, true) && !in_array($oneDayId, $ids, true), json_encode($ids));

$res = request('GET', API . '?resource=state&day=' . DAY_B, $ADMIN_SID);
$ids = array_column($res['body']['taken'] ?? [], 'med_id');
check('day B carries only day B\'s doses', in_array($oneDayId, $ids, true) && !in_array($bareId, $ids, true), json_encode($ids));

$res = request('GET', API . '?resource=state&day=' . DAY_B . '&days=7', $ADMIN_SID);
$hist = array_values(array_filter($res['body']['history'] ?? [], static fn ($r) => $r['med_id'] === $bareId));
check('the history window reaches back over the requested days',
    count($hist) === 1 && $hist[0]['day'] === DAY_A && $hist[0]['taken'] === 1, json_encode($hist));

$res = request('GET', API . '?resource=state&day=' . DAY_A . '&days=1', $ADMIN_SID);
$hist = array_column($res['body']['history'] ?? [], 'day');
check('a one-day window excludes the day before', !in_array('1999-04-30', $hist, true));

$res = request('GET', API . '?resource=state', $ADMIN_SID . '');
check('state without a day is 400', $res['status'] === 400, "got {$res['status']}");

$res = request('GET', API . '?resource=state&day=1999-02-31', $ADMIN_SID);
check('state with an impossible day is 400', $res['status'] === 400, "got {$res['status']}");

// A deleted medication must leave both sides of the ledger, or a day's taken
// count could outrun what was planned for it.
$res = request('DELETE', API . '?resource=med&id=' . $bareId, $ADMIN_SID);
$res = request('GET', API . '?resource=state&day=' . DAY_A . '&days=7', $ADMIN_SID);
$ids = array_column($res['body']['taken'] ?? [], 'med_id');
check('a deleted medication\'s doses leave state too', !in_array($bareId, $ids, true), json_encode($ids));
check('and leave the history strip', !in_array($bareId, array_column($res['body']['history'] ?? [], 'med_id'), true));

echo "\n$passed passed, $failed failed\n";
exit($failed === 0 ? 0 : 1);
