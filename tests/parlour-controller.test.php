<?php
declare(strict_types=1);

// Integration tests for parlour-controller.php (The Drawing Room: anonymous
// multiplayer rooms with a shared event log).
//
// Runs ONLY against the local scratch DB (127.0.0.1/portfolio): the DB_* env
// overrides below make database.php skip loading app/.env, which points at
// the remote production database. Never run these against prod.
//
// The suite applies app/models/parlour-model.sql to the local DB itself
// (CREATE TABLE IF NOT EXISTS, so it is idempotent) and deletes every room
// it created on shutdown; room rows cascade to guests and events.
//
// Run: /opt/lampp/bin/php tests/parlour-controller.test.php

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
const API      = 'http://' . HOST . ':' . PORT . '/app/controllers/parlour-controller.php';

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
//  HTTP helper: every parlour endpoint is a JSON POST with ?action=
// ------------------------------------------------------------------

/** @return array{status:int, body:mixed} */
function api(string $action, array $body): array
{
    $opts = ['http' => [
        'method'        => 'POST',
        'ignore_errors' => true,
        'timeout'       => 10,
        'header'        => 'Content-Type: application/json',
        'content'       => json_encode($body),
    ]];
    $raw = file_get_contents(API . '?action=' . $action, false, stream_context_create($opts));
    $status = 0;
    foreach ($http_response_header ?? [] as $h) {
        if (preg_match('#^HTTP/\S+\s+(\d{3})#', $h, $m)) {
            $status = (int) $m[1];
        }
    }
    return ['status' => $status, 'body' => $raw !== false ? json_decode($raw, true) : null];
}

// ------------------------------------------------------------------
//  Schema + teardown (rooms cascade to guests and events)
// ------------------------------------------------------------------

$pdo = new PDO(DB_DSN, DB_USER, DB_PASS, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);

$schema = file_get_contents(DOC_ROOT . '/app/models/parlour-model.sql');
if ($schema === false) {
    fwrite(STDERR, "Missing app/models/parlour-model.sql\n");
    exit(1);
}
$schema = preg_replace('/^--.*$/m', '', $schema);
foreach (array_filter(array_map('trim', explode(';', $schema))) as $stmt) {
    $pdo->exec($stmt);
}

/** Room codes created by this run, deleted again on shutdown. */
$CREATED_CODES = [];

function trackRoom(?array $body): void
{
    global $CREATED_CODES;
    if (isset($body['code']) && is_string($body['code'])) {
        $CREATED_CODES[] = $body['code'];
    }
}

function teardown(PDO $pdo): void
{
    global $CREATED_CODES;
    if ($CREATED_CODES === []) {
        return;
    }
    $in = implode(',', array_fill(0, count($CREATED_CODES), '?'));
    $pdo->prepare("DELETE FROM parlour_rooms WHERE code IN ($in)")->execute($CREATED_CODES);
}

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

echo "parlour-controller rooms\n";

// Opening a room seats the creator as host and hands back the secrets
// the client needs: the shareable code and the private guest token.
$res = api('create', ['name' => 'Ada']);
trackRoom($res['body']);
check('create returns 201', $res['status'] === 201, "got {$res['status']}");
$b = $res['body'] ?? [];
check('create returns a 4-letter room code', preg_match('/^[A-Z]{4}$/', $b['code'] ?? '') === 1, json_encode($b['code'] ?? null));
check('create returns a 32-hex guest token', preg_match('/^[a-f0-9]{32}$/', $b['token'] ?? '') === 1, json_encode($b['token'] ?? null));
check('creator is the host', ($b['you']['host'] ?? null) === true);
check('creator got the first ink', ($b['you']['ink'] ?? null) === 0);
check('a fresh room is in the lobby', ($b['room']['status'] ?? null) === 'lobby');

