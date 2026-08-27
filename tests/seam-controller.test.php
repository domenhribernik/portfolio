<?php
declare(strict_types=1);

// Integration tests for seam-controller.php (SEAM's room mode: anonymous
// two-seat rooms over a shared event log, with the SERVER owning the board).
//
// Runs ONLY against the local scratch DB (127.0.0.1/portfolio): the DB_* env
// overrides below make database.php skip loading app/.env, which points at
// the remote production database. Never run these against prod.
//
// The suite applies app/models/seam-model.sql to the local DB itself
// (CREATE TABLE IF NOT EXISTS, so it is idempotent) and deletes every room
// it created on shutdown; room rows cascade to players and events.
//
// The load-bearing block is section 4: a client may send a shaft number and
// nothing else. If a forged board, a forged permit count or a claimed seam
// ever survives a request, the gamemode is broken, not the test.
//
// Run: C:\xampp\php\php.exe tests/seam-controller.test.php
//      /opt/lampp/bin/php tests/seam-controller.test.php

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit('CLI only');
}

const DB_DSN   = 'mysql:host=127.0.0.1;port=3306;dbname=portfolio;charset=utf8mb4';
const DB_USER  = 'portfolio_dev';
const DB_PASS  = 'R2miswz1pNKOxdl4';
const DOC_ROOT = __DIR__ . '/..';
const HOST     = '127.0.0.1';
const PORT     = 8934;
const API      = 'http://' . HOST . ':' . PORT . '/app/controllers/seam-controller.php';

const COLS  = 7;
const ROWS  = 6;
const EMPTY_BOARD = '..........................................';

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

/** @return array{status:int, body:mixed, raw:string, headers:array} */
function api(string $action, array $body, string $method = 'POST'): array
{
    $opts = ['http' => [
        'method'        => $method,
        'ignore_errors' => true,
        'timeout'       => 10,
        'header'        => 'Content-Type: application/json',
        'content'       => json_encode($body),
    ]];
    $raw = @file_get_contents(API . '?action=' . $action, false, stream_context_create($opts));
    $headers = $http_response_header ?? [];
    $status = 0;
    foreach ($headers as $h) {
        if (preg_match('#^HTTP/\S+\s+(\d{3})#', $h, $m)) {
            $status = (int) $m[1];
        }
    }
    return [
        'status'  => $status,
        'body'    => $raw !== false ? json_decode($raw, true) : null,
        'raw'     => $raw !== false ? $raw : '',
        'headers' => $headers,
    ];
}

function poll(array $who, int $since = 0): array
{
    return api('poll', ['code' => $who['code'], 'token' => $who['token'], 'since' => $since]);
}

/** Shorthand: cut into a shaft as one seat. */
function cutShaft(array $who, int $col, array $extra = []): array
{
    return api('move', ['code' => $who['code'], 'token' => $who['token'], 'col' => $col] + $extra);
}

// ------------------------------------------------------------------
//  Schema + teardown (rooms cascade to players and events)
// ------------------------------------------------------------------

$pdo = new PDO(DB_DSN, DB_USER, DB_PASS, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);

$schema = file_get_contents(DOC_ROOT . '/app/models/seam-model.sql');
if ($schema === false) {
    fwrite(STDERR, "Missing app/models/seam-model.sql\n");
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
    $pdo->prepare("DELETE FROM seam_rooms WHERE code IN ($in)")->execute($CREATED_CODES);
}

/** POST a raw body with a chosen content type, for the envelope cases. */
function rawPost(string $action, string $payload, string $type = 'application/json'): int
{
    $opts = ['http' => [
        'method' => 'POST', 'ignore_errors' => true, 'timeout' => 10,
        'header' => 'Content-Type: ' . $type, 'content' => $payload,
    ]];
    @file_get_contents(API . '?action=' . $action, false, stream_context_create($opts));
    foreach ($http_response_header ?? [] as $h) {
        if (preg_match('#^HTTP/\S+\s+(\d{3})#', $h, $m)) {
            return (int) $m[1];
        }
    }
    return 0;
}

/**
 * An independent seam finder, so the sweep at the end cross-checks the
 * controller's verdicts against something that is not the controller.
 */
