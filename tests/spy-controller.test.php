<?php
declare(strict_types=1);

// Integration tests for spy-controller.php (the Spy game's room mode:
// anonymous multiplayer rooms with a shared event log and SECRET roles).
//
// Runs ONLY against the local scratch DB (127.0.0.1/portfolio): the DB_* env
// overrides below make database.php skip loading app/.env, which points at
// the remote production database. Never run these against prod.
//
// The suite applies app/models/spy-model.sql to the local DB itself
// (CREATE TABLE IF NOT EXISTS, so it is idempotent) and deletes every room
// it created on shutdown; room rows cascade to players and events.
//
// The first block of cases is the important one: a role and the location are
// secrets, and the whole gamemode is pointless if a spy's payload contains
// the location anywhere, or if any player can read another's role.
//
// Run: C:\xampp\php\php.exe tests/spy-controller.test.php
//      /opt/lampp/bin/php tests/spy-controller.test.php

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit('CLI only');
}

const DB_DSN   = 'mysql:host=127.0.0.1;port=3306;dbname=portfolio;charset=utf8mb4';
const DB_USER  = 'portfolio_dev';
const DB_PASS  = 'R2miswz1pNKOxdl4';
const DOC_ROOT = __DIR__ . '/..';
const HOST     = '127.0.0.1';
const PORT     = 8933;
const API      = 'http://' . HOST . ':' . PORT . '/app/controllers/spy-controller.php';

// Spawn whatever interpreter is running this suite, and pick the null device
// for this platform, so the suite runs under XAMPP on Windows and on Linux.
define('NULL_DEV', PHP_OS_FAMILY === 'Windows' ? 'NUL' : '/dev/null');

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
//  HTTP helper: every endpoint is a JSON POST with ?action=
// ------------------------------------------------------------------

/** @return array{status:int, body:mixed, raw:string} */
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
    return [
        'status' => $status,
        'body'   => $raw !== false ? json_decode($raw, true) : null,
        'raw'    => $raw !== false ? $raw : '',
    ];
}

/** Shorthand: post a game event as one player. */
function event(array $who, string $type, ?array $data = null): array
{
    $payload = ['code' => $who['code'], 'token' => $who['token'], 'type' => $type];
    if ($data !== null) {
        $payload['data'] = $data;
    }
    return api('event', $payload);
}

function poll(array $who, int $since = 0): array
{
    return api('poll', ['code' => $who['code'], 'token' => $who['token'], 'since' => $since]);
}

// ------------------------------------------------------------------
//  Schema + teardown (rooms cascade to players and events)
// ------------------------------------------------------------------

$pdo = new PDO(DB_DSN, DB_USER, DB_PASS, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);

$schema = file_get_contents(DOC_ROOT . '/app/models/spy-model.sql');
if ($schema === false) {
    fwrite(STDERR, "Missing app/models/spy-model.sql\n");
    exit(1);
}
// Strip comments before splitting on ';': an indented comment containing a
// semicolon would otherwise cut a CREATE TABLE in half.
$schema = preg_replace('/^\s*--.*$/m', '', $schema);
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
    $pdo->prepare("DELETE FROM spy_rooms WHERE code IN ($in)")->execute($CREATED_CODES);
}

/** Time travel: the suite never sleeps, it backdates rows instead. */
function backdate(PDO $pdo, string $sql, array $args): void
{
    $pdo->prepare($sql)->execute($args);
}

/**
 * The last ballot arms a grace countdown rather than closing the vote, so a
 * player who votes last can still change their mind. Nothing in a test wants
 * to sit through it: drag the deadline into the past and poll, which is the
 * path a real phone takes when it expires.
 */
function runOutGrace(PDO $pdo, array $player): array
{
    backdate($pdo, "UPDATE spy_rooms SET round_ends_at = NOW() - INTERVAL 1 SECOND WHERE code = ?",
        [$player['code']]);
    return poll($player)['body'];
}

// ------------------------------------------------------------------
//  Server lifecycle
// ------------------------------------------------------------------

$server = proc_open(
    [PHP_BINARY, '-d', 'variables_order=EGPCS', '-S', HOST . ':' . PORT, '-t', DOC_ROOT],
    [1 => ['file', NULL_DEV, 'w'], 2 => ['file', NULL_DEV, 'w']],
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
        'SystemRoot' => getenv('SystemRoot') ?: '',
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
    usleep(100000);
}
if (!$ready) {
    fwrite(STDERR, "Test server did not start on " . HOST . ':' . PORT . "\n");
    exit(1);
}

/** Opens a room and returns the host session. */
function openRoom(string $name = 'HOST'): array
{
    $res = api('create', ['name' => $name]);
    trackRoom($res['body']);
    return [
        'code'  => $res['body']['code'],
        'token' => $res['body']['token'],
        'id'    => $res['body']['you']['id'],
        'res'   => $res,
    ];
}

