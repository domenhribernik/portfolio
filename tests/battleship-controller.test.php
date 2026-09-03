<?php
declare(strict_types=1);

// Integration tests for battleship-controller.php (the room mode: anonymous
// two-seat rooms with a shared event log and SECRET fleets).
//
// Runs ONLY against the local scratch DB (127.0.0.1/portfolio): the DB_* env
// overrides below make database.php skip loading app/.env, which points at
// the remote production database. Never run these against prod.
//
// The suite applies app/models/battleship-model.sql to the local DB itself
// (CREATE TABLE IF NOT EXISTS, so it is idempotent) and deletes every room it
// created on shutdown; room rows cascade to players, events and intel.
//
// The first two blocks of cases are the ones that matter. A fleet is a secret
// and the whole game is pointless if one turns up in the other seat's payload;
// and the server owns both plots, so a client that reports its own hits, its
// own salvage or its own victory must be read straight past.
//
// Run: /opt/lampp/bin/php tests/battleship-controller.test.php
//      C:\xampp\php\php.exe tests/battleship-controller.test.php

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit('CLI only');
}

const DB_DSN   = 'mysql:host=127.0.0.1;port=3306;dbname=portfolio;charset=utf8mb4';
const DB_USER  = 'portfolio_dev';
const DB_PASS  = 'R2miswz1pNKOxdl4';
const DOC_ROOT = __DIR__ . '/..';
const HOST     = '127.0.0.1';
const PORT     = 8963;
const API      = 'http://' . HOST . ':' . PORT . '/app/controllers/battleship-controller.php';

// Spawn whatever interpreter is running this suite, and pick the null device
// for this platform, so the suite runs under XAMPP on Windows and on Linux.
define('NULL_DEV', PHP_OS_FAMILY === 'Windows' ? 'NUL' : '/dev/null');

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

// ------------------------------------------------------------------
//  Constants, read out of the controller rather than retyped here
// ------------------------------------------------------------------

$src = file_get_contents(DOC_ROOT . '/app/controllers/battleship-controller.php');
function constant_(string $name): int
{
    global $src;
    if (!preg_match("/^const\s+$name\s*=\s*(\d+)\s*;/m", $src, $m)) {
        fwrite(STDERR, "battleship-controller.php no longer declares $name\n");
        exit(1);
    }
    return (int) $m[1];
}
$SALVAGE_CAP = constant_('SALVAGE_CAP');
$COST_SONAR = constant_('COST_SONAR');
$COST_DEPTH_CHARGE = constant_('COST_DEPTH_CHARGE');
$UNLOCK_DEPTH_CHARGE = constant_('UNLOCK_DEPTH_CHARGE');

// ------------------------------------------------------------------
//  Fixtures
// ------------------------------------------------------------------

/** Column letter + one-based row -> row-major index. */
function cell(string $name): int
{
    preg_match('/^([A-J])(\d+)$/', $name, $m);
    return ((int) $m[2] - 1) * 10 + (strpos('ABCDEFGHIJ', $m[1]));
}
function coord(int $i): string
{
    return 'ABCDEFGHIJ'[$i % 10] . (string) (intdiv($i, 10) + 1);
}

/** A legal fleet laid along the odd rows, so every test can read the plot. */
function fleetA(): array
{
    return [
        ['key' => 'carrier',    'at' => cell('A1'), 'dir' => 'h'],
        ['key' => 'battleship', 'at' => cell('A3'), 'dir' => 'h'],
        ['key' => 'cruiser',    'at' => cell('A5'), 'dir' => 'h'],
        ['key' => 'submarine',  'at' => cell('A7'), 'dir' => 'h'],
        ['key' => 'destroyer',  'at' => cell('A9'), 'dir' => 'h'],
    ];
}

/** Every cell a fleet occupies, as plotted names. */
function fleetCoords(array $fleet): array
{
    $lens = ['carrier' => 5, 'battleship' => 4, 'cruiser' => 3, 'submarine' => 3, 'destroyer' => 2];
    $out = [];
    foreach ($fleet as $s) {
        $step = $s['dir'] === 'v' ? 10 : 1;
        for ($i = 0; $i < $lens[$s['key']]; $i++) {
            $out[] = $s['at'] + $i * $step;
        }
    }
    return $out;
}

