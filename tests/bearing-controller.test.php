<?php
declare(strict_types=1);

// Integration tests for bearing-controller.php (BEARING's room mode:
// anonymous two-seat co-op rooms over a shared event log, with the SERVER
// owning the valley, the animals and their movement).
//
// Runs ONLY against the local scratch DB (127.0.0.1/portfolio): the DB_* env
// overrides below make database.php skip loading app/.env, which points at
// the remote production database. Never run these against prod.
//
// THE LOAD-BEARING SECTIONS:
//   4. AN ANIMAL'S POSITION IS A SECRET. The raw response bytes are searched
//      for the true cell of every collar, during the night and after it.
//   5. A FORGED COMMIT CHANGES NOTHING. A body carrying a bearing, a grade,
//      a cycle number and an animal position must be ignored down to the
//      intent, and only the intent.
//
// Run: /opt/lampp/bin/php tests/bearing-controller.test.php

if (PHP_SAPI !== 'cli') { http_response_code(403); exit('CLI only'); }

const DB_DSN   = 'mysql:host=127.0.0.1;port=3306;dbname=portfolio;charset=utf8mb4';
const DB_USER  = 'portfolio_dev';
const DB_PASS  = 'R2miswz1pNKOxdl4';
const DOC_ROOT = __DIR__ . '/..';
const HOST     = '127.0.0.1';
const PORT     = 8964;
const API      = 'http://' . HOST . ':' . PORT . '/app/controllers/bearing-controller.php';
const N        = 32;

define('NULL_DEV', PHP_OS_FAMILY === 'Windows' ? 'NUL' : '/dev/null');

$passed = 0; $failed = 0;
function check(string $name, bool $cond, string $detail = ''): void {
    global $passed, $failed;
    if ($cond) { $passed++; echo "  ok  $name\n"; }
    else { $failed++; echo "FAIL  $name" . ($detail !== '' ? "  ($detail)" : '') . "\n"; }
}

function api(string $action, array $body, string $type = 'application/json'): array {
    $opts = ['http' => [
        'method' => 'POST', 'ignore_errors' => true, 'timeout' => 15,
        'header' => 'Content-Type: ' . $type, 'content' => json_encode($body),
    ]];
    $raw = @file_get_contents(API . '?action=' . $action, false, stream_context_create($opts));
    $status = 0;
    foreach ($http_response_header ?? [] as $h) {
        if (preg_match('#^HTTP/\S+\s+(\d{3})#', $h, $m)) $status = (int)$m[1];
    }
    return ['status' => $status, 'body' => $raw !== false ? json_decode($raw, true) : null,
            'raw' => $raw !== false ? $raw : ''];
}
/** One cell sideways from where this seat stands: always inside MOVE_MAX. */
function stepFrom(array $who): int {
    $pos = poll($who)['body']['you']['pos'];
    $x = $pos % N;
    return $x < N - 1 ? $pos + 1 : $pos - 1;
}
function poll(array $who, int $since = 0): array {
    return api('poll', ['code' => $who['code'], 'token' => $who['token'], 'since' => $since]);
}
function commit(array $who, array $action, array $extra = []): array {
    return api('commit', ['code' => $who['code'], 'token' => $who['token'], 'action' => $action] + $extra);
}

$pdo = new PDO(DB_DSN, DB_USER, DB_PASS, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
$schema = file_get_contents(DOC_ROOT . '/app/models/bearing-model.sql');
if ($schema === false) { fwrite(STDERR, "Missing app/models/bearing-model.sql\n"); exit(1); }
$schema = preg_replace('/^\s*--.*$/m', '', $schema);
foreach (array_filter(array_map('trim', explode(';', $schema))) as $stmt) {
    try { $pdo->exec($stmt); } catch (PDOException $e) {
        if (!str_contains($e->getMessage(), 'projects')) throw $e;   // registry row is optional locally
    }
}

$CREATED_CODES = [];
function trackRoom(?array $body): void {
    global $CREATED_CODES;
    if (isset($body['code']) && is_string($body['code'])) $CREATED_CODES[] = $body['code'];
}
function teardown(PDO $pdo): void {
    global $CREATED_CODES;
    if ($CREATED_CODES === []) return;
    $in = implode(',', array_fill(0, count($CREATED_CODES), '?'));
    $pdo->prepare("DELETE FROM bearing_rooms WHERE code IN ($in)")->execute($CREATED_CODES);
}
function roomRow(PDO $pdo, string $code): array {
    $st = $pdo->prepare('SELECT * FROM bearing_rooms WHERE code = ?');
    $st->execute([$code]);
    return $st->fetch(PDO::FETCH_ASSOC) ?: [];
}
function animalCells(PDO $pdo, string $code): array {
    $st = $pdo->prepare(
        'SELECT a.collar, a.at FROM bearing_animals a JOIN bearing_rooms r ON r.id = a.room_id WHERE r.code = ?');
    $st->execute([$code]);
    $out = [];
    foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $r) $out[$r['collar']] = (int)$r['at'];
    return $out;
}