/** Seats another player in an existing room. */
function seat(string $code, string $name): array
{
    $res = api('join', ['code' => $code, 'name' => $name]);
    return [
        'code'  => $code,
        'token' => $res['body']['token'] ?? '',
        'id'    => $res['body']['you']['id'] ?? 0,
        'res'   => $res,
    ];
}

echo "\n== Spy controller ==\n";

// ------------------------------------------------------------------
//  1. Opening and joining a room
// ------------------------------------------------------------------

$host = openRoom('ANA');
check('create returns 201 with a code and a token', $host['res']['status'] === 201
    && preg_match('/^[BCDFGHJKLMNPQRSTVWXZ]{4}$/', $host['code']) === 1
    && preg_match('/^[a-f0-9]{32}$/', $host['res']['body']['token']) === 1,
    'status ' . $host['res']['status']);
check('the opener is the host and has no role yet',
    $host['res']['body']['you']['host'] === true
    && $host['res']['body']['you']['role'] === null
    && $host['res']['body']['room']['status'] === 'lobby');

$marko = seat($host['code'], 'MARKO');
check('join seats a second player, not as host',
    $marko['res']['status'] === 200 && $marko['res']['body']['you']['host'] === false);

$jakaJoin = api('join', ['code' => ' ' . strtolower($host['code']) . ' ', 'name' => 'JAKA']);
check('room codes are case and space insensitive', $jakaJoin['status'] === 200);
$jaka = [
    'code'  => $host['code'],
    'token' => $jakaJoin['body']['token'] ?? '',
    'id'    => $jakaJoin['body']['you']['id'] ?? 0,
];

check('a duplicate name is refused',
    api('join', ['code' => $host['code'], 'name' => 'ana'])['status'] === 409);

check('an unknown code is a 404, same as a malformed one',
    api('join', ['code' => 'ZZZZ', 'name' => 'NOBODY'])['status'] === 404
    && api('join', ['code' => '!!', 'name' => 'NOBODY'])['status'] === 404);

check('a blank name is refused',
    api('create', ['name' => '   '])['status'] === 400
    && api('create', ['name' => str_repeat('x', 21)])['status'] === 400);

// ------------------------------------------------------------------
//  2. The deal, and who is allowed to run it
// ------------------------------------------------------------------

check('only the host may deal', event($marko, 'deal')['status'] === 403);

$solo = openRoom('LONE');
seat($solo['code'], 'PAIR');
check('a deal needs three players', event($solo, 'deal')['status'] === 409);

$deal = event($host, 'deal');
check('the host deals and the room moves to the briefing', $deal['status'] === 200);

$hostPoll = poll($host);
check('the deal moves every phone to brief',
    $hostPoll['body']['room']['status'] === 'brief');
check('the deal event says how big the game is, never who or where',
    ($hostPoll['body']['events'][0]['data']['players'] ?? null) === 3
    && ($hostPoll['body']['events'][0]['data']['spies'] ?? null) === 1
    && !str_contains(json_encode($hostPoll['body']['events']), 'location'));

// ------------------------------------------------------------------
//  3. SECRECY. The reason this controller exists.
// ------------------------------------------------------------------

// Poll as all three seated players and sort their payloads by role.
$everyone = [$host, $marko, $jaka];
$rows = [];
foreach ($everyone as $who) {
    $body = poll($who)['body'];
    $rows[] = ['who' => $who, 'body' => $body, 'raw' => json_encode($body)];
}

$spies    = array_values(array_filter($rows, fn ($r) => $r['body']['you']['role'] === 'spy'));
$citizens = array_values(array_filter($rows, fn ($r) => $r['body']['you']['role'] === 'citizen'));

check('every player was dealt a role', count($spies) + count($citizens) === count($rows));
check('a citizen is told the location',
    count($citizens) === 0 || is_string($citizens[0]['body']['you']['location']));

$location = $citizens[0]['body']['you']['location'] ?? null;

check('THE LOCATION NEVER APPEARS ANYWHERE IN A SPY PAYLOAD',
    count($spies) === 0 || ($spies[0]['body']['you']['location'] === null
        && $location !== null && !str_contains($spies[0]['raw'], $location)),
    'spy payload leaked the location');

check('the player list carries no role at all',
    !array_key_exists('role', $rows[0]['body']['players'][0])
    && !str_contains(json_encode($rows[0]['body']['players']), 'spy')
    && !str_contains(json_encode($rows[0]['body']['players']), 'citizen'));

check('no dossier is offered before the debrief',
    !array_key_exists('reveal', $rows[0]['body']));