// A second guest joins with the shared code (however they typed it) and
// gets their own secret plus a different ink than the host.
$host = $b;
$res = api('join', ['code' => strtolower($host['code']), 'name' => 'Brunel']);
check('join returns 200', $res['status'] === 200, "got {$res['status']}");
$guest = $res['body'] ?? [];
check('join returns the canonical room code', ($guest['code'] ?? null) === $host['code']);
check('join returns its own 32-hex token', preg_match('/^[a-f0-9]{32}$/', $guest['token'] ?? '') === 1 && ($guest['token'] ?? '') !== $host['token']);
check('joiner is not the host', ($guest['you']['host'] ?? null) === false);
$ink = $guest['you']['ink'] ?? null;
check('joiner gets a different ink than the host', is_int($ink) && $ink !== $host['you']['ink'] && $ink >= 0 && $ink <= 9, json_encode($ink));

$res = api('join', ['code' => 'QQQQ', 'name' => 'Nobody']);
check('join with an unknown code is 404', $res['status'] === 404, "got {$res['status']}");

$res = api('join', ['code' => $host['code'], 'name' => "   \t  "]);
check('join with a blank name is 400', $res['status'] === 400, "got {$res['status']}");

$res = api('join', ['code' => $host['code'], 'name' => str_repeat('long', 6)]);
check('join with an overlong name is 400', $res['status'] === 400, "got {$res['status']}");

// ------------------------------------------------------------------
//  Poll: the one request a client repeats. It authenticates the guest,
//  doubles as the presence heartbeat, and returns the room snapshot plus
//  every event newer than the client's cursor.
// ------------------------------------------------------------------

$res = api('poll', ['code' => $host['code'], 'token' => str_repeat('f', 32), 'since' => 0]);
check('poll with a wrong token is 401', $res['status'] === 401, "got {$res['status']}");

$res = api('poll', ['code' => $host['code'], 'token' => $host['token'], 'since' => 0]);
check('poll returns 200', $res['status'] === 200, "got {$res['status']}");
$p = $res['body'] ?? [];
check('poll echoes who you are', ($p['you']['id'] ?? null) === $host['you']['id'] && ($p['you']['host'] ?? null) === true);
check('poll reports the lobby status', ($p['room']['status'] ?? null) === 'lobby');
check('poll lists both guests in arrival order', array_map(fn ($g) => $g['name'], $p['guests'] ?? []) === ['Ada', 'Brunel'], json_encode($p['guests'] ?? null));
$g0 = ($p['guests'] ?? [])[0] ?? null;
check(
    'guest payload exposes only id/name/ink/host/online',
    $g0 !== null && array_keys($g0) === ['id', 'name', 'ink', 'host', 'online'],
    $g0 !== null ? implode(',', array_keys($g0)) : 'guest missing'
);
check('a quiet room has no events and cursor stays put', ($p['events'] ?? null) === [] && ($p['last'] ?? null) === 0 && ($p['more'] ?? null) === false);

