<?php
declare(strict_types=1);

// Integration tests for workout-controller.php: demo scoping, ownership
// isolation, soft delete, exercise type immutability, and set-log upserts.
//
// Runs ONLY against the local scratch DB (127.0.0.1/portfolio): the DB_* env
// overrides below make database.php skip loading app/.env, which points at
// the remote production database. Never run these against prod.
//
// Requires the seeded test users in the local DB:
//   admin@test.local  session token = 64 x 'a'   (first active admin = demo showcase)
//   guest@test.local  session token = 64 x 'b'
//
// Run: /opt/lampp/bin/php tests/workout-controller.test.php

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
const PORT     = 8932;
const API      = 'http://' . HOST . ':' . PORT . '/app/controllers/workout-controller.php';

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

// ------------------------------------------------------------------
//  HTTP helper
// ------------------------------------------------------------------

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
    $opts['http']['header'] = implode("\r\n", $headers);
    $raw = file_get_contents($url, false, stream_context_create($opts));
    $status = 0;
    foreach ($http_response_header ?? [] as $h) {
        if (preg_match('#^HTTP/\S+\s+(\d{3})#', $h, $m)) {
            $status = (int) $m[1];
        }
    }
    return ['status' => $status, 'body' => $raw !== false ? json_decode($raw, true) : null];
}

function workoutNames(?array $body): array
{
    return array_map(fn ($w) => $w['name'], $body['workouts'] ?? []);
}

// ------------------------------------------------------------------
//  Fixtures (all names prefixed 'WT ' so teardown can never touch real rows)
// ------------------------------------------------------------------

$pdo = new PDO(DB_DSN, DB_USER, DB_PASS, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);

function teardown(PDO $pdo): void
{
    // Order matters: sessions first (their sets cascade), then workouts
    // (items cascade), then exercises. Hard deletes bypass the soft delete.
    $pdo->exec("DELETE FROM workout_sessions WHERE workout_name LIKE 'WT %'");
    $pdo->exec("DELETE FROM workouts WHERE name LIKE 'WT %'");
    $pdo->exec("DELETE FROM workout_exercises WHERE name LIKE 'WT %'");
}

teardown($pdo); // clean leftovers from a crashed previous run

$showcaseId = (int) $pdo->query(
    "SELECT id FROM users WHERE is_admin = 1 AND is_active = 1 ORDER BY id LIMIT 1"
)->fetchColumn();
$guestId = (int) $pdo->query("SELECT id FROM users WHERE email = 'guest@test.local'")->fetchColumn();
if ($showcaseId === 0 || $guestId === 0) {
    fwrite(STDERR, "Missing seeded test users in local DB\n");
    exit(1);
}

// The showcase (first active admin) owns the demo rows anonymous visitors see.
$pdo->prepare("INSERT INTO workout_exercises (user_id, name, type) VALUES (?, 'WT Showcase pushups', 'reps')")
    ->execute([$showcaseId]);
$showcaseExId = (int) $pdo->lastInsertId();
$pdo->prepare("INSERT INTO workouts (user_id, name, rounds) VALUES (?, 'WT Demo circuit', 3)")
    ->execute([$showcaseId]);
$showcaseWorkoutId = (int) $pdo->lastInsertId();
$pdo->prepare('INSERT INTO workout_items (workout_id, exercise_id, position, target_reps) VALUES (?, ?, 1, 15)')
    ->execute([$showcaseWorkoutId, $showcaseExId]);

// ------------------------------------------------------------------
//  Server lifecycle
// ------------------------------------------------------------------

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

echo "workout-controller demo scoping and ownership\n";

$res = request('GET', API . '?resource=workouts');
check('anonymous GET workouts succeeds', $res['status'] === 200, "got {$res['status']}");
check('anonymous list is demo', ($res['body']['demo'] ?? null) === true);
check('anonymous sees showcase workout', in_array('WT Demo circuit', workoutNames($res['body']), true));

$res = request('GET', API . '?resource=session');
check('anonymous session probe is demo', ($res['body']['demo'] ?? null) === true);

$res = request('POST', API . '?resource=workout', null, ['name' => 'WT hacked', 'rounds' => 3, 'items' => []]);
check('anonymous POST workout is rejected with 401', $res['status'] === 401, "got {$res['status']}");

$res = request('POST', API . '?resource=exercise', null, ['name' => 'WT hacked', 'type' => 'reps']);
check('anonymous POST exercise is rejected with 401', $res['status'] === 401, "got {$res['status']}");

$res = request('GET', API . '?resource=workouts', $GUEST_SID);
check('guest list is not demo', ($res['body']['demo'] ?? null) === false);
check('guest does not see showcase workout', !in_array('WT Demo circuit', workoutNames($res['body']), true));

echo "\nexercise library\n";