// ------------------------------------------------------------------
//  4. The briefing and the start
// ------------------------------------------------------------------

check('a player marks their own card memorized', event($marko, 'ready')['status'] === 200);
$tally = poll($host)['body'];
$readyCount = count(array_filter($tally['players'], fn ($p) => $p['ready']));
check('the ready tally is public, the roles behind it are not', $readyCount === 1);

check('only the host may start the round', event($marko, 'start')['status'] === 403);
check('the host starts the round', event($host, 'start')['status'] === 200);

$live = poll($host)['body'];
check('the room is live with a clock running',
    $live['room']['status'] === 'round'
    && $live['room']['paused'] === false
    && $live['room']['secondsLeft'] > 0
    && $live['room']['secondsLeft'] <= $live['room']['roundSeconds']);
check('starting twice is refused', event($host, 'start')['status'] === 409);
check('joining a running game is refused, and says a seat can be reclaimed',
    api('join', ['code' => $host['code'], 'name' => 'LATE'])['status'] === 409
    && api('join', ['code' => $host['code'], 'name' => 'LATE'])['body']['reclaim'] === true);

// ------------------------------------------------------------------
//  5. Pausing the shared clock
// ------------------------------------------------------------------

check('only the host may pause', event($marko, 'pause')['status'] === 403);
check('the host pauses', event($host, 'pause')['status'] === 200);

$paused = poll($host)['body'];
check('a paused clock reports paused and holds its seconds',
    $paused['room']['paused'] === true && $paused['room']['secondsLeft'] > 0);
$frozen = $paused['room']['secondsLeft'];
check('a paused clock does not drift', poll($host)['body']['room']['secondsLeft'] === $frozen);
check('pausing twice is refused', event($host, 'pause')['status'] === 409);
check('the host resumes', event($host, 'resume')['status'] === 200);

$resumed = poll($host)['body'];
check('resuming restores what was left, give or take a second',
    $resumed['room']['paused'] === false && abs($resumed['room']['secondsLeft'] - $frozen) <= 2,
    "was $frozen, now " . $resumed['room']['secondsLeft']);
check('resuming twice is refused', event($host, 'resume')['status'] === 409);

// ------------------------------------------------------------------
//  6. The ballot
// ------------------------------------------------------------------

$spyId      = $spies[0]['who']['id'];
$innocentId = $citizens[0]['who']['id'];
// The deal is random, so pick voters by role rather than by name: a player
// may not accuse themselves, and the spy is whoever the shuffle chose.
$notSpy = array_values(array_filter([$host, $marko, $jaka], fn ($w) => $w['id'] !== $spyId));
$voterA = $notSpy[0];
$voterB = $notSpy[1];

check('only the host may end the round', event($marko, 'end')['status'] === 403);
check('the host ends the round', event($host, 'end')['status'] === 200);

$open = poll($marko)['body'];
check('ending questioning opens the ballot rather than the debrief',
    $open['room']['status'] === 'vote' && $open['room']['secondsLeft'] === null);
check('no dossier is offered while the ballot is open',
    !array_key_exists('reveal', $open));
check('nobody has voted yet',
    $open['room']['ballots'] === 0
    && count(array_filter($open['players'], fn ($p) => $p['voted'])) === 0);

check('a ballot for somebody outside the room is refused',
    event($voterA, 'castvote', ['target' => 99999999])['status'] === 400);
check('accusing yourself is refused',
    event($voterA, 'castvote', ['target' => $voterA['id']])['status'] === 400);
check('a ballot must name a whole number',
    event($voterA, 'castvote', ['target' => 'x'])['status'] === 400);

check('a player casts a ballot', event($voterA, 'castvote', ['target' => $spyId])['status'] === 200);

$mid = poll($voterB)['body'];
check('the room learns that a ballot exists',
    $mid['room']['ballots'] === 1
    && count(array_filter($mid['players'], fn ($p) => $p['voted'])) === 1);
check('THE BALLOT ITSELF IS SECRET UNTIL THE VOTE CLOSES',
    !str_contains(json_encode($mid['players']), 'votedFor')
    && $mid['you']['votedFor'] === null
    && !array_key_exists('reveal', $mid),
    'a ballot leaked before the vote closed');
check('a voter can see their own ballot and nobody else can',
    poll($voterA)['body']['you']['votedFor'] === $spyId);

// The log is the thing the design is actually protecting: it is handed to
// every player in the room, so a ballot must not be recoverable from it.
$logged = $pdo->query(
    "SELECT COALESCE(GROUP_CONCAT(COALESCE(e.data, 'NULL')), '')
     FROM spy_events e JOIN spy_rooms r ON r.id = e.room_id
     WHERE r.code = '{$host['code']}' AND e.type IN ('castvote', 'callvote')"
)->fetchColumn();
check('NO BALLOT IS EVER WRITTEN INTO THE PUBLIC EVENT LOG',
    $logged !== '' && !str_contains($logged, 'target') && !str_contains((string) $logged, (string) $spyId),
    "log carried: $logged");