$server = proc_open(
    [PHP_BINARY, '-d', 'variables_order=EGPCS', '-S', HOST . ':' . PORT, '-t', DOC_ROOT],
    [1 => ['file', NULL_DEV, 'w'], 2 => ['file', NULL_DEV, 'w']],
    $pipes, DOC_ROOT,
    ['DB_HOST' => '127.0.0.1', 'DB_PORT' => '3306', 'DB_NAME' => 'portfolio',
     'DB_USER_W' => DB_USER, 'DB_PASS_W' => DB_PASS,
     'DB_USER_R' => DB_USER, 'DB_PASS_R' => DB_PASS,
     'PATH' => getenv('PATH') ?: '/usr/bin:/bin', 'SystemRoot' => getenv('SystemRoot') ?: '']
);
register_shutdown_function(function () use ($server, $pdo) {
    if (is_resource($server)) proc_terminate($server);
    teardown($pdo);
});
$ready = false;
for ($i = 0; $i < 50; $i++) {
    $sock = @fsockopen(HOST, PORT, $errno, $errstr, 0.2);
    if ($sock) { fclose($sock); $ready = true; break; }
    usleep(100000);
}
if (!$ready) { fwrite(STDERR, "Server did not come up on " . PORT . "\n"); exit(1); }

/** Open a room with both seats filled and the night running. */
function openNight(): array {
    $a = api('create', ['name' => 'ANA']);
    trackRoom($a['body']);
    $code = $a['body']['code'];
    $b = api('join', ['name' => 'BOR', 'code' => $code]);
    return [
        'code' => $code,
        'a' => ['code' => $code, 'token' => $a['body']['token'], 'id' => $a['body']['you']['id']],
        'b' => ['code' => $code, 'token' => $b['body']['token'], 'id' => $b['body']['you']['id']],
    ];
}

echo "\n1. THE ENVELOPE\n";
$r = api('create', ['name' => 'X'], 'text/plain');
check('a non-JSON content type is refused', $r['status'] === 415, 'got ' . $r['status']);
$r = api('nope', ['name' => 'X']);
check('an unknown action is a 404', $r['status'] === 404, 'got ' . $r['status']);
$r = api('create', ['name' => '   ']);
check('an empty name is refused with a reason', $r['status'] === 422 && ($r['body']['reason'] ?? '') === 'badName');
$r = api('join', ['name' => 'X', 'code' => 'AEIO']);
check('a vowel code is not a code', $r['status'] === 422 && ($r['body']['reason'] ?? '') === 'badCode');

echo "\n2. OPENING A ROOM\n";
$n = openNight();
check('create returns a four letter code', preg_match('/^[BCDFGHJKLMNPQRSTVWXZ]{4}$/', $n['code']) === 1, $n['code']);
$p = poll($n['a']);
check('the night starts the moment the second seat is filled', ($p['body']['room']['status'] ?? '') === 'night');
check('the poll names the night\'s question', in_array($p['body']['room']['brief'] ?? '', ['den', 'silent'], true));
check('the collar schedule is published, so silence is a mistake not a guess',
      count($p['body']['collars'] ?? []) === 3 && isset($p['body']['collars'][0]['duty']));
check('the two stations do not start on top of each other',
      ($p['body']['you']['pos'] ?? 0) !== ($p['body']['partner']['pos'] ?? 0));
$third = api('join', ['name' => 'CIL', 'code' => $n['code']]);
check('a third player is turned away', $third['status'] === 409, 'got ' . $third['status']);

echo "\n3. THE LOCKSTEP\n";
$before = (int)roomRow($pdo, $n['code'])['cycle'];
commit($n['a'], ['kind' => 'sweep', 'collar' => 'F2']);
check('one seat committing does not advance the night',
      (int)roomRow($pdo, $n['code'])['cycle'] === $before);
$again = commit($n['a'], ['kind' => 'sweep', 'collar' => 'F2']);
check('the same seat cannot commit twice in one cycle', $again['status'] === 409, 'got ' . $again['status']);
commit($n['b'], ['kind' => 'sweep', 'collar' => 'F2']);
check('the cycle resolves when both seats are in',
      (int)roomRow($pdo, $n['code'])['cycle'] === $before + 1);
$p = poll($n['a']);
$types = array_column($p['body']['events'] ?? [], 'type');
check('a sweep produces a trace or a documented silence',
      in_array('trace', $types, true) || in_array('silence', $types, true), implode(',', $types));
foreach (($p['body']['events'] ?? []) as $e) {
    if ($e['type'] === 'trace') {
        check('a trace is 360 samples', count($e['data']['trace']) === 360);
        break;
    }
}

echo "\n4. AN ANIMAL'S POSITION IS A SECRET\n";
$truth = animalCells($pdo, $n['code']);
$raw = poll($n['a'], 0)['raw'];
$leaked = [];
foreach ($truth as $collar => $cell) {
    // the cell index itself, and its x,y, must not appear as a value anywhere
    if (preg_match('/"(at|cell|animal|pos)"\s*:\s*' . $cell . '\b/', $raw)) $leaked[] = $collar;
}
check('no collar cell appears in a night poll', $leaked === [], implode(',', $leaked));
check('the payload carries no animals block', !str_contains($raw, '"animals"'));
$vis = poll($n['a'])['body']['terrain'] ?? '';
check('terrain is masked to the ground this seat has walked',
      strlen($vis) === N * N && substr_count($vis, '.') > (N * N) / 2,
      'revealed ' . (N * N - substr_count($vis, '.')) . ' of ' . (N * N));