$res = request('POST', API . '?resource=exercise', $GUEST_SID, ['name' => 'WT Guest pullups', 'type' => 'reps']);
check('guest creates reps exercise', $res['status'] === 201, "got {$res['status']}");
$ex1 = (int) ($res['body']['id'] ?? 0);

$res = request('POST', API . '?resource=exercise', $GUEST_SID,
    ['name' => 'WT Guest bench', 'type' => 'weighted', 'icon' => 'fas fa-dumbbell']);
check('guest creates weighted exercise', $res['status'] === 201, "got {$res['status']}");
$ex2 = (int) ($res['body']['id'] ?? 0);

$res = request('POST', API . '?resource=exercise', $GUEST_SID, ['name' => 'WT Bad', 'type' => 'yoga']);
check('unknown exercise type is rejected', $res['status'] === 400, "got {$res['status']}");

$res = request('PUT', API . '?resource=exercise&id=' . $ex1, $GUEST_SID,
    ['name' => 'WT Guest pullups', 'type' => 'time']);
check('exercise type change is rejected with 400', $res['status'] === 400, "got {$res['status']}");

$res = request('PUT', API . '?resource=exercise&id=' . $showcaseExId, $GUEST_SID, ['name' => 'WT stolen']);
check("guest cannot edit showcase's exercise (404)", $res['status'] === 404, "got {$res['status']}");

echo "\nworkout save validation\n";

$item1 = ['exercise_id' => $ex1, 'target_reps' => 12];
$item2 = ['exercise_id' => $ex2, 'target_reps' => 10, 'target_weight_kg' => 40];

$res = request('POST', API . '?resource=workout', $GUEST_SID,
    ['name' => 'WT Dup', 'rounds' => 2, 'items' => [$item1, $item1]]);
check('duplicate exercise in one workout is rejected', $res['status'] === 400, "got {$res['status']}");

$res = request('POST', API . '?resource=workout', $GUEST_SID,
    ['name' => 'WT No weight', 'rounds' => 2, 'items' => [['exercise_id' => $ex2, 'target_reps' => 10]]]);
check('weighted item without weight is rejected', $res['status'] === 400, "got {$res['status']}");

$res = request('POST', API . '?resource=workout', $GUEST_SID,
    ['name' => 'WT Guest day', 'rounds' => 2, 'items' => [$item2, $item1]]);
check('valid workout saves', $res['status'] === 200, "got {$res['status']}");
$workoutId = (int) ($res['body']['id'] ?? 0);
$saved = $res['body']['items'] ?? [];
check('items come back in array order',
    count($saved) === 2 && $saved[0]['exercise_id'] === $ex2 && $saved[1]['exercise_id'] === $ex1,
    json_encode(array_map(fn ($i) => $i['exercise_id'], $saved)));
check('weighted target echoed numerically', (float) ($saved[0]['target_weight_kg'] ?? 0) === 40.0);

$res = request('PUT', API . '?resource=workout&id=' . $workoutId, $GUEST_SID,
    ['name' => 'WT Guest day 2', 'rounds' => 3, 'items' => [$item1, $item2]]);
check('atomic update rewrites items in new order',
    $res['status'] === 200 && ($res['body']['items'][0]['exercise_id'] ?? 0) === $ex1,
    "got {$res['status']}");

$res = request('PUT', API . '?resource=workout&id=' . $showcaseWorkoutId, $GUEST_SID,
    ['name' => 'WT stolen', 'rounds' => 1, 'items' => [$item1]]);
check("guest cannot edit showcase's workout (404)", $res['status'] === 404, "got {$res['status']}");

$res = request('DELETE', API . '?resource=exercise&id=' . $ex1, $GUEST_SID);
check('exercise delete is blocked while referenced by a workout', $res['status'] === 400, "got {$res['status']}");

echo "\nsessions and set logging\n";

$res = request('POST', API . '?resource=sessions', $GUEST_SID, ['workout_id' => $showcaseWorkoutId]);
check("guest cannot start a session on showcase's workout (404)", $res['status'] === 404, "got {$res['status']}");

$res = request('POST', API . '?resource=sessions', $GUEST_SID, ['workout_id' => $workoutId]);
check('session created with snapshot', $res['status'] === 201
    && ($res['body']['workout_name'] ?? '') === 'WT Guest day 2'
    && ($res['body']['rounds'] ?? 0) === 3, json_encode($res['body']));
$sessionId = (int) ($res['body']['id'] ?? 0);

$res = request('POST', API . "?resource=sessions&id=$sessionId&action=log", $GUEST_SID,
    ['exercise_id' => $ex1, 'round_number' => 1, 'actual_reps' => 12]);
check('set logs', $res['status'] === 200, "got {$res['status']}");