check('the room is still in the vote while a ballot is missing',
    $mid['room']['status'] === 'vote');
check('no countdown runs while a ballot is still outstanding',
    $mid['room']['graceLeft'] === null);

// Changing your mind. A ballot is an answer, not a commitment: it stays
// changeable right up to the moment the vote closes, and the room counts the
// LAST one. This is the whole reason the vote closes on a countdown rather
// than on whoever happens to tap last.
// Somebody voterA is allowed to accuse, and who is not their first pick.
$switchTo = (int) array_values(array_filter(
    [$host['id'], $marko['id'], $jaka['id']],
    fn ($id) => $id !== $spyId && $id !== $voterA['id']
))[0];
check('a voter may change their ballot',
    event($voterA, 'castvote', ['target' => $switchTo])['status'] === 200);
check('the change replaces the first ballot rather than adding a second',
    poll($voterA)['body']['you']['votedFor'] === $switchTo);
check('changing a ballot does not add a second voter to the room',
    poll($voterB)['body']['room']['ballots'] === 1);
// Put it back, so the verdict section below still has its clear plurality.
event($voterA, 'castvote', ['target' => $spyId]);

// ------------------------------------------------------------------
//  7. The verdict
// ------------------------------------------------------------------

// Everyone accuses the spy, except the spy, who has to accuse somebody
// else. That leaves the spy with a clear plurality.
foreach ([$host, $marko, $jaka] as $who) {
    $target = $who['id'] === $spyId ? $innocentId : $spyId;
    event($who, 'castvote', ['target' => $target]);
}

// The last ballot no longer slams the vote shut. It arms a countdown, which
// is the only reason the player who happens to vote last can change their
// mind at all.
$armed = poll($marko)['body'];
check('the last ballot arms the grace countdown instead of closing the vote',
    $armed['room']['status'] === 'vote'
    && $armed['room']['graceLeft'] !== null
    && $armed['room']['graceLeft'] <= 10,
    'graceLeft: ' . json_encode($armed['room']['graceLeft']));

$done = runOutGrace($pdo, $marko);
check('the countdown running out closes the vote', $done['room']['status'] === 'debrief');
check('a closed vote carries no countdown', $done['room']['graceLeft'] === null);
check('the dossier now names the spies and the location',
    isset($done['reveal']['location'])
    && $done['reveal']['location'] === $location
    && count($done['reveal']['spies']) === 1
    && (int) $done['reveal']['spies'][0]['id'] === $spyId);
check('catching the spy is a win for the agents',
    $done['reveal']['outcome'] === 'agents'
    && (int) ($done['reveal']['accused']['id'] ?? 0) === $spyId);
check('the ballots are readable at last, and add up',
    array_sum(array_column($done['reveal']['tally'], 'votes')) === 3);
check('the dossier is the same for everyone, spy or not',
    json_encode(poll($host)['body']['reveal']) === json_encode($done['reveal']));

// ------------------------------------------------------------------
//  8. Playing again, and going back to the lobby
// ------------------------------------------------------------------

$again = event($host, 'deal');
check('the host can deal a fresh round straight from the debrief', $again['status'] === 200);
$fresh = poll($host)['body'];
check('a fresh deal clears every memorized card',
    $fresh['room']['status'] === 'brief'
    && count(array_filter($fresh['players'], fn ($p) => $p['ready'])) === 0);

event($host, 'start');
event($host, 'end');
// Every seated player has to vote before the room reaches a debrief again.
foreach ([$host, $marko, $jaka] as $who) {
    $others = array_values(array_filter([$host['id'], $marko['id'], $jaka['id']],
        fn ($id) => $id !== $who['id']));
    event($who, 'castvote', ['target' => $others[0]]);
}
runOutGrace($pdo, $marko);
check('back to the lobby is host only', event($marko, 'again')['status'] === 403);
check('the host reopens the lobby', event($host, 'again')['status'] === 200);

$lobby = poll($marko)['body'];
check('the lobby shreds the dossier and every role',
    $lobby['room']['status'] === 'lobby'
    && $lobby['you']['role'] === null
    && $lobby['you']['location'] === null
    && !array_key_exists('reveal', $lobby));

// ------------------------------------------------------------------
//  9. Settings
// ------------------------------------------------------------------

check('only the host changes the settings',
    event($marko, 'settings', ['spies' => 1, 'roundSeconds' => 300])['status'] === 403);
check('settings must be whole numbers',
    event($host, 'settings', ['spies' => '1', 'roundSeconds' => 300])['status'] === 400);