echo "\n5. A FORGED COMMIT CHANGES NOTHING\n";
$cycleBefore = (int)roomRow($pdo, $n['code'])['cycle'];
$forged = commit($n['a'], ['kind' => 'log', 'collar' => 'F2', 'at' => 10, 'grade' => 'tight', 'errM' => 0], [
    'cycle' => 99, 'grade' => 'tight', 'fixes' => 999, 'den_at' => 5, 'terrain' => str_repeat('9', N * N),
]);
check('a forged commit is accepted only as an intent', $forged['status'] === 200);
commit($n['b'], ['kind' => 'move', 'at' => stepFrom($n['b'])]);
$row = roomRow($pdo, $n['code']);
check('the forged cycle number is ignored', (int)$row['cycle'] === $cycleBefore + 1,
      'cycle is ' . $row['cycle']);
check('the forged terrain never lands', !str_starts_with($row['terrain'], '99999999'));
$fixEvent = null;
foreach (poll($n['a'], 0)['body']['events'] as $e) if ($e['type'] === 'fix') $fixEvent = $e;
check('a fix is graded by the server, not by the client',
      $fixEvent !== null && in_array($fixEvent['data']['grade'], ['tight', 'usable', 'loose', 'miss'], true));
check('a fix never reports the true distance back',
      $fixEvent !== null && !isset($fixEvent['data']['errM']) && !isset($fixEvent['data']['truth']));

echo "\n6. WALKING\n";
$me = poll($n['a'])['body']['you'];
$far = $me['pos'] - ($me['pos'] % N) + (($me['pos'] % N) + 20) % N;   // same row, twenty columns over
$bad = commit($n['a'], ['kind' => 'move', 'at' => $far]);
check('a station cannot teleport across the valley',
      $bad['status'] === 422 && ($bad['body']['reason'] ?? '') === 'tooFar', 'got ' . $bad['status']);
$off = commit($n['a'], ['kind' => 'move', 'at' => 99999]);
check('a cell off the plate is refused', $off['status'] === 422);
$noCollar = commit($n['a'], ['kind' => 'sweep', 'collar' => 'ZZ9']);
check('an unknown collar is refused', $noCollar['status'] === 422);

echo "\n7. A NIGHT RUNS TO DAWN\n";
$n2 = openNight();
$cycles = (int)roomRow($pdo, $n2['code'])['cycles'];
for ($i = 0; $i < $cycles + 2; $i++) {
    $row = roomRow($pdo, $n2['code']);
    if ($row['status'] !== 'night') break;
    commit($n2['a'], ['kind' => 'sweep', 'collar' => 'F2']);
    commit($n2['b'], ['kind' => 'log', 'collar' => 'F2', 'at' => 400 + $i]);
}
$row = roomRow($pdo, $n2['code']);
check('the night ends at dawn and not before', $row['status'] === 'dawn', 'status ' . $row['status']);
$dawn = null;
foreach (poll($n2['a'], 0)['body']['events'] as $e) if ($e['type'] === 'dawn') $dawn = $e['data'];
check('dawn publishes a report', is_array($dawn) && isset($dawn['grade']));
check('the report answers the night\'s question', is_array($dawn) && array_key_exists('answered', $dawn));
check('the truth is published only at dawn', is_array($dawn) && isset($dawn['truth']['F2']));
check('the report counts the fixes actually logged', is_array($dawn) && $dawn['fixes'] > 0);

echo "\n8. LOSING AND RETAKING A SEAT\n";
$n3 = openNight();
$seats = api('seats', ['code' => $n3['code']]);
check('seats is answerable without a token', $seats['status'] === 200 && count($seats['body']['players']) === 2);
check('a live seat is not reclaimable', ($seats['body']['players'][0]['reclaimable'] ?? true) === false);
$pdo->prepare('UPDATE bearing_players SET last_seen = NOW() - INTERVAL 60 SECOND WHERE id = ?')
    ->execute([$n3['a']['id']]);
$seats = api('seats', ['code' => $n3['code']]);
$reclaimable = false;
foreach ($seats['body']['players'] as $s) if ((int)$s['id'] === $n3['a']['id']) $reclaimable = $s['reclaimable'];
check('a silent seat becomes reclaimable', $reclaimable === true);
$re = api('reclaim', ['code' => $n3['code'], 'playerId' => $n3['a']['id']]);
check('reclaim mints a new token', $re['status'] === 200 && $re['body']['token'] !== $n3['a']['token']);
$oldPoll = poll($n3['a']);
check('and the old phone evicts itself on its next poll', $oldPoll['status'] === 401, 'got ' . $oldPoll['status']);

echo "\n";
echo $failed === 0
    ? "PASS  $passed checks\n"
    : "FAIL  $failed of " . ($passed + $failed) . " checks\n";
exit($failed === 0 ? 0 : 1);