$res = request('POST', API . "?resource=sessions&id=$sessionId&action=log", $GUEST_SID,
    ['exercise_id' => $ex1, 'round_number' => 1, 'actual_reps' => 9]);
check('re-logging the same set upserts', $res['status'] === 200 && ($res['body']['actual_reps'] ?? 0) === 9);

$res = request('GET', API . "?resource=sessions&id=$sessionId", $GUEST_SID);
$sets = $res['body']['session']['sets'] ?? [];
check('upsert did not duplicate the set', count($sets) === 1 && $sets[0]['actual_reps'] === 9,
    json_encode($sets));

$res = request('POST', API . "?resource=sessions&id=$sessionId&action=log", $GUEST_SID,
    ['exercise_id' => $ex1, 'round_number' => 9, 'actual_reps' => 12]);
check('round number beyond snapshot rounds is rejected', $res['status'] === 400, "got {$res['status']}");

$res = request('GET', API . "?resource=sessions&open=1&workout_id=$workoutId", $GUEST_SID);
check('open probe finds the unfinished session', ($res['body']['session']['id'] ?? 0) === $sessionId);

$res = request('POST', API . "?resource=sessions&id=$sessionId&action=unlog", $GUEST_SID,
    ['exercise_id' => $ex1, 'round_number' => 1]);
check('unlog removes the set', $res['status'] === 200);

$res = request('POST', API . "?resource=sessions&id=$sessionId&action=finish", $GUEST_SID, []);
check('finishing an empty session is rejected', $res['status'] === 400, "got {$res['status']}");

request('POST', API . "?resource=sessions&id=$sessionId&action=log", $GUEST_SID,
    ['exercise_id' => $ex2, 'round_number' => 2, 'actual_reps' => 8, 'actual_weight_kg' => 42.5]);
$res = request('POST', API . "?resource=sessions&id=$sessionId&action=finish", $GUEST_SID, []);
check('finish stamps finished_at', $res['status'] === 200 && !empty($res['body']['finished_at']));

$res = request('GET', API . "?resource=sessions&open=1&workout_id=$workoutId", $GUEST_SID);
check('open probe ignores finished sessions',
    is_array($res['body']) && array_key_exists('session', $res['body']) && $res['body']['session'] === null);

$res = request('POST', API . "?resource=sessions&id=$sessionId&action=log", $GUEST_SID,
    ['exercise_id' => $ex1, 'round_number' => 1, 'actual_reps' => 5]);
check('logging into a finished session is rejected', $res['status'] === 400, "got {$res['status']}");

echo "\nsoft delete\n";

$res = request('DELETE', API . '?resource=workout&id=' . $workoutId, $GUEST_SID);
check('workout soft delete succeeds', $res['status'] === 200, "got {$res['status']}");

$res = request('GET', API . '?resource=workouts', $GUEST_SID);
check('soft-deleted workout vanishes from the list', !in_array('WT Guest day 2', workoutNames($res['body']), true));

$res = request('PUT', API . '?resource=workout&id=' . $workoutId, $GUEST_SID,
    ['name' => 'WT Zombie', 'rounds' => 1, 'items' => [$item1]]);
check('editing a soft-deleted workout 404s', $res['status'] === 404, "got {$res['status']}");

$res = request('GET', API . '?resource=sessions', $GUEST_SID);
$names = array_map(fn ($s) => $s['workout_name'], $res['body']['sessions'] ?? []);
check('history keeps the session with its snapshot name', in_array('WT Guest day 2', $names, true),
    json_encode($names));

$res = request('DELETE', API . '?resource=exercise&id=' . $ex1, $GUEST_SID);
check('exercise delete allowed once no live workout uses it', $res['status'] === 200, "got {$res['status']}");

$res = request('GET', API . '?resource=exercises', $GUEST_SID);
$exNames = array_map(fn ($e) => $e['name'], $res['body']['exercises'] ?? []);
check('soft-deleted exercise vanishes from the library', !in_array('WT Guest pullups', $exNames, true));

$res = request('GET', API . "?resource=sessions&id=$sessionId", $GUEST_SID);
check('history detail still resolves exercise names after soft deletes',
    ($res['body']['session']['sets'][0]['exercise_name'] ?? '') === 'WT Guest bench',
    json_encode($res['body']['session']['sets'] ?? null));

$res = request('DELETE', API . "?resource=sessions&id=$sessionId", $GUEST_SID);
check('session hard delete succeeds', $res['status'] === 200, "got {$res['status']}");

$res = request('GET', API . '?resource=sessions', $GUEST_SID);
$names = array_map(fn ($s) => $s['workout_name'], $res['body']['sessions'] ?? []);
check('deleted session leaves the log', !in_array('WT Guest day 2', $names, true));

// ------------------------------------------------------------------

echo "\n$passed passed, $failed failed\n";
exit($failed === 0 ? 0 : 1);