event($host, 'settings', ['spies' => 9, 'roundSeconds' => 99999]);
$clamped = poll($host)['body']['room'];
check('the server clamps spies to half the table and the clock to its bounds',
    $clamped['spies'] === 1 && $clamped['roundSeconds'] === 1800,
    "spies {$clamped['spies']}, seconds {$clamped['roundSeconds']}");

event($host, 'settings', ['spies' => 1, 'roundSeconds' => 60]);
check('the clock can be set as low as a minute',
    poll($host)['body']['room']['roundSeconds'] === 60);

event($host, 'deal');
check('settings are locked once roles are dealt',
    event($host, 'settings', ['spies' => 1, 'roundSeconds' => 300])['status'] === 409);

// ------------------------------------------------------------------
//  10. The clock running out, with nobody pressing anything
// ------------------------------------------------------------------

event($host, 'start');
$before = (int) $pdo->query(
    "SELECT COUNT(*) FROM spy_events e JOIN spy_rooms r ON r.id = e.room_id
     WHERE r.code = '{$host['code']}' AND e.type = 'end'"
)->fetchColumn();

backdate($pdo, 'UPDATE spy_rooms SET round_ends_at = NOW() - INTERVAL 5 SECOND WHERE code = ?', [$host['code']]);

// Three phones poll on the same expired clock; only one may write the edge.
$a = poll($host)['body'];
$b = poll($marko)['body'];
$c = poll($jaka)['body'];

check('an expired clock opens the ballot for everyone',
    $a['room']['status'] === 'vote'
    && $b['room']['status'] === 'vote'
    && $c['room']['status'] === 'vote');

$after = (int) $pdo->query(
    "SELECT COUNT(*) FROM spy_events e JOIN spy_rooms r ON r.id = e.room_id
     WHERE r.code = '{$host['code']}' AND e.type = 'end'"
)->fetchColumn();
check('simultaneous pollers append exactly one end event', $after - $before === 1,
    'appended ' . ($after - $before));

// ------------------------------------------------------------------
//  11. Presence, and the host walking away
// ------------------------------------------------------------------

$hostRoom = openRoom('CHIEF');
$second   = seat($hostRoom['code'], 'SECOND');
$third    = seat($hostRoom['code'], 'THIRD');
// A fourth seat, so the room still has enough players to deal once the host
// is swept away below.
$fourth   = seat($hostRoom['code'], 'FOURTH');

check('everyone is online while they poll',
    count(array_filter(poll($second)['body']['players'], fn ($p) => $p['online'])) === 4);

backdate($pdo, 'UPDATE spy_players SET last_seen = NOW() - INTERVAL 60 SECOND WHERE id = ?', [$third['id']]);
$quiet = poll($second)['body'];
$thirdRow = array_values(array_filter($quiet['players'], fn ($p) => $p['id'] === $third['id']))[0];
check('a phone that stopped polling shows as away', $thirdRow['online'] === false);

// The host goes quiet for longer than the sweep tolerates.
backdate($pdo, 'UPDATE spy_players SET last_seen = NOW() - INTERVAL 16 MINUTE WHERE id = ?', [$hostRoom['id']]);
$swept = poll($second)['body'];

check('a long-silent player loses their seat',
    !in_array($hostRoom['id'], array_column($swept['players'], 'id'), true));
check('their token dies with the seat', poll($hostRoom)['status'] === 401);
check('the longest-seated player inherits the room', $swept['you']['host'] === true
    && $swept['you']['id'] === $second['id']);
check('the handover is announced in the log',
    count(array_filter($swept['events'], fn ($e) => $e['type'] === 'host')) === 1);
check('the new host can actually run the game', event($second, 'deal')['status'] === 200);

// ------------------------------------------------------------------
//  12. Reclaiming a seat
// ------------------------------------------------------------------

$seats = api('seats', ['code' => $hostRoom['code']]);
check('the seat list is readable without a token, and shows no roles',
    $seats['status'] === 200
    && !str_contains($seats['raw'], 'role')
    && !str_contains($seats['raw'], 'location'));

check('a seat still in play cannot be taken', api('reclaim', [
    'code' => $hostRoom['code'], 'playerId' => $second['id'],
])['status'] === 409);

backdate($pdo, 'UPDATE spy_players SET last_seen = NOW() - INTERVAL 60 SECOND WHERE id = ?', [$third['id']]);
$listed = api('seats', ['code' => $hostRoom['code']])['body']['players'];
$thirdSeat = array_values(array_filter($listed, fn ($p) => $p['id'] === $third['id']))[0];
check('a quiet seat is offered back', $thirdSeat['reclaimable'] === true);