$CREATED_CODES = [];

function trackRoom(?array $body): void
{
    global $CREATED_CODES;
    if (is_array($body) && isset($body['code'])) {
        $CREATED_CODES[] = $body['code'];
    }
}

function teardown(PDO $pdo): void
{
    global $CREATED_CODES;
    if ($CREATED_CODES === []) {
        return;
    }
    $codes = array_values(array_unique($CREATED_CODES));
    $in = implode(',', array_fill(0, count($codes), '?'));
    $pdo->prepare("DELETE FROM battleship_rooms WHERE code IN ($in)")->execute($codes);
}

// ------------------------------------------------------------------
//  Schema
// ------------------------------------------------------------------

$pdo = new PDO(DB_DSN, DB_USER, DB_PASS, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);

$schema = file_get_contents(DOC_ROOT . '/app/models/battleship-model.sql');
if ($schema === false) {
    fwrite(STDERR, "Missing app/models/battleship-model.sql\n");
    exit(1);
}
// Strip comments before splitting on ';': an indented comment containing a
// semicolon would otherwise cut a CREATE TABLE in half.
$schema = preg_replace('/^\s*--.*$/m', '', $schema);
foreach (array_filter(array_map('trim', explode(';', $schema))) as $stmt) {
    $pdo->exec($stmt);
}
teardown($pdo);   // clean leftovers from a crashed run

// ------------------------------------------------------------------
//  Boot. The DB_* overrides here are the prod guard: they make
//  database.php skip app/.env, which points at production.
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
    fwrite(STDERR, 'Test server did not start on ' . HOST . ':' . PORT . "\n");
    exit(1);
}

// ------------------------------------------------------------------
//  Helpers that drive a whole match
// ------------------------------------------------------------------

/** Open a room and seat both players. Returns both sessions. */
function openMatch(): array
{
    $one = api('create', ['name' => 'Hornet', 'lang' => 'en']);
    trackRoom($one['body']);
    $code = $one['body']['code'];
    $two = api('join', ['code' => $code, 'name' => 'Kestrel']);
    return [
        'code' => $code,
        1 => ['token' => $one['body']['token'], 'seat' => (int) $one['body']['you']['seat']],
        2 => ['token' => $two['body']['token'], 'seat' => (int) $two['body']['you']['seat']],
    ];
}

function place(array $m, int $who, array $fleet): array
{
    return api('place', ['code' => $m['code'], 'token' => $m[$who]['token'], 'fleet' => $fleet]);
}

function poll(array $m, int $who, int $since = 0): array
{
    return api('poll', ['code' => $m['code'], 'token' => $m[$who]['token'], 'since' => $since]);
}

function act(array $m, int $who, array $action): array
{
    return api('act', ['code' => $m['code'], 'token' => $m[$who]['token']] + $action);
}

/** Whose turn it is, by seat number. */
function turnOf(array $m): int
{
    return (int) poll($m, 1)['body']['room']['turn'];
}

/** Open a match with both fleets laid and the battle running. */
function battle(): array
{
    $m = openMatch();
    place($m, 1, fleetA());
    place($m, 2, fleetA());
    return $m;
}