// Polling IS the heartbeat: a guest whose client stopped polling drops
// offline, and comes back online the moment they poll again.
$pdo->prepare('UPDATE parlour_guests SET last_seen = NOW() - INTERVAL 60 SECOND
               WHERE token_hash = ?')->execute([hash('sha256', $guest['token'])]);
$res = api('poll', ['code' => $host['code'], 'token' => $host['token'], 'since' => 0]);
$brunel = array_values(array_filter($res['body']['guests'] ?? [], fn ($g) => $g['name'] === 'Brunel'))[0] ?? null;
check('a silent guest shows as offline', $brunel !== null && $brunel['online'] === false, json_encode($brunel));

api('poll', ['code' => $host['code'], 'token' => $guest['token'], 'since' => 0]);
$res = api('poll', ['code' => $host['code'], 'token' => $host['token'], 'since' => 0]);
$brunel = array_values(array_filter($res['body']['guests'] ?? [], fn ($g) => $g['name'] === 'Brunel'))[0] ?? null;
check('polling again brings the guest back online', $brunel !== null && $brunel['online'] === true, json_encode($brunel));

// A guest silent for 15+ minutes is swept out of the room entirely by the
// next poll, and their token stops working.
$pdo->prepare('UPDATE parlour_guests SET last_seen = NOW() - INTERVAL 16 MINUTE
               WHERE token_hash = ?')->execute([hash('sha256', $guest['token'])]);
$res = api('poll', ['code' => $host['code'], 'token' => $host['token'], 'since' => 0]);
check('a long-silent guest is swept from the room', array_map(fn ($g) => $g['name'], $res['body']['guests'] ?? []) === ['Ada'], json_encode($res['body']['guests'] ?? null));
$res = api('poll', ['code' => $host['code'], 'token' => $guest['token'], 'since' => 0]);
check('a swept guest token is 401', $res['status'] === 401, "got {$res['status']}");

// They can simply join again with the same code.
$res = api('join', ['code' => $host['code'], 'name' => 'Brunel']);
check('a swept guest can rejoin', $res['status'] === 200, "got {$res['status']}");
$guest = $res['body'];

// ------------------------------------------------------------------
//  The bell: one host click moves every client from the lobby to the
//  canvas. It is just an event like any other, which is the whole point
//  of the design: new game actions are new event types.
// ------------------------------------------------------------------

$res = api('event', ['code' => $host['code'], 'token' => $guest['token'], 'type' => 'start']);
check('a guest cannot ring the bell', $res['status'] === 403, "got {$res['status']}");

$res = api('event', ['code' => $host['code'], 'token' => $host['token'], 'type' => 'start']);
check('the host rings the bell', $res['status'] === 200, "got {$res['status']}");
check('the bell returns its event seq', is_int($res['body']['seq'] ?? null) && $res['body']['seq'] > 0, json_encode($res['body']));

$res = api('poll', ['code' => $host['code'], 'token' => $guest['token'], 'since' => 0]);
check('every guest now sees the room live', ($res['body']['room']['status'] ?? null) === 'live');
$types = array_map(fn ($e) => $e['type'], $res['body']['events'] ?? []);
check('the start event reached the other guest', $types === ['start'], json_encode($types));
check('poll cursor advanced to the start event', ($res['body']['last'] ?? 0) > 0);
$cursor = $res['body']['last'];

$res = api('event', ['code' => $host['code'], 'token' => $host['token'], 'type' => 'start']);
check('ringing twice is 409', $res['status'] === 409, "got {$res['status']}");

// ------------------------------------------------------------------
//  Strokes: chunked while the pen is down (sid ties chunks together),
//  validated hard on the way in, and readable by everyone via poll.
// ------------------------------------------------------------------

$hostSid = $host['you']['id'] . '.1';
$res = api('event', ['code' => $host['code'], 'token' => $host['token'], 'type' => 'stroke',
                     'data' => ['sid' => $hostSid, 'ink' => 3, 'size' => 6, 'pts' => [100, 100, 220, 180, 340, 260]]]);
check('a stroke chunk is accepted', $res['status'] === 200, "got {$res['status']} " . json_encode($res['body']));

$res = api('poll', ['code' => $host['code'], 'token' => $guest['token'], 'since' => $cursor]);
$ev = ($res['body']['events'] ?? [])[0] ?? null;
check('the other guest receives the stroke', $ev !== null && $ev['type'] === 'stroke' && $ev['guest'] === $host['you']['id']);
check('stroke data survives the round trip', $ev !== null && $ev['data']['sid'] === $hostSid && $ev['data']['ink'] === 3
    && $ev['data']['size'] === 6 && $ev['data']['pts'] === [100, 100, 220, 180, 340, 260], json_encode($ev['data'] ?? null));
check('an unfinished stroke carries no end flag', $ev !== null && !array_key_exists('end', $ev['data']));
$cursor = $res['body']['last'];

$res = api('event', ['code' => $host['code'], 'token' => $host['token'], 'type' => 'stroke',
                     'data' => ['sid' => $hostSid, 'ink' => 3, 'size' => 6, 'pts' => [340, 260, 500, 400], 'end' => true]]);
check('a continuation chunk is accepted', $res['status'] === 200, "got {$res['status']}");
$res = api('poll', ['code' => $host['code'], 'token' => $guest['token'], 'since' => $cursor]);
$evs = $res['body']['events'] ?? [];
check('polling from the cursor returns only the new chunk', count($evs) === 1 && $evs[0]['data']['sid'] === $hostSid && $evs[0]['data']['end'] === true, json_encode($evs));
$cursor = $res['body']['last'];

// The server clamps coordinates into the shared 1500x1000 sheet and
// rounds them to integers, whatever the client sends.
$res = api('event', ['code' => $host['code'], 'token' => $host['token'], 'type' => 'stroke',
                     'data' => ['sid' => $host['you']['id'] . '.2', 'ink' => 0, 'size' => 12, 'pts' => [-50, 99999, 200.4, 300.6]]]);
check('an out-of-bounds stroke is accepted', $res['status'] === 200, "got {$res['status']}");
$res = api('poll', ['code' => $host['code'], 'token' => $guest['token'], 'since' => $cursor]);
$ev = ($res['body']['events'] ?? [])[0] ?? null;
check('coordinates come back clamped to the sheet', $ev !== null && $ev['data']['pts'] === [0, 1000, 200, 301], json_encode($ev['data']['pts'] ?? null));
$cursor = $res['body']['last'];

// A single tap is a legal one-point stroke, and the eraser is ink -1.
$res = api('event', ['code' => $host['code'], 'token' => $guest['token'], 'type' => 'stroke',
                     'data' => ['sid' => $guest['you']['id'] . '.1', 'ink' => -1, 'size' => 24, 'pts' => [700, 500], 'end' => true]]);
check('an eraser dot is accepted', $res['status'] === 200, "got {$res['status']}");

// Nobody can append to someone else's stroke: the sid must carry the
// sender's own guest id.
$res = api('event', ['code' => $host['code'], 'token' => $guest['token'], 'type' => 'stroke',
                     'data' => ['sid' => $host['you']['id'] . '.9', 'ink' => 2, 'size' => 6, 'pts' => [1, 1, 2, 2]]]);
check('a spoofed stroke id is rejected', $res['status'] === 400, "got {$res['status']}");

foreach ([
    'odd point count'   => ['sid' => $guest['you']['id'] . '.2', 'ink' => 2, 'size' => 6, 'pts' => [1, 2, 3]],
    'unknown ink'       => ['sid' => $guest['you']['id'] . '.2', 'ink' => 99, 'size' => 6, 'pts' => [1, 2]],
    'stringly ink'      => ['sid' => $guest['you']['id'] . '.2', 'ink' => '3', 'size' => 6, 'pts' => [1, 2]],
    'nib too fine'      => ['sid' => $guest['you']['id'] . '.2', 'ink' => 2, 'size' => 1, 'pts' => [1, 2]],
    'non-numeric point' => ['sid' => $guest['you']['id'] . '.2', 'ink' => 2, 'size' => 6, 'pts' => ['a', 'b']],
    'garbage sid'       => ['sid' => 'abc', 'ink' => 2, 'size' => 6, 'pts' => [1, 2]],
    'too many points'   => ['sid' => $guest['you']['id'] . '.2', 'ink' => 2, 'size' => 6, 'pts' => array_fill(0, 1202, 1)],
] as $label => $data) {
    $res = api('event', ['code' => $host['code'], 'token' => $guest['token'], 'type' => 'stroke', 'data' => $data]);
    check("malformed stroke ($label) is 400", $res['status'] === 400, "got {$res['status']}");
}
$res = api('event', ['code' => $host['code'], 'token' => $guest['token'], 'type' => 'stroke']);
check('a stroke without data is 400', $res['status'] === 400, "got {$res['status']}");

// Drawing before the bell: strokes only exist on a live canvas.
$res = api('create', ['name' => 'Early Bird']);
trackRoom($res['body']);
$early = $res['body'];
$res = api('event', ['code' => $early['code'], 'token' => $early['token'], 'type' => 'stroke',
                     'data' => ['sid' => $early['you']['id'] . '.1', 'ink' => 0, 'size' => 6, 'pts' => [1, 2]]]);
check('drawing in the lobby is 409', $res['status'] === 409, "got {$res['status']}");

// ------------------------------------------------------------------
//  Fresh sheet: host-only, and it compacts the log so late joiners
//  never replay strokes that no canvas shows anymore.
// ------------------------------------------------------------------

$res = api('event', ['code' => $host['code'], 'token' => $guest['token'], 'type' => 'clear']);
check('a guest cannot fetch a fresh sheet', $res['status'] === 403, "got {$res['status']}");

$res = api('event', ['code' => $host['code'], 'token' => $host['token'], 'type' => 'clear']);
check('the host clears the sheet', $res['status'] === 200, "got {$res['status']}");

$res = api('poll', ['code' => $host['code'], 'token' => $guest['token'], 'since' => 0]);
$types = array_map(fn ($e) => $e['type'], $res['body']['events'] ?? []);
check('cleared strokes are compacted out of the replay', $types === ['start', 'clear'], json_encode($types));

$res = api('event', ['code' => $host['code'], 'token' => $guest['token'], 'type' => 'stroke',
                     'data' => ['sid' => $guest['you']['id'] . '.3', 'ink' => 5, 'size' => 6, 'pts' => [10, 10, 20, 20], 'end' => true]]);
check('drawing continues after a clear', $res['status'] === 200, "got {$res['status']}");
$res = api('poll', ['code' => $host['code'], 'token' => $host['token'], 'since' => 0]);
$types = array_map(fn ($e) => $e['type'], $res['body']['events'] ?? []);
check('replay after clear is start, clear, then new strokes', $types === ['start', 'clear', 'stroke'], json_encode($types));

// ------------------------------------------------------------------
//  Capacity, stepping out, and the janitor.
// ------------------------------------------------------------------

// The Early Bird lobby holds 1 guest; the room seats 12 active guests.
$tokens = [];
for ($i = 2; $i <= 12; $i++) {
    $res = api('join', ['code' => $early['code'], 'name' => "Guest $i"]);
    $tokens[$i] = $res['body']['token'] ?? '';
    if ($res['status'] !== 200) {
        break;
    }
}
check('a room seats 12 guests', $res['status'] === 200, "join #12 got {$res['status']}");
$res = api('join', ['code' => $early['code'], 'name' => 'Guest 13']);
check('the 13th guest is turned away', $res['status'] === 409, "got {$res['status']}");

// Stepping out frees the seat and kills the token.
$res = api('leave', ['code' => $early['code'], 'token' => $tokens[12]]);
check('a guest can step out', $res['status'] === 200, "got {$res['status']}");
$res = api('poll', ['code' => $early['code'], 'token' => $tokens[12], 'since' => 0]);
check('a departed token is 401', $res['status'] === 401, "got {$res['status']}");
$res = api('poll', ['code' => $early['code'], 'token' => $early['token'], 'since' => 0]);
check('the departed guest left the snapshot', !in_array('Guest 12', array_map(fn ($g) => $g['name'], $res['body']['guests'] ?? []), true));
$res = api('join', ['code' => $early['code'], 'name' => 'Guest 13']);
check('the freed seat can be taken', $res['status'] === 200, "got {$res['status']}");

// Rooms idle for 12+ hours are purged whenever someone opens a new room;
// rows cascade so guests and events go with them.
$pdo->prepare('UPDATE parlour_rooms SET last_active = NOW() - INTERVAL 13 HOUR
               WHERE code = ?')->execute([$early['code']]);
$res = api('create', ['name' => 'Janitor']);
trackRoom($res['body']);
check('opening a room runs the janitor', $res['status'] === 201, "got {$res['status']}");
$res = api('poll', ['code' => $early['code'], 'token' => $early['token'], 'since' => 0]);
check('an idle room is gone', $res['status'] === 404, "got {$res['status']}");
$res = api('poll', ['code' => $host['code'], 'token' => $host['token'], 'since' => 0]);
check('a lively room survives the janitor', $res['status'] === 200, "got {$res['status']}");

// ------------------------------------------------------------------

echo "\n$passed passed, $failed failed\n";
exit($failed === 0 ? 0 : 1);