// Read the role straight from the table: polling as that player would bump
// last_seen and make the seat live again, which is exactly what the idle
// guard is there to prevent.
$roleBefore = $pdo->query("SELECT role FROM spy_players WHERE id = {$third['id']}")->fetchColumn();
$taken = api('reclaim', ['code' => $hostRoom['code'], 'playerId' => $third['id']]);
check('reclaiming hands back the same seat with its role intact',
    $taken['status'] === 200
    && $taken['body']['you']['id'] === $third['id']
    && $taken['body']['you']['role'] === $roleBefore);
check('reclaiming mints a new token', $taken['body']['token'] !== $third['token']);
check('the old token is dead, so a returning device knows it was replaced',
    poll($third)['status'] === 401);

$thirdAgain = ['code' => $hostRoom['code'], 'token' => $taken['body']['token'], 'id' => $third['id']];
check('the reclaimed seat polls normally', poll($thirdAgain)['status'] === 200);
check('reclaiming a seat that never existed is a 404',
    api('reclaim', ['code' => $hostRoom['code'], 'playerId' => 99999999])['status'] === 404);

// ------------------------------------------------------------------
//  13. Capacity, leaving, and the request envelope
// ------------------------------------------------------------------

$big = openRoom('SEAT1');
for ($i = 2; $i <= 20; $i++) {
    seat($big['code'], 'SEAT' . $i);
}
check('a room seats twenty', count(poll($big)['body']['players']) === 20);
check('the twenty-first is turned away',
    api('join', ['code' => $big['code'], 'name' => 'SEAT21'])['status'] === 409);

// A room of its own: hostRoom has roles dealt by now, and its door is shut.
$doorRoom = openRoom('DOORMAN');
$leaver   = seat($doorRoom['code'], 'PASSING');
check('leaving frees the seat and kills the token',
    api('leave', ['code' => $leaver['code'], 'token' => $leaver['token']])['status'] === 200
    && poll($leaver)['status'] === 401
    && count(poll($doorRoom)['body']['players']) === 1);

check('GET is refused', (function () {
    $ctx = stream_context_create(['http' => ['method' => 'GET', 'ignore_errors' => true, 'timeout' => 10]]);
    @file_get_contents(API . '?action=poll', false, $ctx);
    foreach ($http_response_header ?? [] as $h) {
        if (preg_match('#^HTTP/\S+\s+(\d{3})#', $h, $m)) {
            return (int) $m[1] === 405;
        }
    }
    return false;
})());

check('a form content type is refused, which is the CSRF backstop', (function () {
    $ctx = stream_context_create(['http' => [
        'method' => 'POST', 'ignore_errors' => true, 'timeout' => 10,
        'header' => 'Content-Type: application/x-www-form-urlencoded',
        'content' => 'name=x',
    ]]);
    @file_get_contents(API . '?action=create', false, $ctx);
    foreach ($http_response_header ?? [] as $h) {
        if (preg_match('#^HTTP/\S+\s+(\d{3})#', $h, $m)) {
            return (int) $m[1] === 415;
        }
    }
    return false;
})());

check('an unknown action is a 400', api('nonsense', [])['status'] === 400);
check('an unknown event type is a 400', event($big, 'sabotage')['status'] === 400);
check('a bad token is a 401',
    api('poll', ['code' => $big['code'], 'token' => str_repeat('f', 32), 'since' => 0])['status'] === 401);

// ------------------------------------------------------------------
//  14. Calling the vote, and a table that cannot agree
// ------------------------------------------------------------------

$vr = openRoom('CALLER');
$v2 = seat($vr['code'], 'SECONDER');
$v3 = seat($vr['code'], 'HOLDOUT');
event($vr, 'deal');
event($vr, 'start');

check('calling a vote outside a round is refused',
    event($v2, 'castvote', ['target' => $vr['id']])['status'] === 409);

check('anybody may call the vote, not only the host',
    event($v3, 'callvote')['status'] === 200);
$called = poll($v2)['body'];
check('the call is public, and says how many are needed',
    $called['room']['endVotes'] === 1
    && $called['room']['endVotesNeeded'] === 2
    && count(array_filter($called['players'], fn ($p) => $p['wantsEnd'])) === 1);
check('the round keeps running short of a majority', $called['room']['status'] === 'round');

check('a caller may change their mind', event($v3, 'callvote')['status'] === 200);
check('retracting drops the tally again', poll($v2)['body']['room']['endVotes'] === 0);

event($v3, 'callvote');
event($v2, 'callvote');
$carried = poll($vr)['body'];
check('a majority carries the call and opens the ballot',
    $carried['room']['status'] === 'vote' && $carried['room']['secondsLeft'] === null);
check('the call appends exactly one end event',
    count(array_filter($carried['events'], fn ($e) => $e['type'] === 'end')) === 1);

