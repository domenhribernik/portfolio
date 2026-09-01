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

// CREATE TABLE IF NOT EXISTS cannot upgrade a scratch DB that still carries an
// older spy schema, so bring it forward here the way the seed does in
// production. Idempotent, and it keeps the suite runnable on a pre-rework
// database instead of failing with a column nobody can see is missing.
function columnExists(PDO $pdo, string $table, string $column): bool
{
    $stmt = $pdo->prepare(
        'SELECT 1 FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?'
    );
    $stmt->execute([$table, $column]);
    return $stmt->fetchColumn() !== false;
}

foreach ([
    ['spy_rooms', 'used_location_keys', 'ALTER TABLE spy_rooms ADD COLUMN used_location_keys TEXT DEFAULT NULL AFTER location_key'],
    ['spy_rooms', 'accused_ids',        'ALTER TABLE spy_rooms ADD COLUMN accused_ids VARCHAR(255) DEFAULT NULL AFTER paused_seconds'],
    ['spy_rooms', 'revealed',           'ALTER TABLE spy_rooms ADD COLUMN revealed TINYINT NOT NULL DEFAULT 0 AFTER outcome'],
] as [$table, $column, $ddl]) {
    if (!columnExists($pdo, $table, $column)) {
        $pdo->exec($ddl);
    }
}
if (columnExists($pdo, 'spy_rooms', 'accused_id')) {
    $pdo->exec('ALTER TABLE spy_rooms DROP COLUMN accused_id');
}
if (columnExists($pdo, 'spy_players', 'voted_for')) {
    $pdo->exec('ALTER TABLE spy_players DROP COLUMN voted_for');
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

/**
 * One ballot: as many names as there are spies in play. The ids are sent in
 * pick order, which is the order the phone drops the oldest from.
 */
function castBallot(array $who, array $targets): array
{
    return event($who, 'castvote', ['targets' => array_values($targets)]);
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

/**
 * The grace period the controller actually compiles in. Read rather than
 * hard-coded so tuning the constant cannot quietly loosen the assertions that
 * are supposed to bound it.
 */
function graceSeconds(): int
{
    $php = file_get_contents(DOC_ROOT . '/app/controllers/spy-controller.php');
    if (!preg_match('/^const\s+VOTE_GRACE_SECONDS\s*=\s*(\d+)\s*;/m', (string) $php, $m)) {
        fwrite(STDERR, "spy-controller.php no longer declares VOTE_GRACE_SECONDS\n");
        exit(1);
    }
    return (int) $m[1];
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

check('one spy in play means a ballot of one name', $open['room']['picks'] === 1);
check('there is nothing to declassify while the ballot is still open',
    event($host, 'reveal', ['outcome' => 'agents'])['status'] === 409);

check('a ballot for somebody outside the room is refused',
    castBallot($voterA, [99999999])['status'] === 400);
check('accusing yourself is refused',
    castBallot($voterA, [$voterA['id']])['status'] === 400);
check('a ballot must name whole numbers',
    castBallot($voterA, ['x'])['status'] === 400);
check('a ballot cannot name more people than there are spies',
    castBallot($voterA, [$spyId, $innocentId])['status'] === 400);
check('a ballot cannot name the same person twice',
    event($voterA, 'castvote', ['targets' => [$spyId, $spyId]])['status'] === 400);

check('a player casts a ballot', castBallot($voterA, [$spyId])['status'] === 200);

$mid = poll($voterB)['body'];
check('the room learns that a ballot exists',
    $mid['room']['ballots'] === 1
    && count(array_filter($mid['players'], fn ($p) => $p['voted'])) === 1);
check('THE BALLOT ITSELF IS SECRET UNTIL THE VOTE CLOSES',
    !str_contains(json_encode($mid['players']), 'ballot')
    && $mid['you']['ballot'] === []
    && !array_key_exists('reveal', $mid),
    'a ballot leaked before the vote closed');
check('a voter can see their own ballot and nobody else can',
    poll($voterA)['body']['you']['ballot'] === [$spyId]);

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
    castBallot($voterA, [$switchTo])['status'] === 200);
check('the change replaces the first ballot rather than adding a second',
    poll($voterA)['body']['you']['ballot'] === [$switchTo]);
check('changing a ballot does not add a second voter to the room',
    poll($voterB)['body']['room']['ballots'] === 1);
check('a ballot can be taken back entirely',
    castBallot($voterA, [])['status'] === 200
    && poll($voterA)['body']['room']['ballots'] === 0);
// Put it back, so the verdict section below still has its clear plurality.
castBallot($voterA, [$spyId]);

// ------------------------------------------------------------------
//  7. The verdict
// ------------------------------------------------------------------

// Everyone accuses the spy, except the spy, who has to accuse somebody
// else. That leaves the spy with a clear plurality.
foreach ([$host, $marko, $jaka] as $who) {
    $target = $who['id'] === $spyId ? $innocentId : $spyId;
    castBallot($who, [$target]);
}

// The last ballot no longer slams the vote shut. It arms a countdown, which
// is the only reason the player who happens to vote last can change their
// mind at all.
$armed = poll($marko)['body'];
check('the last ballot arms the grace countdown instead of closing the vote',
    $armed['room']['status'] === 'vote'
    && $armed['room']['graceLeft'] !== null
    && $armed['room']['graceLeft'] > 0
    && $armed['room']['graceLeft'] <= graceSeconds(),
    'graceLeft: ' . json_encode($armed['room']['graceLeft']) . ', grace is ' . graceSeconds() . 's');

$done = runOutGrace($pdo, $marko);
check('the countdown running out closes the vote', $done['room']['status'] === 'debrief');
check('a closed vote carries no countdown', $done['room']['graceLeft'] === null);

// Half one of the debrief: what the table decided, public at once, because it
// is what the accused has to answer for.
check('the ballots are readable at last, and add up',
    array_sum(array_column($done['ballot']['tally'], 'votes')) === 3);
check('the accused is the most voted, and there are as many as there are spies',
    count($done['ballot']['accused']) === 1
    && (int) $done['ballot']['accused'][0]['id'] === $spyId
    && $done['ballot']['wanted'] === 1);

// Half two waits for the host. This is the whole point of the phase: the
// accused gets to defend themselves, and a phone quietly showing the answer
// is what cut that short.
check('NO DOSSIER IS OFFERED BEFORE THE HOST CALLS THE ROUND',
    !array_key_exists('reveal', $done) && $done['room']['revealed'] === false);
$spyStillBlind = poll($spies[0]['who'])['raw'];
check('THE LOCATION IS STILL SECRET IN AN UNCALLED DEBRIEF',
    !str_contains($spyStillBlind, $location),
    'the location leaked into an uncalled debrief');

// The same rule, on the two paths that hand a player their own card. A
// citizen has known the place all round and has no screen left that shows it,
// so withholding it costs them nothing. What it buys is the reclaim door
// below: the debrief is when phones go down and seats go quiet.
check('a citizen is not handed the location back in an uncalled debrief',
    poll($citizens[0]['who'])['body']['you']['location'] === null);

// A seat goes reclaimable after twenty quiet seconds, and reclaiming hands
// back that seat's card. In an uncalled debrief that used to include the
// location, so a spy could take a quiet citizen's seat, read the place, and
// "guess" it out loud to steal a round they had already lost.
backdate($pdo, 'UPDATE spy_players SET last_seen = NOW() - INTERVAL 60 SECOND WHERE id = ?',
    [$jaka['id']]);
$graveRobber = api('reclaim', ['code' => $host['code'], 'playerId' => $jaka['id']]);
check('RECLAIMING A SEAT IN AN UNCALLED DEBRIEF READS NO LOCATION',
    $graveRobber['status'] === 200
    && $graveRobber['body']['you']['location'] === null
    && !str_contains($graveRobber['raw'], $location),
    'reclaim handed out the location the host had not revealed yet');
// Reclaiming mints a new token, so the handle has to follow it.
$jaka = ['code' => $host['code'], 'token' => $graveRobber['body']['token'], 'id' => $jaka['id']];

check('only the host may call the round',
    event($marko, 'reveal', ['outcome' => 'agents'])['status'] === 403);
check('the call has to name one side or the other',
    event($host, 'reveal', ['outcome' => 'nobody'])['status'] === 400);
check('a call with no outcome at all is refused',
    event($host, 'reveal')['status'] === 400);
check('the host calls it for the agents',
    event($host, 'reveal', ['outcome' => 'agents'])['status'] === 200);

$called = poll($marko)['body'];
check('calling the round declassifies the dossier for everyone',
    $called['room']['revealed'] === true
    && isset($called['reveal']['location'])
    && $called['reveal']['location'] === $location
    && count($called['reveal']['spies']) === 1
    && (int) $called['reveal']['spies'][0]['id'] === $spyId);
check('the verdict is the one the host called, not one the ballot computed',
    $called['reveal']['outcome'] === 'agents');
check('the dossier is the same for everyone, spy or not',
    json_encode(poll($host)['body']['reveal']) === json_encode($called['reveal']));
check('the call is announced in the log, so every phone reveals together',
    count(array_filter($called['events'], fn ($e) => $e['type'] === 'reveal')) === 1);

// The host hears the defence before they call it, so calling it wrong is a
// live possibility and must not need a whole new round to fix.
check('the host can correct a call they got wrong',
    event($host, 'reveal', ['outcome' => 'spies'])['status'] === 200
    && poll($marko)['body']['reveal']['outcome'] === 'spies');
event($host, 'reveal', ['outcome' => 'agents']);

// ------------------------------------------------------------------
//  8. Playing again, and going back to the lobby
// ------------------------------------------------------------------

$again = event($host, 'deal');
check('the host can deal a fresh round straight from the debrief', $again['status'] === 200);
$fresh = poll($host)['body'];
check('a fresh deal clears every memorized card',
    $fresh['room']['status'] === 'brief'
    && count(array_filter($fresh['players'], fn ($p) => $p['ready'])) === 0);
check('a fresh deal shreds the last round entirely',
    !array_key_exists('reveal', $fresh)
    && !array_key_exists('ballot', $fresh)
    && $fresh['room']['revealed'] === false
    && $fresh['room']['ballots'] === 0);

event($host, 'start');
event($host, 'end');
// Every seated player has to vote before the room reaches a debrief again.
foreach ([$host, $marko, $jaka] as $who) {
    $others = array_values(array_filter([$host['id'], $marko['id'], $jaka['id']],
        fn ($id) => $id !== $who['id']));
    castBallot($who, [$others[0]]);
}
runOutGrace($pdo, $marko);
check('back to the lobby is host only', event($marko, 'again')['status'] === 403);
check('the host reopens the lobby', event($host, 'again')['status'] === 200);

$lobby = poll($marko)['body'];
check('the lobby shreds the dossier and every role',
    $lobby['room']['status'] === 'lobby'
    && $lobby['you']['role'] === null
    && $lobby['you']['location'] === null
    && $lobby['you']['ballot'] === []
    && $lobby['room']['revealed'] === false
    && !array_key_exists('reveal', $lobby));
check('no ballot outlives the round it was cast in',
    (int) $pdo->query(
        "SELECT COUNT(*) FROM spy_ballots b JOIN spy_rooms r ON r.id = b.room_id
         WHERE r.code = '{$host['code']}'"
    )->fetchColumn() === 0);

// ------------------------------------------------------------------
//  8b. Two spies: a ballot of two names, and the top TWO rule
// ------------------------------------------------------------------
//
// The rule the whole phase turns on: with n spies in play the agents win only
// by putting every one of them in the top n. Catching one of two means the
// other walked, and that is a win for the spies. A table that cannot separate
// its top n (a tie across the line) has not named them either.

$twoRoom = openRoom('DIRECTOR');
$two2 = seat($twoRoom['code'], 'TWO2');
$two3 = seat($twoRoom['code'], 'TWO3');
$two4 = seat($twoRoom['code'], 'TWO4');
$twoAll = [$twoRoom, $two2, $two3, $two4];

event($twoRoom, 'settings', ['spies' => 2, 'roundSeconds' => 60]);
check('four players may hunt two spies', poll($twoRoom)['body']['room']['spies'] === 2);

event($twoRoom, 'deal');
$twoRoles = [];
foreach ($twoAll as $who) {
    $twoRoles[$who['id']] = poll($who)['body']['you']['role'];
}
$twoSpies = array_values(array_keys(array_filter($twoRoles, fn ($r) => $r === 'spy')));
$twoCits  = array_values(array_keys(array_filter($twoRoles, fn ($r) => $r === 'citizen')));
check('a two spy deal marks exactly two of the four', count($twoSpies) === 2);

event($twoRoom, 'start');
event($twoRoom, 'end');

$twoOpen = poll($two2)['body'];
check('two spies in play means a ballot of two names', $twoOpen['room']['picks'] === 2);

$byId = [];
foreach ($twoAll as $who) {
    $byId[$who['id']] = $who;
}
// These next few are about the mechanics of a two name ballot, not about
// roles, so they are cast by a KNOWN seat with targets picked by id. The deal
// is random: reaching for "the first citizen" here can land on the host, and
// the reclaim below would then invalidate the handle every host-only event
// after this point uses.
$mechanic = $two4;
$notMe    = array_values(array_filter(array_column($twoAll, 'id'), fn ($id) => $id !== $mechanic['id']));

check('a half filled ballot is not a cast one',
    castBallot($mechanic, [$notMe[0]])['status'] === 200
    && poll($two2)['body']['room']['ballots'] === 0,
    'a one name ballot counted as complete while two were wanted');
check('a full ballot counts',
    castBallot($mechanic, [$notMe[0], $notMe[1]])['status'] === 200
    && poll($two2)['body']['room']['ballots'] === 1);
check('a voter sees their own two names, in the order they picked them',
    poll($mechanic)['body']['you']['ballot'] === [$notMe[0], $notMe[1]]);

// A phone that dropped out mid-ballot and took its seat back has to find the
// names it had already picked. It keeps its role, so keeping its ballot is the
// same promise: it is the same seat.
backdate($pdo, 'UPDATE spy_players SET last_seen = NOW() - INTERVAL 60 SECOND WHERE id = ?',
    [$mechanic['id']]);
$backAgain = api('reclaim', ['code' => $twoRoom['code'], 'playerId' => $mechanic['id']]);
check('a seat taken back mid-vote comes with the ballot it had cast',
    $backAgain['status'] === 200
    && $backAgain['body']['you']['ballot'] === [$notMe[0], $notMe[1]],
    'got ' . json_encode($backAgain['body']['you']['ballot'] ?? null));
// Reclaiming mints a new token and kills the old one, so every handle on that
// seat has to follow it.
$two4 = ['code' => $twoRoom['code'], 'token' => $backAgain['body']['token'], 'id' => $mechanic['id']];
$byId[$two4['id']] = $two4;
check('and the room still counts it as one ballot, not two',
    poll($two2)['body']['room']['ballots'] === 1);

// Now the real vote. Both citizens name both spies; each spy names the other
// spy and a citizen, which they have to do to fill a ballot they cannot put
// themselves on. That leaves the two spies clear of everyone else.
castBallot($byId[$twoCits[0]], [$twoSpies[0], $twoSpies[1]]);
castBallot($byId[$twoCits[1]], [$twoSpies[0], $twoSpies[1]]);
castBallot($byId[$twoSpies[0]], [$twoSpies[1], $twoCits[0]]);
castBallot($byId[$twoSpies[1]], [$twoSpies[0], $twoCits[0]]);

$twoDone = runOutGrace($pdo, $two2);
check('every seat holding two names closes the vote', $twoDone['room']['status'] === 'debrief');
check('THE TOP TWO ARE BOTH ACCUSED WHEN TWO SPIES ARE IN PLAY',
    count($twoDone['ballot']['accused']) === 2
    && $twoDone['ballot']['wanted'] === 2
    && in_array($twoSpies[0], array_column($twoDone['ballot']['accused'], 'id'), true)
    && in_array($twoSpies[1], array_column($twoDone['ballot']['accused'], 'id'), true),
    'accused: ' . json_encode($twoDone['ballot']['accused']));
check('eight ballots are counted, two from each of the four',
    array_sum(array_column($twoDone['ballot']['tally'], 'votes')) === 8);

event($twoRoom, 'reveal', ['outcome' => 'agents']);
check('the dossier names both spies once the host calls it',
    count(poll($two2)['body']['reveal']['spies']) === 2);

// Now the case the rule exists for: one spy in the top two and one who got
// away. The table cannot separate second place from third, so second place is
// not accused at all, and the accused list comes back SHORT of the two spies.
event($twoRoom, 'deal');
event($twoRoom, 'start');
event($twoRoom, 'end');

$ids = array_column($twoAll, 'id');
// P1 takes three votes, P2 and P3 take two each: the cut line falls inside a
// tie, so only P1 is named.
castBallot($byId[$ids[0]], [$ids[1], $ids[2]]);
castBallot($byId[$ids[1]], [$ids[0], $ids[2]]);
castBallot($byId[$ids[2]], [$ids[0], $ids[3]]);
castBallot($byId[$ids[3]], [$ids[0], $ids[1]]);

$tied = runOutGrace($pdo, $two2);
$tiedTally = [];
foreach ($tied['ballot']['tally'] as $row) {
    $tiedTally[(int) $row['id']] = (int) $row['votes'];
}
check('the tally is what the ballots said',
    $tiedTally[$ids[0]] === 3 && $tiedTally[$ids[1]] === 2
    && $tiedTally[$ids[2]] === 2 && $tiedTally[$ids[3]] === 1,
    json_encode($tiedTally));
check('A TIE ACROSS THE CUT LINE NAMES NOBODY BELOW IT',
    count($tied['ballot']['accused']) === 1
    && (int) $tied['ballot']['accused'][0]['id'] === $ids[0],
    'accused: ' . json_encode($tied['ballot']['accused']));

// ------------------------------------------------------------------
//  8c. A room never plays the same location twice
// ------------------------------------------------------------------
//
// The deck belongs to the room and outlives its rounds. A party that gets the
// supermarket twice in an evening has been handed a rerun, which is exactly
// what the testers reported.

$deckRoom = openRoom('QUARTER');
seat($deckRoom['code'], 'DECK2');
seat($deckRoom['code'], 'DECK3');

$deckSize = count(json_decode(
    (string) file_get_contents(DOC_ROOT . '/views/spy/i18n/locations.json'), true
)['locations']);

/** Deals again from wherever the room is, and reports the place it drew. */
$dealAgain = function () use ($pdo, $deckRoom) {
    $pdo->prepare("UPDATE spy_rooms SET status = 'lobby' WHERE code = ?")->execute([$deckRoom['code']]);
    event($deckRoom, 'deal');
    return (string) $pdo->query(
        "SELECT location_key FROM spy_rooms WHERE code = '{$deckRoom['code']}'"
    )->fetchColumn();
};

$drawn = [];
for ($i = 0; $i < $deckSize; $i++) {
    $drawn[] = $dealAgain();
}
check('A ROOM NEVER DEALS THE SAME LOCATION TWICE',
    count(array_unique($drawn)) === $deckSize,
    'drew ' . count(array_unique($drawn)) . ' distinct places in ' . $deckSize . ' deals');
check('a full deck is exactly the places the table knows about',
    count(array_diff($drawn, array_column(json_decode(
        (string) file_get_contents(DOC_ROOT . '/views/spy/i18n/locations.json'), true
    )['locations'], 'key'))) === 0);

// One more than the deck holds. It has to answer with something rather than
// dead-end, and not with the place the table has just walked out of.
$wrapped = $dealAgain();
check('an exhausted deck reshuffles instead of running out', $wrapped !== '');
check('the reshuffle never lands straight back on the last place',
    $wrapped !== $drawn[$deckSize - 1],
    "wrapped onto $wrapped, which was the round before");
check('the deck starts over rather than growing forever',
    $pdo->query("SELECT used_location_keys FROM spy_rooms WHERE code = '{$deckRoom['code']}'")
        ->fetchColumn() === $wrapped);

// A trip back to the lobby is not a new party, so the deck survives it.
$pdo->prepare("UPDATE spy_rooms SET status = 'debrief' WHERE code = ?")->execute([$deckRoom['code']]);
event($deckRoom, 'again');
check('going back to the lobby keeps the deck the room has played',
    $pdo->query("SELECT used_location_keys FROM spy_rooms WHERE code = '{$deckRoom['code']}'")
        ->fetchColumn() === $wrapped);

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
    castBallot($v2, [$vr['id']])['status'] === 409);

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
castBallot($vr, [$v2['id']]);
castBallot($v2, [$v3['id']]);
castBallot($v3, [$vr['id']]);

// The countdown is armed, but it is not a deadline anyone is locked out by:
// a ballot arriving while it runs puts the full grace period back, so the
// table cannot be rushed by whoever tapped last.
$armedAt = poll($vr)['body']['room']['graceLeft'];
check('the full table arms the countdown', $armedAt !== null);
backdate($pdo, "UPDATE spy_rooms SET round_ends_at = NOW() + INTERVAL 2 SECOND WHERE code = ?",
    [$vr['code']]);
$ticking = poll($vr)['body']['room']['graceLeft'];
check('the countdown is running down', $ticking !== null && $ticking <= 2,
    'null <= 2 is true in PHP, so the null check has to be explicit');
castBallot($v3, [$v2['id']]);
check('changing a ballot restarts the countdown',
    poll($vr)['body']['room']['graceLeft'] > 2,
    'a late switch has to buy the table its time back');
// Put the tie back before letting it expire.
castBallot($v3, [$vr['id']]);
runOutGrace($pdo, $vr);

$tied = poll($v2)['body'];
check('a table that cannot agree still reaches a verdict',
    $tied['room']['status'] === 'debrief');
check('a three way tie names nobody at all',
    $tied['ballot']['accused'] === []);
check('the tally still shows every ballot that was cast',
    count($tied['ballot']['tally']) === 3
    && array_sum(array_column($tied['ballot']['tally'], 'votes')) === 3);
check('a debrief nobody has called carries no verdict either',
    !array_key_exists('reveal', $tied) && $tied['room']['revealed'] === false);

// The host can close a vote early rather than waiting on a missing phone.
event($vr, 'deal');
event($vr, 'start');
event($vr, 'end');
check('only the host may close the vote early', event($v2, 'closevote')['status'] === 403);
castBallot($v2, [$vr['id']]);
check('the host closes the vote with ballots still missing',
    event($vr, 'closevote')['status'] === 200);
$early = poll($v3)['body'];
check('an early close still counts what was cast',
    $early['room']['status'] === 'debrief'
    && (int) ($early['ballot']['accused'][0]['id'] ?? 0) === $vr['id']);
check('closing a vote that is not open is refused', event($vr, 'closevote')['status'] === 409);

// A tap that arrives after the countdown has already run out is too late. It
// must neither land nor push the deadline back, or "closes ten seconds after
// the last tap" would really mean "ten seconds after the last tap AND a poll".
$lr2 = openRoom('LATE ONE');
$lb = seat($lr2['code'], 'LATE TWO');
$lc = seat($lr2['code'], 'LATE THREE');
event($lr2, 'deal');
event($lr2, 'start');
event($lr2, 'end');
castBallot($lr2, [$lb['id']]);
castBallot($lb, [$lc['id']]);
castBallot($lc, [$lb['id']]);
backdate($pdo, "UPDATE spy_rooms SET round_ends_at = NOW() - INTERVAL 1 SECOND WHERE code = ?",
    [$lr2['code']]);
check('a ballot cast after the countdown expired is refused',
    castBallot($lc, [$lr2['id']])['status'] === 409);
$late = poll($lr2)['body'];
check('and it did not rewind the countdown',
    $late['room']['status'] === 'debrief',
    'graceLeft: ' . json_encode($late['room']['graceLeft']));
check('the refused ballot is not in the tally',
    (int) ($late['ballot']['accused'][0]['id'] ?? 0) === $lb['id']
    && array_sum(array_column($late['ballot']['tally'], 'votes')) === 3);

// The host's button is also the escape hatch for a table that keeps switching
// its pick and so keeps pushing the countdown back. It must beat the clock,
// not wait for it.
$cr = openRoom('IMPATIENT');
$c2 = seat($cr['code'], 'DITHERER');
$c3 = seat($cr['code'], 'ALSO DITHERING');
event($cr, 'deal');
event($cr, 'start');
event($cr, 'end');
castBallot($cr, [$c2['id']]);
castBallot($c2, [$c3['id']]);
castBallot($c3, [$c2['id']]);
check('the countdown is running before the host steps in',
    poll($cr)['body']['room']['graceLeft'] !== null);
check('the host closes the vote without waiting for the countdown',
    event($cr, 'closevote')['status'] === 200);
$cut = poll($c2)['body'];
check('an early close still settles the accusation it had',
    $cut['room']['status'] === 'debrief'
    && (int) ($cut['ballot']['accused'][0]['id'] ?? 0) === $c2['id']
    && array_sum(array_column($cut['ballot']['tally'], 'votes')) === 3);

// ------------------------------------------------------------------
//  15. The vote has no clock, so leaving has to be able to end it
// ------------------------------------------------------------------

$lr = openRoom('STAYER');
$l2 = seat($lr['code'], 'ALSO STAYING');
$l3 = seat($lr['code'], 'WALKS OUT');
event($lr, 'deal');
event($lr, 'start');
event($lr, 'end');

castBallot($lr, [$l2['id']]);
castBallot($l2, [$lr['id']]);
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
// Those two ballots accuse each other, so the room reaches a debrief with a
// counted tally and nobody clear of it. Settled, and settled as a tie.
$walked = poll($lr)['body'];
check('the ballots are counted even though nobody carried the vote',
    array_sum(array_column($walked['ballot']['tally'], 'votes')) === 2
    && $walked['ballot']['accused'] === []);

// A vote with nobody left to accuse. `cast >= seated` can never come true with
// one player and no candidates, so without a guard the survivor sits on a
// ballot listing nobody until they find CLOSE THE VOTE.
$ar = openRoom('LAST ONE');
$a2 = seat($ar['code'], 'FIRST OUT');
$a3 = seat($ar['code'], 'SECOND OUT');
event($ar, 'deal');
event($ar, 'start');
event($ar, 'end');
api('leave', ['code' => $a2['code'], 'token' => $a2['token']]);
api('leave', ['code' => $a3['code'], 'token' => $a3['token']]);
check('a vote with nobody left to accuse settles itself',
    poll($ar)['body']['room']['status'] === 'debrief',
    'the last player would sit on an empty ballot');

// The same thing, but the phone simply goes quiet and gets swept.
$sr = openRoom('SWEPT HOST');
$s2 = seat($sr['code'], 'PRESENT');
$s3 = seat($sr['code'], 'VANISHES');
event($sr, 'deal');
event($sr, 'start');
event($sr, 'end');
castBallot($sr, [$s2['id']]);
castBallot($s2, [$sr['id']]);
backdate($pdo, 'UPDATE spy_players SET last_seen = NOW() - INTERVAL 16 MINUTE WHERE id = ?', [$s3['id']]);
// Assert the ARMING, not just the close: runOutGrace backdates the deadline
// unconditionally and advancePhase closes on `expired` alone, so checking
// only the debrief would pass even if the sweep had never run.
check('sweeping the missing voter arms the countdown on the poll path',
    poll($sr)['body']['room']['graceLeft'] !== null,
    'the sweep is the only thing that can complete this table');
check('a swept voter also releases the vote',
    runOutGrace($pdo, $sr)['room']['status'] === 'debrief');

// An outcome must never exist before somebody decided it: the whole point of
// handing the call to the host is that a debrief sits there UNDECIDED while
// the accused defends themselves.
$ours       = implode(',', array_fill(0, count($CREATED_CODES), '?'));
$premature  = $pdo->prepare(
    "SELECT COUNT(*) FROM spy_rooms WHERE code IN ($ours) AND revealed = 0 AND outcome IS NOT NULL"
);
$premature->execute($CREATED_CODES);
$prematureN = (int) $premature->fetchColumn();
check('no room carries a verdict the host has not called', $prematureN === 0,
    "$prematureN rooms hold an outcome nobody called");
$halfCalled = $pdo->prepare(
    "SELECT COUNT(*) FROM spy_rooms WHERE code IN ($ours) AND revealed = 1 AND outcome IS NULL"
);
$halfCalled->execute($CREATED_CODES);
check('and no call ever lands without the verdict it carried', (int) $halfCalled->fetchColumn() === 0);

// The accused list is frozen at close time while the debrief's tally is read
// live from the ballots, so the two can only agree if nothing can add a ballot
// to a room that has already been counted. A disagreement here means a
// last-second tap slipped past closeVote, and the screen would print an
// ACCUSED that the bar chart under it contradicts.
$drifted  = [];
$debriefs = $pdo->prepare(
    "SELECT id, code, spies, accused_ids FROM spy_rooms WHERE code IN ($ours) AND status = 'debrief'"
);
$debriefs->execute($CREATED_CODES);
foreach ($debriefs->fetchAll() as $r) {
    $t = $pdo->prepare(
        'SELECT target_id AS id, COUNT(*) AS votes FROM spy_ballots
         WHERE room_id = ? GROUP BY target_id ORDER BY votes DESC'
    );
    $t->execute([$r['id']]);
    $rowsNow = $t->fetchAll();

    // The same top-n rule closeVote applies, recomputed from what is on disk
    // now: everything clear of the first name that missed the cut.
    $wanted = max(1, (int) $r['spies']);
    $bar    = isset($rowsNow[$wanted]) ? (int) $rowsNow[$wanted]['votes'] : 0;
    $now    = [];
    foreach (array_slice($rowsNow, 0, $wanted) as $row) {
        if ((int) $row['votes'] > $bar) {
            $now[] = (int) $row['id'];
        }
    }
    $frozen = $r['accused_ids'] === null || $r['accused_ids'] === ''
        ? []
        : array_map('intval', explode(',', (string) $r['accused_ids']));
    sort($now);
    sort($frozen);
    if ($now !== $frozen) {
        $drifted[] = "{$r['code']}: accused=" . json_encode($frozen) . " but the tally says " . json_encode($now);
    }
}
check('THE FROZEN ACCUSATION STILL MATCHES THE TALLY THE DEBRIEF PRINTS',
    $drifted === [], implode('; ', $drifted));

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
check('no ballots means nobody is accused at all',
    $empty['room']['status'] === 'debrief'
    && $empty['ballot']['accused'] === []
    && $empty['ballot']['tally'] === []
    && !array_key_exists('reveal', $empty));

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