function seamCells(string $board, string $seat): ?array
{
    foreach ([[0, 1], [1, 0], [1, 1], [1, -1]] as [$dr, $dc]) {
        for ($r = 0; $r < ROWS; $r++) {
            for ($c = 0; $c < COLS; $c++) {
                if ($r + $dr * 3 >= ROWS || $c + $dc * 3 < 0 || $c + $dc * 3 >= COLS) {
                    continue;
                }
                $cells = [];
                for ($i = 0; $i < 4; $i++) {
                    $cells[] = ($r + $dr * $i) * COLS + ($c + $dc * $i);
                }
                $all = true;
                foreach ($cells as $at) {
                    if ($board[$at] !== $seat) { $all = false; break; }
                }
                if ($all) { return $cells; }
            }
        }
    }
    return null;
}

/** Is every bed of this shaft taken. */
function columnFilled(string $board, int $col): bool
{
    for ($r = 0; $r < ROWS; $r++) {
        if ($board[$r * COLS + $col] === '.') {
            return false;
        }
    }
    return true;
}

/** The section row as it actually stands, for asserting against the wire. */
function roomRow(PDO $pdo, string $code): array
{
    $stmt = $pdo->prepare('SELECT * FROM seam_rooms WHERE code = ?');
    $stmt->execute([$code]);
    return $stmt->fetch(PDO::FETCH_ASSOC) ?: [];
}

/** Time travel: the suite never sleeps, it backdates rows instead. */
function backdate(PDO $pdo, string $sql, array $args): void
{
    $pdo->prepare($sql)->execute($args);
}

/** Opens a section and returns the host session. */
function openSection(string $name = 'HOST', array $extra = []): array
{
    $res = api('create', ['name' => $name] + $extra);
    trackRoom($res['body']);
    return [
        'code'  => $res['body']['code'] ?? '',
        'token' => $res['body']['token'] ?? '',
        'id'    => (int) ($res['body']['you']['id'] ?? 0),
        'seat'  => (int) ($res['body']['you']['seat'] ?? 0),
        'res'   => $res,
    ];
}

/** Seats the second surveyor, which is also what starts the match. */
function joinSection(string $code, string $name = 'GUEST'): array
{
    $res = api('join', ['code' => $code, 'name' => $name]);
    return [
        'code'  => $code,
        'token' => $res['body']['token'] ?? '',
        'id'    => (int) ($res['body']['you']['id'] ?? 0),
        'seat'  => (int) ($res['body']['you']['seat'] ?? 0),
        'res'   => $res,
    ];
}

/** Cuts the shafts in order, alternating seats from seat 1. */
function playCuts(array $p1, array $p2, array $cols): array
{
    $res  = ['status' => 0, 'body' => null];
    $seat = 1;
    foreach ($cols as $col) {
        $res  = cutShaft($seat === 1 ? $p1 : $p2, $col);
        $seat = $seat === 1 ? 2 : 1;
    }
    return $res;
}