// Everyone accuses somebody different, so nobody has a plurality.
event($vr, 'castvote', ['target' => $v2['id']]);
event($v2, 'castvote', ['target' => $v3['id']]);
event($v3, 'castvote', ['target' => $vr['id']]);

// The countdown is armed, but it is not a deadline anyone is locked out by:
// a ballot arriving while it runs puts the full grace period back, so the
// table cannot be rushed by whoever tapped last.
$armedAt = poll($vr)['body']['room']['graceLeft'];
check('the full table arms the countdown', $armedAt !== null);
backdate($pdo, "UPDATE spy_rooms SET round_ends_at = NOW() + INTERVAL 2 SECOND WHERE code = ?",
    [$vr['code']]);
check('the countdown is running down', poll($vr)['body']['room']['graceLeft'] <= 2);
event($v3, 'castvote', ['target' => $v2['id']]);
check('changing a ballot restarts the countdown',
    poll($vr)['body']['room']['graceLeft'] > 2,
    'a late switch has to buy the table its time back');
// Put the tie back before letting it expire.
event($v3, 'castvote', ['target' => $vr['id']]);
runOutGrace($pdo, $vr);

$tied = poll($v2)['body'];
check('a table that cannot agree still reaches a verdict',
    $tied['room']['status'] === 'debrief');
check('a tie names nobody and hands the win to the spies',
    $tied['reveal']['accused'] === null && $tied['reveal']['outcome'] === 'spies');
check('the tally still shows every ballot that was cast',
    count($tied['reveal']['tally']) === 3
    && array_sum(array_column($tied['reveal']['tally'], 'votes')) === 3);

// The host can close a vote early rather than waiting on a missing phone.
event($vr, 'deal');
event($vr, 'start');
event($vr, 'end');
check('only the host may close the vote early', event($v2, 'closevote')['status'] === 403);
event($v2, 'castvote', ['target' => $vr['id']]);
check('the host closes the vote with ballots still missing',
    event($vr, 'closevote')['status'] === 200);
$early = poll($v3)['body'];
check('an early close still counts what was cast',
    $early['room']['status'] === 'debrief'
    && (int) ($early['reveal']['accused']['id'] ?? 0) === $vr['id']);
check('closing a vote that is not open is refused', event($vr, 'closevote')['status'] === 409);

// The host's button is also the escape hatch for a table that keeps switching
// its pick and so keeps pushing the countdown back. It must beat the clock,
// not wait for it.
$cr = openRoom('IMPATIENT');
$c2 = seat($cr['code'], 'DITHERER');
$c3 = seat($cr['code'], 'ALSO DITHERING');
event($cr, 'deal');
event($cr, 'start');
event($cr, 'end');
event($cr, 'castvote', ['target' => $c2['id']]);
event($c2, 'castvote', ['target' => $c3['id']]);
event($c3, 'castvote', ['target' => $c2['id']]);
check('the countdown is running before the host steps in',
    poll($cr)['body']['room']['graceLeft'] !== null);
check('the host closes the vote without waiting for the countdown',
    event($cr, 'closevote')['status'] === 200);
$cut = poll($c2)['body'];
check('an early close still settles the verdict it had',
    $cut['room']['status'] === 'debrief'
    && (int) ($cut['reveal']['accused']['id'] ?? 0) === $c2['id']
    && array_sum(array_column($cut['reveal']['tally'], 'votes')) === 3);

// ------------------------------------------------------------------
//  15. The vote has no clock, so leaving has to be able to end it
// ------------------------------------------------------------------

$lr = openRoom('STAYER');
$l2 = seat($lr['code'], 'ALSO STAYING');
$l3 = seat($lr['code'], 'WALKS OUT');
event($lr, 'deal');
event($lr, 'start');
event($lr, 'end');

event($lr, 'castvote', ['target' => $l2['id']]);
event($l2, 'castvote', ['target' => $lr['id']]);
check('the room waits while a ballot is outstanding',
    poll($lr)['body']['room']['status'] === 'vote');

// The missing voter walks out. Nobody taps anything afterwards.
api('leave', ['code' => $l3['code'], 'token' => $l3['token']]);
check('the last voter leaving arms the countdown on the poll path',
    poll($lr)['body']['room']['graceLeft'] !== null,
    'nobody taps anything here, so only the poll can notice');
check('and the countdown then closes the vote by itself',
    runOutGrace($pdo, $lr)['room']['status'] === 'debrief',
    'a room with no clock and no actor would hang here');
check('the verdict is settled, not left blank',
    poll($lr)['body']['reveal']['outcome'] !== null);