/** Force a seat's salvage and put n of its own hulls on the bottom. */
function arm(PDO $pdo, array $m, int $who, int $salvage, int $wrecks = 0): void
{
    $stmt = $pdo->prepare(
        'SELECT p.id, p.grid FROM battleship_players p JOIN battleship_rooms r ON r.id = p.room_id
         WHERE r.code = ? AND p.seat = ?'
    );
    $stmt->execute([$m['code'], $m[$who]['seat']]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    $grid = $row['grid'];
    // The first `wrecks` ships of fleetA(), sunk outright.
    foreach (array_slice(fleetA(), 0, $wrecks) as $ship) {
        foreach (fleetCoords([$ship]) as $c) {
            $grid[$c] = 's';
        }
    }
    $pdo->prepare('UPDATE battleship_players SET salvage = ?, grid = ? WHERE id = ?')
        ->execute([$salvage, $grid, $row['id']]);
}

echo "\nBATTLESHIP CONTROLLER\n";

// ------------------------------------------------------------------
//  1. A FLEET IS A SECRET
// ------------------------------------------------------------------

echo "\n1. A fleet is a secret\n";

$m = openMatch();
place($m, 1, fleetA());

// Seat 1's fleet is laid, seat 2's is not. Nothing seat 2 can ask for may
// contain it, at any phase, in any field, under any key.
$secret = fleetCoords(fleetA());

$leaked = [];
foreach ([poll($m, 2), api('seats', ['code' => $m['code']])] as $res) {
    foreach (['carrier', 'battleship', 'cruiser', 'submarine', 'destroyer'] as $key) {
        if (str_contains($res['raw'], '"' . $key . '"')) {
            $leaked[] = $key;
        }
    }
}
check(
    'THE ENEMY FLEET NEVER APPEARS IN A PAYLOAD DURING PLACEMENT',
    $leaked === [],
    'leaked ' . implode(',', $leaked)
);

place($m, 2, fleetA());
$mid = poll($m, 2);
check(
    'THE ENEMY FLEET NEVER APPEARS ONCE THE BATTLE STARTS',
    !str_contains($mid['raw'], '"carrier"') || !isset($mid['body']['enemy']['fleet']),
    'enemy block carried a fleet'
);
check(
    'THE ENEMY BLOCK HAS NO FLEET, NO BUOYS AND NO READINGS',
    !array_key_exists('fleet', $mid['body']['enemy'])
        && !array_key_exists('decoys', $mid['body']['enemy'])
        && !array_key_exists('intel', $mid['body']['enemy']),
    'enemy keys: ' . implode(',', array_keys($mid['body']['enemy']))
);
check(
    'YOUR OWN BLOCK STILL CARRIES YOUR OWN FLEET',
    count($mid['body']['you']['fleet']) === 5
);

// Every cell of the enemy fleet must read as unfired on the plot the poll
// hands over, because nothing has been fired at it yet.
$plot = $mid['body']['enemy']['grid'];
$shown = 0;
foreach ($secret as $c) {
    if ($plot[$c] !== '.') {
        $shown++;
    }
}
check('AN UNFIRED HULL CELL READS AS OPEN WATER', $shown === 0, "$shown cells gave a hull away");

// ------------------------------------------------------------------
//  2. THE SERVER OWNS BOTH PLOTS
// ------------------------------------------------------------------

echo "\n2. The server owns both plots\n";

$m = battle();
$mover = turnOf($m);
$other = $mover === 1 ? 2 : 1;

// A body that reports its own outcome, its own hits and its own bank.
act($m, $mover, [
    'kind' => 'fire',
    'at' => cell('J10'),                     // open water on fleetA()
    'result' => 'sunk',
    'salvage' => 99,
    'grid' => str_repeat('x', 100),
    'outcome' => 'p1',
    'turn' => $mover,
]);
$after = poll($m, $mover)['body'];
check('A FORGED RESULT IS IGNORED', $after['enemy']['grid'][cell('J10')] === 'o',
    'plotted ' . $after['enemy']['grid'][cell('J10')]);
check('A FORGED SALVAGE TOTAL IS IGNORED', $after['you']['salvage'] <= $SALVAGE_CAP);
check('A FORGED PLOT IS IGNORED', substr_count($after['enemy']['grid'], 'x') === 0);
check('A FORGED VERDICT IS IGNORED', $after['room']['outcome'] === null);
check('THE TURN PASSES WHETHER THE CLIENT SAYS SO OR NOT', (int) $after['room']['turn'] === $other);

$forgedFleet = poll($m, $other)['body']['you']['fleet'];
check('A PLACEMENT SURVIVES THE OTHER SEAT SHOOTING AT IT', count($forgedFleet) === 5);

// ------------------------------------------------------------------
//  3. Opening a room and laying fleets
// ------------------------------------------------------------------

echo "\n3. Opening a room\n";

$one = api('create', ['name' => 'Hornet', 'lang' => 'en']);
trackRoom($one['body']);
check('CREATE ANSWERS 201 WITH A CODE AND A TOKEN', $one['status'] === 201
    && preg_match('/^[BCDFGHJKLMNPQRSTVWXZ]{4}$/', $one['body']['code']) === 1
    && preg_match('/^[a-f0-9]{32}$/', $one['body']['token']) === 1, $one['raw']);

$code = $one['body']['code'];
check('A LONE ROOM IS STILL IN THE LOBBY',
    poll(['code' => $code, 1 => ['token' => $one['body']['token']]], 1)['body']['room']['status'] === 'lobby');

$dupe = api('join', ['code' => $code, 'name' => 'hornet']);
check('A NAME ALREADY IN THE ROOM IS REFUSED, CASE AND ALL', $dupe['status'] === 409);

$two = api('join', ['code' => $code, 'name' => 'Kestrel']);
check('THE SECOND SEAT STARTS THE PLACEMENT PHASE', $two['status'] === 201);
$m = ['code' => $code,
      1 => ['token' => $one['body']['token'], 'seat' => 1],
      2 => ['token' => $two['body']['token'], 'seat' => (int) $two['body']['you']['seat']]];
check('BOTH SEATS ARE LAYING FLEETS AT ONCE', poll($m, 1)['body']['room']['status'] === 'place');

$third = api('join', ['code' => $code, 'name' => 'Petrel']);
check('A THIRD PLAYER IS TURNED AWAY', $third['status'] === 409);

check('A FLEET MISSING A SHIP IS REFUSED',
    place($m, 1, array_slice(fleetA(), 0, 4))['body']['reason'] === 'badFleet');
$overlap = fleetA();
$overlap[1]['at'] = cell('B1');
check('AN OVERLAPPING FLEET IS REFUSED', place($m, 1, $overlap)['body']['reason'] === 'overlap');
$off = fleetA();
$off[0]['at'] = cell('G1');
check('A FLEET THAT RUNS OFF THE PLOT IS REFUSED, NOT WRAPPED',
    place($m, 1, $off)['body']['reason'] === 'offPlot');

check('ONE FLEET DOWN IS NOT A BATTLE', place($m, 1, fleetA())['status'] === 200
    && poll($m, 1)['body']['room']['status'] === 'place');
place($m, 2, fleetA());
check('BOTH FLEETS DOWN STARTS THE BATTLE', poll($m, 1)['body']['room']['status'] === 'battle');
check('THE SEAT THAT MOVES SECOND OPENS WITH A SALVAGE',
    poll($m, turnOf($m) === 1 ? 2 : 1)['body']['you']['salvage'] === 1);

// ------------------------------------------------------------------
//  4. Firing
// ------------------------------------------------------------------

echo "\n4. Firing\n";

$m = battle();
$mover = turnOf($m);
$other = $mover === 1 ? 2 : 1;

check('FIRING OUT OF TURN IS REFUSED',
    act($m, $other, ['kind' => 'fire', 'at' => cell('J10')])['body']['reason'] === 'notYourTurn');
check('A CELL OFF THE PLOT IS REFUSED',
    act($m, $mover, ['kind' => 'fire', 'at' => 100])['body']['reason'] === 'offPlot');
check('A CELL THAT IS NOT AN INTEGER IS REFUSED',
    act($m, $mover, ['kind' => 'fire', 'at' => '3'])['body']['reason'] === 'offPlot');

act($m, $mover, ['kind' => 'fire', 'at' => cell('J10')]);
check('A MISS IS PLOTTED AS A MISS', poll($m, $mover)['body']['enemy']['grid'][cell('J10')] === 'o');
check('A SPENT CELL CANNOT BE FIRED AT AGAIN',
    act($m, $other, ['kind' => 'fire', 'at' => cell('J10')])['status'] === 400
    || act($m, $mover, ['kind' => 'fire', 'at' => cell('J10')])['body']['reason'] === 'spent');

$m = battle();
$mover = turnOf($m);
act($m, $mover, ['kind' => 'fire', 'at' => cell('B1')]);
$hit = poll($m, $mover)['body'];
check('A HIT IS PLOTTED AND PAYS THE GUNNER', $hit['enemy']['grid'][cell('B1')] === 'x'
    && $hit['you']['salvage'] >= 1);
check('THE STRUCK FLEET IS PAID TOO, SO AN EXCHANGE IS EVEN',
    $hit['enemy']['salvage'] >= 1);

// Sink the destroyer, one seat firing on both turns via the other passing.
$m = battle();
$mover = turnOf($m);
$other = $mover === 1 ? 2 : 1;
act($m, $mover, ['kind' => 'fire', 'at' => cell('A9')]);
act($m, $other, ['kind' => 'fire', 'at' => cell('J1')]);
act($m, $mover, ['kind' => 'fire', 'at' => cell('B9')]);
$sunk = poll($m, $mover)['body'];
check('THE LAST CELL OF A HULL SINKS IT', in_array('destroyer', $sunk['enemy']['sunk'], true));
check('A WRECK IS RESTRUCK ACROSS ITS WHOLE HULL',
    $sunk['enemy']['grid'][cell('A9')] === 's' && $sunk['enemy']['grid'][cell('B9')] === 's');
$types = array_column(poll($m, $mover, 0)['body']['events'], 'type');
check('A SINKING IS ANNOUNCED TO THE ROOM', in_array('sunk', $types, true));

// ------------------------------------------------------------------
//  5. The unlock ladder
// ------------------------------------------------------------------

echo "\n5. The unlock ladder\n";

$m = battle();
$mover = turnOf($m);
arm($pdo, $m, $mover, $SALVAGE_CAP, 0);
check('THE CHARGE IS LOCKED WHILE YOUR OWN FLEET IS WHOLE',
    act($m, $mover, ['kind' => 'depthCharge', 'at' => cell('E5')])['body']['reason'] === 'locked');
check('THE BARRAGE IS LOCKED TOO',
    act($m, $mover, ['kind' => 'barrage', 'at' => cell('E5'), 'dir' => 'h'])['body']['reason'] === 'locked');
check('A SWEEP IS OPEN FROM THE FIRST TURN',
    act($m, $mover, ['kind' => 'sonar', 'at' => cell('E5')])['status'] === 200);

$m = battle();
$mover = turnOf($m);
arm($pdo, $m, $mover, $SALVAGE_CAP, $UNLOCK_DEPTH_CHARGE);
check('YOUR OWN WRECKS OPEN THE CHARGE',
    act($m, $mover, ['kind' => 'depthCharge', 'at' => cell('J6')])['status'] === 200);

// The ladder must count YOUR wrecks, never the enemy's, or it would reward
// the side already ahead: the exact snowball the variant exists to break.
$m = battle();
$mover = turnOf($m);
$other = $mover === 1 ? 2 : 1;
arm($pdo, $m, $mover, $SALVAGE_CAP, 0);
arm($pdo, $m, $other, 0, $UNLOCK_DEPTH_CHARGE);
check('THE LADDER COUNTS YOUR OWN WRECKS, NOT THE ENEMY YOU HAVE SUNK',
    act($m, $mover, ['kind' => 'depthCharge', 'at' => cell('E5')])['body']['reason'] === 'locked');

$m = battle();
$mover = turnOf($m);
arm($pdo, $m, $mover, $COST_DEPTH_CHARGE - 1, $UNLOCK_DEPTH_CHARGE);
check('AN UNLOCKED TOOL YOU CANNOT AFFORD IS STILL REFUSED',
    act($m, $mover, ['kind' => 'depthCharge', 'at' => cell('E5')])['body']['reason'] === 'broke');

// ------------------------------------------------------------------
//  6. A SONAR READING REACHES ONLY ITS CALLER
// ------------------------------------------------------------------

echo "\n6. A sweep\n";

$m = battle();
$mover = turnOf($m);
$other = $mover === 1 ? 2 : 1;
arm($pdo, $m, $mover, $SALVAGE_CAP, 0);
act($m, $mover, ['kind' => 'sonar', 'at' => cell('B1')]);

$mine = poll($m, $mover);
$theirs = poll($m, $other);
check('THE CALLER GETS A READING', ($mine['body']['you']['intel'][0]['count'] ?? null) === 3,
    json_encode($mine['body']['you']['intel']));
check('A SONAR READING REACHES ONLY THE CALLER',
    ($theirs['body']['you']['intel'] ?? []) === [], $theirs['raw']);
check('THE READING IS NOT IN THE EVENT LOG EITHER',
    !preg_match('/"count"\s*:/', $theirs['raw']), 'a reading crossed the table');
check('THE SWEPT FLEET LEARNS WHERE THE ENEMY LOOKED',
    in_array(cell('B1'), $theirs['body']['you']['swept'] ?? [], true),
    json_encode($theirs['body']['you']['swept'] ?? null));
check('A SWEEP IS NOT A SHOT', substr_count($theirs['body']['you']['grid'], 'o') === 0);
check('A SWEEP COSTS ITS PRICE', $mine['body']['you']['salvage'] === $SALVAGE_CAP - $COST_SONAR);

// ------------------------------------------------------------------
//  7. Area fire
// ------------------------------------------------------------------

echo "\n7. Area fire\n";

$m = battle();
$mover = turnOf($m);
arm($pdo, $m, $mover, $SALVAGE_CAP, $UNLOCK_DEPTH_CHARGE);
$bank = poll($m, $mover)['body']['you']['salvage'];
act($m, $mover, ['kind' => 'depthCharge', 'at' => cell('B1')]);
$blast = poll($m, $mover)['body'];
check('A CHARGE STRIKES ITS WHOLE BLOCK',
    substr_count($blast['enemy']['grid'], 'x') + substr_count($blast['enemy']['grid'], 's') >= 3);
check('A CHARGE DOES NOT SURVEY THE WATER IT CHURNS',
    $blast['enemy']['grid'][cell('A2')] === '.' && $blast['enemy']['grid'][cell('B2')] === '.',
    'row 2 was plotted for free');
check('AREA FIRE PAYS THE GUNNER NOTHING',
    $blast['you']['salvage'] === $bank - $COST_DEPTH_CHARGE,
    "bank went $bank -> {$blast['you']['salvage']}");
check('THE FLEET IT LANDED ON IS STILL PAID', $blast['enemy']['salvage'] > 0);

$m = battle();
$mover = turnOf($m);
arm($pdo, $m, $mover, $SALVAGE_CAP, 1);
check('A BARRAGE MAY NOT WRAP ONTO THE NEXT ROW',
    act($m, $mover, ['kind' => 'barrage', 'at' => cell('I4'), 'dir' => 'h'])['body']['reason'] === 'offPlot');

// ------------------------------------------------------------------
//  8. Buoys and repositioning
// ------------------------------------------------------------------

echo "\n8. Buoys and repositioning\n";

$m = battle();
$mover = turnOf($m);
$other = $mover === 1 ? 2 : 1;
arm($pdo, $m, $mover, $SALVAGE_CAP, 0);
check('A BUOY MAY NOT SIT ON YOUR OWN HULL',
    act($m, $mover, ['kind' => 'decoy', 'at' => cell('A1')])['body']['reason'] === 'occupied');
check('A BUOY GOES ON YOUR OWN OPEN WATER',
    act($m, $mover, ['kind' => 'decoy', 'at' => cell('A2')])['status'] === 200);

$peek = poll($m, $other);
check('A BUOY IS NOT DISCLOSED TO THE FLEET SHOOTING AT IT',
    !array_key_exists('decoys', $peek['body']['enemy']) && $peek['body']['enemy']['grid'][cell('A2')] === '.',
    'a buoy was visible');

act($m, $other, ['kind' => 'fire', 'at' => cell('A2')]);
$popped = poll($m, $other)['body'];
check('A BUOY READS AS A HIT WHEN IT POPS', $popped['enemy']['grid'][cell('A2')] === 'x');
check('A BUOY PAYS OUT LIKE A HULL, SO THE PUBLIC TOTE DOES NOT GIVE IT AWAY',
    $popped['you']['salvage'] >= 1 && $popped['enemy']['salvage'] >= 1);
check('A BUOY IS NOT A HULL AND CANNOT SINK', $popped['enemy']['sunk'] === []);

arm($pdo, $m, $mover, $SALVAGE_CAP, 0);
act($m, $mover, ['kind' => 'fire', 'at' => cell('J10')]);
check('THE BUOY CONFESSES ON ITS OWNER NEXT TURN',
    poll($m, $other)['body']['enemy']['grid'][cell('A2')] === 'd');

$m = battle();
$mover = turnOf($m);
arm($pdo, $m, $mover, $SALVAGE_CAP, 1);
check('AN UNKNOWN SHIP CANNOT BE MOVED',
    act($m, $mover, ['kind' => 'reposition', 'ship' => 'nimitz', 'at' => cell('E6'), 'dir' => 'h'])['body']['reason'] === 'badShip');
check('A DAMAGED HULL IS PINNED',
    act($m, $mover, ['kind' => 'reposition', 'ship' => 'carrier', 'at' => cell('E6'), 'dir' => 'h'])['body']['reason'] === 'damaged');
$moveRes = act($m, $mover, ['kind' => 'reposition', 'ship' => 'destroyer', 'at' => cell('E6'), 'dir' => 'h']);
check('AN UNDAMAGED HULL MAY RUN', $moveRes['status'] === 200, $moveRes['raw']);

$saw = poll($m, $mover === 1 ? 2 : 1, 0);
$moved = array_values(array_filter($saw['body']['events'], static fn ($e) => $e['type'] === 'moved'));
check('A REPOSITION IS ANNOUNCED', count($moved) === 1);
check('A REPOSITION DISCLOSES NOTHING BUT THAT IT HAPPENED',
    array_keys($moved[0]['data']) === ['seat'], json_encode($moved[0]['data']));

// ------------------------------------------------------------------
//  9. The verdict
// ------------------------------------------------------------------

echo "\n9. The verdict\n";

$m = battle();
$mover = turnOf($m);
$other = $mover === 1 ? 2 : 1;
$idle = [cell('J1'), cell('J2'), cell('J3'), cell('J4'), cell('J5'),
         cell('J6'), cell('J7'), cell('J8'), cell('J10'), cell('I10'),
         cell('H10'), cell('G10'), cell('F10'), cell('E10'), cell('D10'),
         cell('C10'), cell('B10')];
foreach (fleetCoords(fleetA()) as $i => $c) {
    act($m, $mover, ['kind' => 'fire', 'at' => $c]);
    if ($i < count($idle)) {
        act($m, $other, ['kind' => 'fire', 'at' => $idle[$i]]);
    }
}
$end = poll($m, $mover)['body'];
check('SINKING THE LAST HULL ENDS THE MATCH', $end['room']['status'] === 'over');
check('THE VERDICT NAMES THE SIDE THAT DID IT',
    $end['room']['outcome'] === ($mover === 1 ? 'p1' : 'p2'), (string) $end['room']['outcome']);
check('THE WIN IS TALLIED ON THE SEAT', (int) $end['you']['wins'] === 1);
check('A MOVE AFTER THE VERDICT IS REFUSED',
    act($m, $other, ['kind' => 'fire', 'at' => cell('A10')])['body']['reason'] === 'over');

$loser = poll($m, $other);
check('THE LOSER FLEET IS STILL NOT DISCLOSED AT THE VERDICT',
    !array_key_exists('fleet', $loser['body']['enemy']), 'the winner fleet leaked after the match');

api('again', ['code' => $m['code'], 'token' => $m[$mover]['token']]);
check('ONE SIDE WANTING ANOTHER IS NOT ENOUGH', poll($m, $mover)['body']['room']['status'] === 'over');
api('again', ['code' => $m['code'], 'token' => $m[$other]['token']]);
$rematch = poll($m, $mover)['body'];
check('BOTH SIDES WANTING ANOTHER LAYS FRESH FLEETS', $rematch['room']['status'] === 'place');
check('A REMATCH CLEARS THE PLOTS', substr_count($rematch['you']['grid'], '.') === 100);
check('A REMATCH CLEARS THE READINGS', $rematch['you']['intel'] === []);
check('THE OTHER SIDE OPENS THE REMATCH', (int) $rematch['room']['starter'] !== $mover);
check('THE SERIES TALLY SURVIVES A REMATCH', (int) $rematch['you']['wins'] === 1);

// ------------------------------------------------------------------
//  10. Presence, reclaim and abandonment
// ------------------------------------------------------------------

echo "\n10. Presence\n";

$m = battle();
$bad = api('poll', ['code' => $m['code'], 'token' => str_repeat('f', 32), 'since' => 0]);
check('A TOKEN THAT NAMES NO SEAT IS 401', $bad['status'] === 401);
check('A MALFORMED TOKEN IS 401 TOO',
    api('poll', ['code' => $m['code'], 'token' => 'nope', 'since' => 0])['status'] === 401);

$seats = api('seats', ['code' => $m['code']]);
check('SEATS LISTS BOTH PLAYERS WITHOUT A TOKEN', count($seats['body']['seats']) === 2);
check('SEATS DISCLOSES NO PLOT AND NO FLEET',
    !str_contains($seats['raw'], 'grid') && !str_contains($seats['raw'], 'carrier'));
check('A SEAT SOMEBODY IS SITTING IN CANNOT BE CLAIMED',
    api('reclaim', ['code' => $m['code'], 'seat' => 1])['status'] === 409);

// Time travel rather than sleeping: backdate the row instead.
$pdo->prepare(
    'UPDATE battleship_players p JOIN battleship_rooms r ON r.id = p.room_id
     SET p.last_seen = NOW() - INTERVAL 60 SECOND WHERE r.code = ? AND p.seat = 1'
)->execute([$m['code']]);
$claim = api('reclaim', ['code' => $m['code'], 'seat' => 1]);
check('AN IDLE SEAT CAN BE RECLAIMED', $claim['status'] === 200
    && preg_match('/^[a-f0-9]{32}$/', $claim['body']['token']) === 1, $claim['raw']);
check('RECLAIMING EVICTS THE OLD PHONE',
    api('poll', ['code' => $m['code'], 'token' => $m[1]['token'], 'since' => 0])['status'] === 401);

$m = battle();
api('leave', ['code' => $m['code'], 'token' => $m[2]['token']]);
$voided = poll($m, 1)['body'];
check('LOSING A SEAT VOIDS THE MATCH BACK TO THE LOBBY', $voided['room']['status'] === 'lobby');
check('A VOIDED MATCH CLEARS THE PLOTS', substr_count($voided['you']['grid'], '.') === 100);
check('THE ABANDONMENT IS ANNOUNCED',
    in_array('abandon', array_column(poll($m, 1, 0)['body']['events'], 'type'), true));

// ------------------------------------------------------------------
//  11. Transport
// ------------------------------------------------------------------

echo "\n11. Transport\n";

$headers = [];
$ctx = stream_context_create(['http' => ['method' => 'GET', 'ignore_errors' => true, 'timeout' => 5]]);
@file_get_contents(API . '?action=poll', false, $ctx);
$headers = $http_response_header ?? [];
$has = static fn (string $needle) => (bool) count(array_filter(
    $headers,
    static fn ($h) => stripos($h, $needle) === 0
));
check('A GET IS REFUSED, THE API IS POST ONLY',
    (bool) count(array_filter($headers, static fn ($h) => str_contains($h, '405'))));
check('RESPONSES ARE NO-STORE', $has('Cache-Control: no-store'));
check('NO WILDCARD CORS ON A GAME ENDPOINT',
    !$has('Access-Control-Allow-Origin'), 'wildcard CORS has no business here');

$raw = file_get_contents(API . '?action=create', false, stream_context_create(['http' => [
    'method' => 'POST', 'ignore_errors' => true, 'timeout' => 5,
    'header' => 'Content-Type: application/x-www-form-urlencoded', 'content' => 'name=Hornet',
]]));
$status = 0;
foreach ($http_response_header ?? [] as $h) {
    if (preg_match('#^HTTP/\S+\s+(\d{3})#', $h, $mm)) {
        $status = (int) $mm[1];
    }
}
check('A NON-JSON BODY IS 415, THE CSRF BACKSTOP', $status === 415, "status $status");
check('AN UNKNOWN ACTION IS 400', api('nonsense', [])['status'] === 400);
check('A NAME THAT IS TOO LONG IS REFUSED',
    api('create', ['name' => str_repeat('x', 21)])['status'] === 400);
check('A ROOM CODE THAT IS NOT FOUR LETTERS IS REFUSED',
    api('join', ['code' => 'ABC', 'name' => 'Hornet'])['status'] === 400);
check('AN UNKNOWN ROOM IS 404',
    api('join', ['code' => 'ZZZZ', 'name' => 'Hornet'])['status'] === 404);

// ------------------------------------------------------------------
//  12. The record card
// ------------------------------------------------------------------

echo "\n12. The record card\n";

$anon = api('record', []);
check('A VISITOR WITH NO ACCOUNT GETS AN EMPTY CARD, NOT A 401',
    $anon['status'] === 200 && $anon['body']['viewer'] === null && $anon['body']['records'] === [],
    $anon['raw']);

echo "\n$passed passed, $failed failed\n";
exit($failed === 0 ? 0 : 1);