/** A live section with both seats filled. */
function openPair(): array
{
    $host  = openSection('ONE');
    $guest = joinSection($host['code'], 'TWO');
    return [$host, $guest];
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
        'DB_HOST'    => '127.0.0.1',
        'DB_PORT'    => '3306',
        'DB_NAME'    => 'portfolio',
        'DB_USER_W'  => DB_USER,
        'DB_PASS_W'  => DB_PASS,
        'DB_USER_R'  => DB_USER,
        'DB_PASS_R'  => DB_PASS,
        'PATH'       => getenv('PATH') ?: '/usr/bin:/bin',
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

echo "\n== SEAM controller ==\n";

// ------------------------------------------------------------------
//  1. Opening a section
// ------------------------------------------------------------------

echo "\n-- opening a section --\n";

$host = openSection('DOMEN');
$body = $host['res']['body'];

check('create answers 201', $host['res']['status'] === 201, (string) $host['res']['status']);
check('create mints a four letter code', is_string($body['code'] ?? null) && preg_match('/^[A-Z]{4}$/', $body['code']) === 1,
    json_encode($body['code'] ?? null));
check('create mints a 32 hex token', preg_match('/^[a-f0-9]{32}$/', $body['token'] ?? '') === 1);
check('the opener takes seat 1 and the host chair', ($body['you']['seat'] ?? 0) === 1 && ($body['you']['host'] ?? false) === true);
check('a fresh section starts in the lobby', ($body['room']['status'] ?? '') === 'lobby');
check('a fresh section is empty', ($body['room']['board'] ?? '') === EMPTY_BOARD, $body['room']['board'] ?? 'missing');
check('both seats open with a full set of permits',
    ($body['room']['charges'] ?? null) === [3, 3], json_encode($body['room']['charges'] ?? null));
check('a name is required', api('create', [])['status'] === 400);


// ------------------------------------------------------------------
//  2. The second surveyor starts the match
// ------------------------------------------------------------------

echo "\n-- the second surveyor starts the match --\n";

$one = openSection('ONE');
$two = joinSection($one['code'], 'TWO');
$joined = $two['res']['body'];

check('join answers 200', $two['res']['status'] === 200, (string) $two['res']['status']);
check('the joiner takes seat 2 and no host chair',
    ($joined['you']['seat'] ?? 0) === 2 && ($joined['you']['host'] ?? true) === false);
check('SEATING THE SECOND SURVEYOR STARTS THE MATCH IN THE SAME REQUEST',
    ($joined['room']['status'] ?? '') === 'play', $joined['room']['status'] ?? 'missing');
check('the seat that starts is the one holding the first cut',
    ($joined['room']['turn'] ?? 0) === ($joined['room']['starter'] ?? -1));
check('the joiner inherits the language nobody asked them about',
    ($joined['room']['lang'] ?? '') === 'en');

$third = api('join', ['code' => $one['code'], 'name' => 'THREE']);
check('a third arrival is refused', $third['status'] === 409, (string) $third['status']);

$dupe = openSection('SAME');
check('two people in one section cannot answer to the same name',
    api('join', ['code' => $dupe['code'], 'name' => 'same'])['status'] === 409);

check('an unknown code is 404', api('join', ['code' => 'ZZZZ', 'name' => 'X'])['status'] === 404);
check('a malformed code is indistinguishable from a missing one',
    api('join', ['code' => 'nope!', 'name' => 'X'])['status'] === 404);
check('a joiner still needs a name', api('join', ['code' => $dupe['code']])['status'] === 400);

// ------------------------------------------------------------------
//  3. Polling
// ------------------------------------------------------------------

echo "\n-- polling --\n";

[$p1, $p2] = openPair();
$snap = poll($p1);
$env  = $snap['body'];

check('poll answers 200', $snap['status'] === 200, (string) $snap['status']);
check('the envelope carries room, you, players, events, last and more',
    isset($env['room'], $env['you'], $env['players'], $env['events'], $env['last']) && array_key_exists('more', $env),
    implode(',', array_keys($env ?? [])));
check('the snapshot carries the section itself', ($env['room']['board'] ?? '') === EMPTY_BOARD);
check('you know your own seat', ($env['you']['seat'] ?? 0) === 1);

$deals = array_values(array_filter($env['events'], static fn (array $e) => $e['type'] === 'deal'));
check('the deal is announced exactly once', count($deals) === 1, (string) count($deals));
check('the deal names who cuts first', ($deals[0]['data']['starter'] ?? 0) === ($env['room']['starter'] ?? -1));

$roster = $env['players'];
check('both surveyors appear in the roster', count($roster) === 2, (string) count($roster));
check('the roster carries seats and presence',
    ($roster[0]['seat'] ?? 0) === 1 && ($roster[1]['seat'] ?? 0) === 2
    && ($roster[0]['online'] ?? false) === true);
check('the roster carries names, never tokens', !str_contains($snap['raw'], $p1['token']));

$again = poll($p1, (int) $env['last']);
check('polling from the last cursor returns nothing new', $again['body']['events'] === []);
check('the cursor does not go backwards', (int) $again['body']['last'] >= (int) $env['last']);

check('a stranger token is 401',
    api('poll', ['code' => $p1['code'], 'token' => str_repeat('a', 32), 'since' => 0])['status'] === 401);
check('a malformed token is 401',
    api('poll', ['code' => $p1['code'], 'token' => 'nope', 'since' => 0])['status'] === 401);
check('a poll on an unknown section is 404',
    api('poll', ['code' => 'ZZZZ', 'token' => $p1['token'], 'since' => 0])['status'] === 404);

// ------------------------------------------------------------------
//  4. Cutting, and who decides what a cut did
// ------------------------------------------------------------------

echo "\n-- cutting --\n";

[$c1, $c2] = openPair();

$cut = cutShaft($c1, 3);
check('a cut answers 200', $cut['status'] === 200, (string) $cut['status']);
check('the piece lands on the basement bed of its shaft',
    ($cut['body']['room']['board'] ?? '')[(ROWS - 1) * COLS + 3] === '1',
    $cut['body']['room']['board'] ?? 'missing');
check('an ordinary cut spends no permit', ($cut['body']['room']['charges'] ?? null) === [3, 3]);
check('the cut passes the turn', ($cut['body']['room']['turn'] ?? 0) === 2);
check('the section is still live', array_key_exists('outcome', $cut['body']['room']) && $cut['body']['room']['outcome'] === null);

$after = poll($c2, 0)['body'];
$moves = array_values(array_filter($after['events'], static fn (array $e) => $e['type'] === 'move'));
check('one move event announces the cut', count($moves) === 1, (string) count($moves));
check('the move event carries enough to replay the animation',
    ($moves[0]['data']['seat'] ?? 0) === 1 && ($moves[0]['data']['col'] ?? -1) === 3
    && ($moves[0]['data']['caved'] ?? true) === false,
    json_encode($moves[0]['data'] ?? null));

check('cutting out of turn is refused', cutShaft($c1, 0)['status'] === 409);
check('a shaft outside the section is refused', cutShaft($c2, 9)['status'] === 400);
check('a shaft that is not a whole number is refused', cutShaft($c2, -1)['status'] === 400);

$lobby = openSection('WAITING');
check('a cut before the second surveyor arrives is refused', cutShaft($lobby, 0)['status'] === 409);

// ------------------------------------------------------------------
//  5. The load-bearing invariant
// ------------------------------------------------------------------

echo "\n-- the server owns the board --\n";

[$f1, $f2] = openPair();
$forged = cutShaft($f1, 0, [
    'board'   => str_repeat('1', COLS * ROWS),
    'charges' => [99, 0],
    'cooling' => [false, false],
    'turn'    => 1,
    'moves'   => 99,
    'outcome' => 'p1',
    'seam'    => '0,1,2,3',
    'caved'   => true,
]);
$row = roomRow($pdo, $f1['code']);
$expected = str_repeat('.', (ROWS - 1) * COLS) . '1' . str_repeat('.', COLS - 1);

check('THE SERVER OWNS THE BOARD, A FORGED SECTION IS IGNORED',
    $row['board'] === $expected, $row['board']);
check('A FORGED PERMIT COUNT IS IGNORED',
    (int) $row['charges_1'] === 3 && (int) $row['charges_2'] === 3,
    $row['charges_1'] . '/' . $row['charges_2']);
check('A CLAIMED SEAM IS IGNORED', $row['outcome'] === null && $row['seam'] === null,
    json_encode([$row['outcome'], $row['seam']]));
check('A FORGED TURN IS IGNORED', (int) $row['turn'] === 2, (string) $row['turn']);
check('A FORGED MOVE COUNT IS IGNORED', (int) $row['moves'] === 1, (string) $row['moves']);
check('the forged request still answered normally', $forged['status'] === 200);

// ------------------------------------------------------------------
//  6. Drawing the bottom
// ------------------------------------------------------------------

echo "\n-- drawing the bottom --\n";

[$d1, $d2] = openPair();
// Six alternating cuts fill shaft 0 without striking anything.
playCuts($d1, $d2, [0, 0, 0, 0, 0, 0]);
$filled = roomRow($pdo, $d1['code']);
check('six alternating cuts fill a shaft', columnFilled($filled['board'], 0), $filled['board']);

$drawn = cutShaft($d1, 0);
$room  = $drawn['body']['room'];
check('cutting a full shaft answers 200', $drawn['status'] === 200, (string) $drawn['status']);
check('the basement bed is gone and the section settled one bed down',
    $room['board'] === '1......2......1......2......1......2......',
    $room['board']);
check('the draw spends exactly one permit, and only the drawing seat\'s',
    $room['charges'] === [2, 3], json_encode($room['charges']));
check('the drawing seat is now cooling', $room['cooling'] === [true, false], json_encode($room['cooling']));

$moveEvents = array_values(array_filter(
    poll($d2, 0)['body']['events'],
    static fn (array $e) => $e['type'] === 'move' && ($e['data']['caved'] ?? false) === true
));
check('the cave is announced so the other plate can animate it', count($moveEvents) === 1);

// Shaft 0 is full again, and the cooldown is what times the next draw.
cutShaft($d2, 1);
$tooSoon = cutShaft($d1, 0);
check('a seat cannot draw on two of its own turns running', $tooSoon['status'] === 400);
check('and it is told why', ($tooSoon['body']['reason'] ?? '') === 'cooling', $tooSoon['body']['reason'] ?? 'missing');
check('the refused draw costs nothing',
    (int) roomRow($pdo, $d1['code'])['charges_1'] === 2);

// Spend the rest: an ordinary cut clears the cooldown, then draw again.
cutShaft($d1, 1);
cutShaft($d2, 1);
cutShaft($d1, 0);
cutShaft($d2, 1);
cutShaft($d1, 1);
cutShaft($d2, 1);
cutShaft($d1, 0);
$spent = roomRow($pdo, $d1['code']);
check('a seat can draw exactly CHARGES times', (int) $spent['charges_1'] === 0, (string) $spent['charges_1']);

cutShaft($d2, 2);
$exhausted = cutShaft($d1, 0);
check('with no permits left a full shaft is dead to that seat', $exhausted['status'] === 400);
check('and it is told why', ($exhausted['body']['reason'] ?? '') === 'noPermit', $exhausted['body']['reason'] ?? 'missing');

// ------------------------------------------------------------------
//  7. Striking a seam
// ------------------------------------------------------------------

echo "\n-- striking a seam --\n";

[$w1, $w2] = openPair();
$struck = playCuts($w1, $w2, [0, 6, 1, 5, 2, 6, 3]);
$won    = $struck['body']['room'];

check('the fourth in a row settles the section', $won['outcome'] === 'p1', json_encode($won['outcome']));
check('the section is finished', $won['status'] === 'over', $won['status']);
check('and it names the four beds the seam ran through',
    $won['seam'] === [35, 36, 37, 38], json_encode($won['seam']));

$log = poll($w2, 0)['body'];
$verdicts = array_values(array_filter($log['events'], static fn (array $e) => $e['type'] === 'verdict'));
check('the verdict is announced exactly once', count($verdicts) === 1, (string) count($verdicts));
check('the verdict carries the outcome', ($verdicts[0]['data']['outcome'] ?? '') === 'p1');

$winner = array_values(array_filter($log['players'], static fn (array $p) => $p['seat'] === 1))[0];
$loser  = array_values(array_filter($log['players'], static fn (array $p) => $p['seat'] === 2))[0];
check('the winner keeps the win across the series', $winner['wins'] === 1, (string) $winner['wins']);
check('the other seat keeps nothing', $loser['wins'] === 0, (string) $loser['wins']);

$afterwards = cutShaft($w2, 4);
check('a struck section takes no more cuts', $afterwards['status'] === 409);
check('and it says the section is finished',
    ($afterwards['body']['reason'] ?? '') === 'over', $afterwards['body']['reason'] ?? 'missing');
check('the struck board is not altered by the refusal',
    roomRow($pdo, $w1['code'])['board'] === $won['board']);

// ------------------------------------------------------------------
//  8. Another section, and one that loses a surveyor
// ------------------------------------------------------------------

echo "\n-- another section --\n";

[$a1, $a2] = openPair();
playCuts($a1, $a2, [0, 6, 1, 5, 2, 6, 3]);

$asked = api('again', ['code' => $a1['code'], 'token' => $a1['token']]);
check('asking for another section answers 200', $asked['status'] === 200, (string) $asked['status']);
check('one seat asking is not enough', roomRow($pdo, $a1['code'])['status'] === 'over');

$seen = poll($a2)['body'];
$asker = array_values(array_filter($seen['players'], static fn (array $p) => $p['seat'] === 1))[0];
check('the other plate can see who has asked', ($asker['wantsAgain'] ?? false) === true);

// Asking is a toggle, so a seat can change its mind before the other agrees.
api('again', ['code' => $a1['code'], 'token' => $a1['token']]);
$retracted = poll($a2)['body'];
check('asking is a toggle, so a seat can change its mind',
    array_values(array_filter($retracted['players'], static fn (array $p) => $p['seat'] === 1))[0]['wantsAgain'] === false);
api('again', ['code' => $a1['code'], 'token' => $a1['token']]);

$both = api('again', ['code' => $a2['code'], 'token' => $a2['token']]);
$fresh = $both['body']['room'];
check('when both ask, a new section opens', $fresh['status'] === 'play', $fresh['status']);
check('and it is empty', $fresh['board'] === EMPTY_BOARD);
check('THE FIRST CUT ALTERNATES SO NEITHER SEAT KEEPS THE ADVANTAGE',
    $fresh['starter'] === 2 && $fresh['turn'] === 2, json_encode([$fresh['starter'], $fresh['turn']]));
check('every permit is back', $fresh['charges'] === [3, 3], json_encode($fresh['charges']));
check('nobody starts the new section cooling', $fresh['cooling'] === [false, false]);
check('the section is live again', $fresh['outcome'] === null && $fresh['seam'] === null);

$reopened = poll($a1)['body'];
check('the wins survive into the series',
    array_values(array_filter($reopened['players'], static fn (array $p) => $p['seat'] === 1))[0]['wins'] === 1);
check('nobody is still asking', array_values(array_filter(
    $reopened['players'], static fn (array $p) => ($p['wantsAgain'] ?? false) === true)) === []);
$deals = array_values(array_filter($reopened['events'], static fn (array $e) => $e['type'] === 'deal'));
check('two deals in the log, one per section', count($deals) === 2, (string) count($deals));

check('a live section cannot be restarted out from under a cut',
    api('again', ['code' => $a1['code'], 'token' => $a1['token']])['status'] === 409);

echo "\n-- a section that loses a surveyor --\n";

[$l1, $l2] = openPair();
cutShaft($l1, 3);
check('leaving answers 200',
    api('leave', ['code' => $l2['code'], 'token' => $l2['token']])['status'] === 200);

$alone = poll($l1)['body'];
check('A SECTION THAT LOSES A SURVEYOR REOPENS FOR A NEW ONE',
    $alone['room']['status'] === 'lobby', $alone['room']['status']);
check('the roster is down to one', count($alone['players']) === 1);
$abandons = array_values(array_filter($alone['events'], static fn (array $e) => $e['type'] === 'abandon'));
check('one abandon event says so', count($abandons) === 1, (string) count($abandons));

$replacement = joinSection($l1['code'], 'THREE');
check('a newcomer can take the empty seat', $replacement['res']['status'] === 200,
    (string) $replacement['res']['status']);
check('and that starts a fresh match', ($replacement['res']['body']['room']['status'] ?? '') === 'play');
check('on an empty section', ($replacement['res']['body']['room']['board'] ?? '') === EMPTY_BOARD);

check('a departed token no longer works',
    api('poll', ['code' => $l2['code'], 'token' => $l2['token'], 'since' => 0])['status'] === 401);

// ------------------------------------------------------------------
//  9. Presence, and taking back a seat
// ------------------------------------------------------------------

echo "\n-- presence and reclaiming a seat --\n";

[$s1, $s2] = openPair();
$seats = api('seats', ['code' => $s1['code']]);
check('seats answers without a token at all', $seats['status'] === 200, (string) $seats['status']);
check('seats lists both surveyors', count($seats['body']['players'] ?? []) === 2);
check('seats never leaks a token', !str_contains($seats['raw'], $s1['token']) && !str_contains($seats['raw'], $s2['token']));
check('a live seat is not reclaimable', ($seats['body']['players'][1]['reclaimable'] ?? true) === false);

check('a live seat cannot be taken',
    api('reclaim', ['code' => $s1['code'], 'playerId' => $s2['id']])['status'] === 409);

backdate($pdo, 'UPDATE seam_players SET last_seen = NOW() - INTERVAL 60 SECOND WHERE id = ?', [$s2['id']]);
$taken = api('reclaim', ['code' => $s1['code'], 'playerId' => $s2['id']]);
check('a seat quiet for long enough can be taken', $taken['status'] === 200, (string) $taken['status']);
check('the newcomer keeps the seat number', ($taken['body']['you']['seat'] ?? 0) === 2);
check('reclaiming mints a fresh token', preg_match('/^[a-f0-9]{32}$/', $taken['body']['token'] ?? '') === 1);
check('the old phone is evicted on its next poll', poll($s2)['status'] === 401);
check('the new phone is in', poll(['code' => $s1['code'], 'token' => $taken['body']['token']])['status'] === 200);
check('a seat that never existed is 404',
    api('reclaim', ['code' => $s1['code'], 'playerId' => 999999])['status'] === 404);

echo "\n-- a phone that stops polling --\n";

[$q1, $q2] = openPair();
backdate($pdo, 'UPDATE seam_players SET last_seen = NOW() - INTERVAL 20 MINUTE WHERE id = ?', [$q2['id']]);
$swept = poll($q1)['body'];
check('a phone silent for a quarter of an hour forfeits its seat', count($swept['players']) === 1);
check('and the section reopens for a replacement', $swept['room']['status'] === 'lobby');

echo "\n-- the host walking out --\n";

[$h1, $h2] = openPair();
api('leave', ['code' => $h1['code'], 'token' => $h1['token']]);
$inherited = poll($h2)['body'];
check('the remaining surveyor inherits the host chair', ($inherited['you']['host'] ?? false) === true);
$hostEvents = array_values(array_filter($inherited['events'], static fn (array $e) => $e['type'] === 'host'));
check('the handover is announced exactly once', count($hostEvents) === 1, (string) count($hostEvents));
check('and it names the heir', ($hostEvents[0]['data']['id'] ?? 0) === $h2['id']);

echo "\n-- the janitor --\n";

$stale = openSection('GHOST');
backdate($pdo, 'UPDATE seam_rooms SET last_active = NOW() - INTERVAL 7 HOUR WHERE code = ?', [$stale['code']]);
openSection('FRESH');
check('a section idle past the threshold is purged by the next create',
    poll($stale)['status'] === 404);

echo "\n-- the request envelope --\n";

$live = openSection('ENVELOPE');
check('a bare GET is refused', api('create', ['name' => 'X'], 'GET')['status'] === 405);
check('a form encoded body is refused',
    rawPost('create', 'name=X', 'application/x-www-form-urlencoded') === 415);
check('an oversized body is refused',
    rawPost('create', json_encode(['name' => str_repeat('x', 70000)])) === 413);
check('an unknown action is refused', api('nope', [])['status'] === 400);
check('per-room state is never cached',
    (bool) array_filter($live['res']['headers'], static fn ($h) => stripos($h, 'Cache-Control: no-store') === 0));
check('NO WILDCARD CORS ON A TOKEN AUTHED ENDPOINT',
    array_filter($live['res']['headers'], static fn ($h) => stripos($h, 'Access-Control-Allow-Origin') === 0) === []);

// ------------------------------------------------------------------
//  10. Invariants over everything this run created
// ------------------------------------------------------------------

echo "\n-- invariants --\n";

if ($CREATED_CODES !== []) {
    $in = implode(',', array_fill(0, count($CREATED_CODES), '?'));
    $rooms = $pdo->prepare("SELECT code, status, board, outcome, seam FROM seam_rooms WHERE code IN ($in)");
    $rooms->execute($CREATED_CODES);
    $all = $rooms->fetchAll(PDO::FETCH_ASSOC);

    $undecided = array_filter($all, static fn (array $r) => $r['status'] === 'over' && $r['outcome'] === null);
    check('no section is ever finished without an outcome', $undecided === [],
        json_encode(array_column($undecided, 'code')));

    $drifted = [];
    foreach ($all as $r) {
        if ($r['outcome'] !== 'p1' && $r['outcome'] !== 'p2') {
            continue;
        }
        $seat  = $r['outcome'] === 'p1' ? '1' : '2';
        $cells = seamCells($r['board'], $seat);
        if ($cells === null || implode(',', $cells) !== $r['seam']) {
            $drifted[] = $r['code'];
        }
    }
    check('THE FROZEN VERDICT STILL MATCHES THE SECTION IT WAS STRUCK IN',
        $drifted === [], implode(',', $drifted));

    $bothStruck = array_filter($all, static fn (array $r) =>
        seamCells($r['board'], '1') !== null && seamCells($r['board'], '2') !== null);
    check('no section ever ends up with a seam for both seats', $bothStruck === [],
        json_encode(array_column($bothStruck, 'code')));
}

// ------------------------------------------------------------------
//  Result
// ------------------------------------------------------------------

echo "\n$passed passed, $failed failed\n";
exit($failed === 0 ? 0 : 1);