// The same thing, but the phone simply goes quiet and gets swept.
$sr = openRoom('SWEPT HOST');
$s2 = seat($sr['code'], 'PRESENT');
$s3 = seat($sr['code'], 'VANISHES');
event($sr, 'deal');
event($sr, 'start');
event($sr, 'end');
event($sr, 'castvote', ['target' => $s2['id']]);
event($s2, 'castvote', ['target' => $sr['id']]);
backdate($pdo, 'UPDATE spy_players SET last_seen = NOW() - INTERVAL 16 MINUTE WHERE id = ?', [$s3['id']]);
poll($sr); // the sweep and the arming both happen on the poll path
check('a swept voter also releases the vote',
    runOutGrace($pdo, $sr)['room']['status'] === 'debrief');

// A verdict must never be readable before it has been decided.
$rows = $pdo->query(
    "SELECT COUNT(*) FROM spy_rooms WHERE status = 'debrief' AND outcome IS NULL"
)->fetchColumn();
check('no room is ever in debrief without an outcome', (int) $rows === 0,
    "$rows rooms are in debrief with no verdict");

// Closing with nothing cast at all: the table simply never voted.
$er = openRoom('EMPTY BALLOT');
$e2 = seat($er['code'], 'SILENT ONE');
$e3 = seat($er['code'], 'SILENT TWO');
event($er, 'deal');
event($er, 'start');
event($er, 'end');
check('the host can close a vote nobody took part in',
    event($er, 'closevote')['status'] === 200);
$empty = poll($e2)['body'];
check('no ballots means nobody is accused and the spies walk',
    $empty['room']['status'] === 'debrief'
    && $empty['reveal']['accused'] === null
    && $empty['reveal']['outcome'] === 'spies'
    && $empty['reveal']['tally'] === []);

// ------------------------------------------------------------------
//  16. The language a room plays in
// ------------------------------------------------------------------

$locTable = json_decode(file_get_contents(DOC_ROOT . '/views/spy/i18n/locations.json'), true);
$slNames  = array_column($locTable['locations'], 'sl');
$enNames  = array_column($locTable['locations'], 'en');

$slRoom = api('create', ['name' => 'GOSTITELJ', 'lang' => 'sl']);
trackRoom($slRoom['body']);
$sl = ['code' => $slRoom['body']['code'], 'token' => $slRoom['body']['token'], 'id' => $slRoom['body']['you']['id']];
check('the room remembers the language it was opened in',
    $slRoom['body']['room']['lang'] === 'sl');

$slB = seat($sl['code'], 'IGRALEC B');
$slC = seat($sl['code'], 'IGRALEC C');
check('a joiner is handed the room language rather than asked for one',
    $slB['res']['body']['room']['lang'] === 'sl');

event($sl, 'deal');
$slPolls = array_map(fn ($who) => poll($who)['body'], [$sl, $slB, $slC]);
$slCitizens = array_values(array_filter($slPolls, fn ($b) => $b['you']['role'] === 'citizen'));
$slPlace = $slCitizens[0]['you']['location'];
check('a Slovenian room deals a location from the Slovenian column',
    in_array($slPlace, $slNames, true), 'got ' . $slPlace);
check('the poll keeps telling every phone which language the room plays in',
    $slPolls[0]['room']['lang'] === 'sl' && $slPolls[2]['room']['lang'] === 'sl');
// The same key read in the other language: proof the column is what moved,
// not just that some string came back.
$slRow = array_values(array_filter($locTable['locations'], fn ($r) => $r['sl'] === $slPlace))[0];
check('that location has an English name of its own in the same row',
    isset($slRow['en']) && $slRow['en'] !== '' && in_array($slRow['en'], $enNames, true));
check('the location still never reaches the spy in any language',
    (function () use ($slPolls, $slPlace) {
        foreach ($slPolls as $b) {
            if ($b['you']['role'] === 'spy'
                && ($b['you']['location'] !== null || str_contains(json_encode($b), $slPlace))) {
                return false;
            }
        }
        return true;
    })());

$bad = api('create', ['name' => 'NOBODY', 'lang' => 'klingon']);
trackRoom($bad['body']);
check('an unknown language quietly becomes English', $bad['body']['room']['lang'] === 'en');

// ------------------------------------------------------------------
//  17. The janitor
// ------------------------------------------------------------------

$stale = openRoom('GHOST');
backdate($pdo, 'UPDATE spy_rooms SET last_active = NOW() - INTERVAL 7 HOUR WHERE code = ?', [$stale['code']]);
openRoom('JANITOR'); // creating a room is what pays for the sweep
check('a room idle past its welcome is purged on the next create',
    poll($stale)['status'] === 404);

// ------------------------------------------------------------------
//  Result
// ------------------------------------------------------------------

echo "\n$passed passed, $failed failed\n";
exit($failed === 0 ? 0 : 1);
