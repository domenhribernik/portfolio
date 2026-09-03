<?php
declare(strict_types=1);
define('SECURE_ACCESS', true);

header('Content-Type: application/json; charset=utf-8');
// Per-room realtime state: never cache.
header('Cache-Control: no-store');
// Deliberately no Access-Control-Allow-Origin: consumers are same-origin only.

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

require_once __DIR__ . '/../config/dev-mode.php';
require_once __DIR__ . '/../config/database.php';
// Auth is included but NEVER gated. Play is anonymous token seats, exactly
// like spy and seam. currentUser() is consulted in two places and two only:
// to stamp battleship_players.user_id when whoever sat down happened to be
// signed in, and to read that seat's own record card back. There is no
// requireLogin anywhere in this file, and there must not be one: the whole
// point of a four-letter code is that you can send it to somebody.
require_once __DIR__ . '/../config/auth.php';

// ------------------------------------------------------------------
//  THE TWO RULES THIS FILE EXISTS TO ENFORCE
//
//  1. THE SERVER OWNS BOTH PLOTS. A client sends a coordinate. It never
//     sends a hit, a sink, a salvage total or an outcome, and anything of
//     that kind arriving in a body is read straight past.
//  2. A FLEET IS A SECRET. fleet, decoys and every sonar reading leave this
//     file in exactly one place: the `you` block of their own owner's poll.
//     youPayload() and enemyPayload() below are the only two functions that
//     turn a seat into JSON, and enemyPayload builds up from the shot record
//     rather than filtering down from the row, so a secret added later
//     cannot leak by being forgotten in a blacklist.
// ------------------------------------------------------------------

// Catch fatal errors (e.g. out-of-memory) that bypass try-catch
register_shutdown_function(function () {
    global $DEV_MODE;
    $err = error_get_last();
    if ($err && in_array($err['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true)) {
        http_response_code(500);
        $msg = ($DEV_MODE ?? false)
            ? 'Fatal error: ' . $err['message'] . ' [' . basename($err['file']) . ':' . $err['line'] . ']'
            : 'Internal server error';
        echo json_encode(['error' => $msg], JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    }
});

// ------------------------------------------------------------------
//  Constants. Every one of these is MIRRORED in views/battleship/logic.js.
//  Change them in both: tests/battleship-logic.test.mjs reads this file and
//  fails if the two halves drift, because a client that draws a different
//  price than the server charges is a desync nothing else catches.
// ------------------------------------------------------------------

// No vowels: codes can never spell words, and there are no 0/O 1/I lookalikes.
const CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
const SIZE = 10;
const CELLS = 100;
// carrier:5, battleship:4, cruiser:3, submarine:3, destroyer:2 = 17 cells.
const FLEET_SPEC = 'carrier:5,battleship:4,cruiser:3,submarine:3,destroyer:2';
const EMPTY_GRID = '....................................................................................................';

const SALVAGE_CAP = 10;
const SALVAGE_HIT_DEALT = 1;
const SALVAGE_HIT_TAKEN = 1;
const SALVAGE_WRECK_PER_CELL = 2;
const SALVAGE_SECOND_MOVER = 1;
const DECOY_MAX = 2;

const COST_SONAR = 2;
const COST_DECOY = 3;
const COST_BARRAGE = 4;
const COST_REPOSITION = 3;
const COST_DEPTH_CHARGE = 8;

// How many of your OWN hulls must be on the bottom before a tool opens. This,
// not the salvage economy, is the comeback engine. See the long note in
// views/battleship/logic.js for why paying the losing side more currency did
// not work and this does.
const UNLOCK_SONAR = 0;
const UNLOCK_DECOY = 0;
const UNLOCK_BARRAGE = 1;
const UNLOCK_REPOSITION = 1;
const UNLOCK_DEPTH_CHARGE = 2;

const ROOM_CAP = 2;
// Rooms idle this long are purged whenever someone opens a new one.
const IDLE_ROOM_HOURS = 6;
// Events per poll page; a client that gets a full page polls again at once.
const EVENT_PAGE = 200;
const RECLAIM_IDLE_SECONDS = 20;
const ONLINE_SECONDS = 25;
const SWEEP_MINUTES = 15;
const RECORD_PAGE = 20;

/** @return array<string,int> ship key => hull length, in placement order. */
function fleetSpec(): array
{
    $out = [];
    foreach (explode(',', FLEET_SPEC) as $pair) {
        [$key, $len] = explode(':', $pair);
        $out[$key] = (int) $len;
    }
    return $out;
}

function costOf(string $kind): int
{
    return [
        'sonar' => COST_SONAR,
        'decoy' => COST_DECOY,
        'barrage' => COST_BARRAGE,
        'reposition' => COST_REPOSITION,
        'depthCharge' => COST_DEPTH_CHARGE,
    ][$kind] ?? 0;
}

function unlockOf(string $kind): int
{
    return [
        'sonar' => UNLOCK_SONAR,
        'decoy' => UNLOCK_DECOY,
        'barrage' => UNLOCK_BARRAGE,
        'reposition' => UNLOCK_REPOSITION,
        'depthCharge' => UNLOCK_DEPTH_CHARGE,
    ][$kind] ?? 99;
}

// ------------------------------------------------------------------
//  Dispatch
// ------------------------------------------------------------------

try {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        sendError('Method not allowed', 405);
    }
    $body = jsonBody();
    switch ($_GET['action'] ?? '') {
        case 'create':
            createRoom($body);
            break;
        case 'join':
            joinRoom($body);
            break;
        case 'seats':
            listSeats($body);
            break;
        case 'reclaim':
            reclaimSeat($body);
            break;
        case 'place':
            postPlacement($body);
            break;
        case 'poll':
            pollRoom($body);
            break;
        case 'act':
            postAction($body);
            break;
        case 'again':
            postAgain($body);
            break;
        case 'leave':
            leaveRoom($body);
            break;
        case 'record':
            records($body);
            break;
        default:
            sendError('Unknown action', 400);
    }
} catch (InvalidArgumentException $e) {
    sendError($e->getMessage(), 400);
} catch (\Throwable $e) {
    global $DEV_MODE;
    error_log('Battleship controller error: ' . $e->getMessage() . ' in ' . $e->getFile() . ':' . $e->getLine());
    $msg = ($DEV_MODE ?? false)
        ? get_class($e) . ': ' . $e->getMessage() . ' [' . basename($e->getFile()) . ':' . $e->getLine() . ']'
        : 'Internal server error';
    sendError($msg, 500);
}

// ------------------------------------------------------------------
//  The rules. This is the authority.
//
//  views/battleship/logic.js runs the same reasoning so the page can preview
//  a shot, grey out a tool nobody can afford and play the solo game. Its
//  answers count for nothing here: every one of these functions reads the
//  stored row and recomputes from it.
// ------------------------------------------------------------------

function onPlot(mixed $cell): bool
{
    return is_int($cell) && $cell >= 0 && $cell < CELLS;
}

/** The cells a ship covers, running right ('h') or down ('v') from its head. */
function shipCells(array $ship): array
{
    $len = fleetSpec()[$ship['key']] ?? 0;
    $step = $ship['dir'] === 'v' ? SIZE : 1;
    $out = [];
    for ($i = 0; $i < $len; $i++) {
        $out[] = $ship['at'] + $i * $step;
    }
    return $out;
}

/** The three by three around a cell, clipped at the edges rather than wrapped. */
function blockCells(int $at): array
{
    if (!onPlot($at)) {
        return [];
    }
    $row = intdiv($at, SIZE);
    $col = $at % SIZE;
    $out = [];
    for ($r = $row - 1; $r <= $row + 1; $r++) {
        for ($c = $col - 1; $c <= $col + 1; $c++) {
            if ($r >= 0 && $r < SIZE && $c >= 0 && $c < SIZE) {
                $out[] = $r * SIZE + $c;
            }
        }
    }
    return $out;
}

/** Three adjacent cells from $at, or null if they would leave the row/column. */
function barrageCells(int $at, string $dir): ?array
{
    if (!onPlot($at) || ($dir !== 'h' && $dir !== 'v')) {
        return null;
    }
    if ($dir === 'h' && ($at % SIZE) + 3 > SIZE) {
        return null;
    }
    if ($dir === 'v' && intdiv($at, SIZE) + 3 > SIZE) {
        return null;
    }
    $step = $dir === 'v' ? SIZE : 1;
    return [$at, $at + $step, $at + 2 * $step];
}

/**
 * Why this fleet may not be laid, or null. Ships may touch: adjacency is a
 * placement strategy, not an illegal move.
 */
function placementError(mixed $fleet): ?string
{
    $spec = fleetSpec();
    if (!is_array($fleet) || count($fleet) !== count($spec)) {
        return 'badFleet';
    }
    $wanted = array_keys($spec);
    sort($wanted);
    $given = [];
    foreach ($fleet as $s) {
        if (!is_array($s) || !isset($s['key']) || !is_string($s['key'])) {
            return 'badFleet';
        }
        $given[] = $s['key'];
    }
    sort($given);
    if ($wanted !== $given) {
        return 'badFleet';
    }

    $taken = [];
    foreach ($fleet as $s) {
        // json_decode gives ints for whole numbers, so anything else here is
        // a client that made something up.
        if (!isset($s['at']) || !is_int($s['at']) || !onPlot($s['at'])) {
            return 'offPlot';
        }
        if (!isset($s['dir']) || ($s['dir'] !== 'h' && $s['dir'] !== 'v')) {
            return 'offPlot';
        }
        $len = $spec[$s['key']];
        // A horizontal ship must stay on its own row; a bare index + 1 loop
        // would wrap onto the next one and look perfectly legal.
        if ($s['dir'] === 'h' && ($s['at'] % SIZE) + $len > SIZE) {
            return 'offPlot';
        }
        if ($s['dir'] === 'v' && intdiv($s['at'], SIZE) + $len > SIZE) {
            return 'offPlot';
        }
        foreach (shipCells($s) as $c) {
            if (isset($taken[$c])) {
                return 'overlap';
            }
            $taken[$c] = true;
        }
    }
    return null;
}

/** The ship of $side covering $cell, or null. */
function shipAt(array $side, int $cell): ?array
{
    foreach ($side['fleet'] as $s) {
        if (in_array($cell, shipCells($s), true)) {
            return $s;
        }
    }
    return null;
}

/** The keys of $side's ships that have taken a hit on every one of their cells. */
function sunkShips(array $side): array
{
    $out = [];
    foreach ($side['fleet'] as $s) {
        $down = true;
        foreach (shipCells($s) as $c) {
            if ($side['grid'][$c] !== 'x' && $side['grid'][$c] !== 's') {
                $down = false;
                break;
            }
        }
        if ($down) {
            $out[] = $s['key'];
        }
    }
    return $out;
}

function setMark(string $grid, int $cell, string $mark): string
{
    $grid[$cell] = $mark;
    return $grid;
}

/**
 * Resolve one shell against $side. Returns miss | hit | sunk | decoy | blast,
 * or null when the cell was already spent.
 *
 * $survey is false for area fire: a blast damages what it touches but does NOT
 * plot the water it churns, so those cells still have to be searched properly.
 * The search is the bottleneck in battleship, not the damage, so a weapon that
 * also cleared nine cells of the search would be a pure rate multiplier.
 */
function strike(array &$side, int $cell, bool $survey): ?string
{
    if ($side['grid'][$cell] !== '.') {
        return null;
    }

    $decoyAt = array_search($cell, $side['decoys'], true);
    if ($decoyAt !== false) {
        array_splice($side['decoys'], (int) $decoyAt, 1);
        $side['grid'] = setMark($side['grid'], $cell, 'D');
        return 'decoy';
    }

    $hull = shipAt($side, $cell);
    if ($hull === null) {
        if (!$survey) {
            return 'blast';
        }
        $side['grid'] = setMark($side['grid'], $cell, 'o');
        return 'miss';
    }

    $side['grid'] = setMark($side['grid'], $cell, 'x');
    $cells = shipCells($hull);
    foreach ($cells as $c) {
        if ($side['grid'][$c] !== 'x' && $side['grid'][$c] !== 's') {
            return 'hit';
        }
    }
    // Restrike the whole hull as sunk, so the plot shows a wreck rather than
    // five unrelated hits the reader still has to join up.
    foreach ($cells as $c) {
        $side['grid'] = setMark($side['grid'], $c, 's');
    }
    return 'sunk';
}

/**
 * Why $seat may not take this action, or null. Reason codes are refuse.* keys
 * in views/battleship/i18n/ui.json, and logic.js returns the same ones.
 */
function actionError(array $room, array $sides, int $seat, array $action): ?string
{
    if ($room['status'] !== 'battle' || $room['outcome'] !== null) {
        return 'over';
    }
    if ((int) $room['turn'] !== $seat) {
        return 'notYourTurn';
    }
    $kind = $action['kind'] ?? '';
    $mine = $sides[$seat];
    $foe = $sides[$seat === 1 ? 2 : 1];

    if ($kind === 'fire') {
        if (!onPlot($action['at'] ?? null)) {
            return 'offPlot';
        }
        return $foe['grid'][$action['at']] === '.' ? null : 'spent';
    }

    if (!in_array($kind, ['sonar', 'decoy', 'barrage', 'reposition', 'depthCharge'], true)) {
        return 'badAction';
    }
    if (count(sunkShips($mine)) < unlockOf($kind)) {
        return 'locked';
    }
    if ($mine['salvage'] < costOf($kind)) {
        return 'broke';
    }

    switch ($kind) {
        case 'sonar':
        case 'depthCharge':
            return onPlot($action['at'] ?? null) ? null : 'offPlot';

        case 'barrage':
            return barrageCells((int) ($action['at'] ?? -1), (string) ($action['dir'] ?? '')) !== null
                ? null : 'offPlot';

        case 'decoy':
            if (!onPlot($action['at'] ?? null)) {
                return 'offPlot';
            }
            if (count($mine['decoys']) >= DECOY_MAX) {
                return 'tooManyDecoys';
            }
            if ($mine['grid'][$action['at']] !== '.') {
                return 'spent';
            }
            // A buoy sits on open water. On a hull it would be a second life
            // for a cell that already has one.
            if (shipAt($mine, $action['at']) !== null) {
                return 'occupied';
            }
            if (in_array($action['at'], $mine['decoys'], true)) {
                return 'occupied';
            }
            return null;

        case 'reposition':
            $key = $action['ship'] ?? '';
            $hull = null;
            $rest = [];
            foreach ($mine['fleet'] as $s) {
                if ($s['key'] === $key) {
                    $hull = $s;
                } else {
                    $rest[] = $s;
                }
            }
            if ($hull === null) {
                return 'badShip';
            }
            // A hull the enemy has already touched is pinned. Slipping out of
            // a hunt you are losing would make every deduction worthless.
            foreach (shipCells($hull) as $c) {
                if ($mine['grid'][$c] !== '.') {
                    return 'damaged';
                }
            }
            if (!onPlot($action['at'] ?? null)) {
                return 'offPlot';
            }
            $moved = ['key' => $key, 'at' => $action['at'], 'dir' => $action['dir'] ?? ''];
            $err = placementError(array_merge([$moved], $rest));
            if ($err !== null) {
                return $err === 'overlap' ? 'overlap' : 'offPlot';
            }
            // The berth must be virgin water: a plotted miss must never
            // quietly stop being true under the enemy who plotted it.
            foreach (shipCells($moved) as $c) {
                if ($mine['grid'][$c] !== '.') {
                    return 'searched';
                }
                if (in_array($c, $mine['decoys'], true)) {
                    return 'occupied';
                }
            }
            return null;
    }
    return 'badAction';
}

/**
 * Apply an action to $sides in place and hand back the public report plus the
 * private reading, if any. Assumes actionError has already passed.
 */
function applyAction(array &$sides, int $seat, array $action): array
{
    $foeSeat = $seat === 1 ? 2 : 1;
    $mine = &$sides[$seat];
    $theirs = &$sides[$foeSeat];
    $kind = (string) $action['kind'];

    // A buoy of mine that popped last turn stops pretending now, so the reveal
    // always lands exactly one turn after the shot that found it.
    $mine['grid'] = str_replace('D', 'd', $mine['grid']);

    // Only aimed fire refuels the gunner. Area fire pays the fleet it lands on
    // and pays the gunner nothing, so heavy weapons cannot refuel themselves.
    $paysFirer = $kind !== 'barrage' && $kind !== 'depthCharge';

    $report = ['kind' => $kind, 'cells' => [], 'sunk' => [], 'moved' => false, 'swept' => null];
    $intel = null;
    $gainMine = 0;
    $gainTheirs = 0;

    $resolve = function (array $cells) use (&$theirs, &$mine, &$report, &$gainMine, &$gainTheirs, $paysFirer): void {
        foreach ($cells as $cell) {
            $result = strike($theirs, $cell, $paysFirer);
            if ($result === null) {
                continue;
            }
            $report['cells'][] = ['cell' => $cell, 'result' => $result];
            $mine['shots']++;
            if ($result === 'miss' || $result === 'blast') {
                continue;
            }
            $mine['hits']++;
            // A decoy pays out exactly like a hull. If it did not, the public
            // tote board would give the bluff away on the very next glance.
            if ($paysFirer) {
                $gainMine += SALVAGE_HIT_DEALT;
            }
            $gainTheirs += SALVAGE_HIT_TAKEN;
            if ($result === 'sunk') {
                $hull = shipAt($theirs, $cell);
                $gainTheirs += SALVAGE_WRECK_PER_CELL * count(shipCells($hull));
                $report['sunk'][] = $hull['key'];
            }
        }
    };

    switch ($kind) {
        case 'fire':
            $resolve([(int) $action['at']]);
            break;

        case 'sonar':
            $at = (int) $action['at'];
            $count = 0;
            foreach (blockCells($at) as $c) {
                if (shipAt($theirs, $c) !== null) {
                    $count++;
                }
            }
            // The reading is the caller's alone. WHERE they swept is not: a
            // sweep lights the water, and the fleet under it can see that much.
            $intel = ['kind' => 'sonar', 'at' => $at, 'reading' => $count];
            $report['swept'] = $at;
            $theirs['swept'][] = $at;
            break;

        case 'decoy':
            $mine['decoys'][] = (int) $action['at'];
            break;

        case 'barrage':
            $resolve(barrageCells((int) $action['at'], (string) $action['dir']));
            break;

        case 'reposition':
            foreach ($mine['fleet'] as $i => $s) {
                if ($s['key'] === $action['ship']) {
                    $mine['fleet'][$i] = [
                        'key' => $s['key'],
                        'at' => (int) $action['at'],
                        'dir' => (string) $action['dir'],
                    ];
                }
            }
            $report['moved'] = true;
            break;

        case 'depthCharge':
            $resolve(blockCells((int) $action['at']));
            break;
    }

    $cost = costOf($kind);
    $mine['spent'] += $cost;
    $mine['salvage'] = max(0, min(SALVAGE_CAP, $mine['salvage'] - $cost + $gainMine));
    $theirs['salvage'] = max(0, min(SALVAGE_CAP, $theirs['salvage'] + $gainTheirs));

    return ['report' => $report, 'intel' => $intel];
}

// ------------------------------------------------------------------
//  Rows in, sides out
// ------------------------------------------------------------------

/** Turn a battleship_players row into the working shape the rules read. */
function sideOf(array $row): array
{
    return [
        'id' => (int) $row['id'],
        'seat' => (int) $row['seat'],
        'fleet' => $row['fleet'] !== null ? (json_decode($row['fleet'], true) ?: []) : [],
        'grid' => $row['grid'],
        'decoys' => cellList($row['decoys']),
        'swept' => cellList($row['swept']),
        'salvage' => (int) $row['salvage'],
        'spent' => (int) $row['salvage_spent'],
        'shots' => (int) $row['shots_fired'],
        'hits' => (int) $row['shots_hit'],
    ];
}

function cellList(?string $raw): array
{
    if ($raw === null || $raw === '') {
        return [];
    }
    return array_map('intval', explode(',', $raw));
}

function packCells(array $cells): ?string
{
    return $cells === [] ? null : implode(',', $cells);
}

function writeSide(PDO $db, array $side): void
{
    $db->prepare(
        'UPDATE battleship_players SET fleet = ?, grid = ?, decoys = ?, swept = ?, salvage = ?,
                salvage_spent = ?, shots_fired = ?, shots_hit = ? WHERE id = ?'
    )->execute([
        $side['fleet'] === [] ? null : json_encode($side['fleet']),
        $side['grid'],
        packCells($side['decoys']),
        packCells($side['swept']),
        $side['salvage'],
        $side['spent'],
        $side['shots'],
        $side['hits'],
        $side['id'],
    ]);
}

// ------------------------------------------------------------------
//  THE ONLY TWO FUNCTIONS THAT TURN A SEAT INTO JSON
// ------------------------------------------------------------------

/** Everything this seat is allowed to know about itself. Secrets included. */
function youPayload(array $side, array $row, array $intel): array
{
    return [
        'id' => $side['id'],
        'seat' => $side['seat'],
        'host' => (bool) $row['is_host'],
        'name' => $row['name'],
        'wins' => (int) $row['wins'],
        'wantsAgain' => (bool) $row['wants_again'],
        'fleet' => $side['fleet'],
        'grid' => $side['grid'],
        'decoys' => $side['decoys'],
        'swept' => $side['swept'],
        'salvage' => $side['salvage'],
        'sunk' => sunkShips($side),
        'shots' => $side['shots'],
        'hits' => $side['hits'],
        'spent' => $side['spent'],
        'intel' => $intel,
    ];
}

/**
 * Everything this seat is allowed to know about the OTHER one.
 *
 * Built up from the shot record rather than filtered down from the row. That
 * is the whole trick: a secret added to battleship_players later cannot leak
 * here by being forgotten in a blacklist, because there is no blacklist. If
 * you add a field to this array, you are disclosing it on purpose.
 */
function enemyPayload(array $side, array $row): array
{
    return [
        'id' => $side['id'],
        'seat' => $side['seat'],
        'name' => $row['name'],
        'wins' => (int) $row['wins'],
        'wantsAgain' => (bool) $row['wants_again'],
        'online' => strtotime($row['last_seen']) > time() - ONLINE_SECONDS,
        'ready' => $row['fleet'] !== null,
        // A buoy that popped last turn still reads as a hit. It confesses on
        // its owner's next action, not on the shooter's next poll.
        'grid' => str_replace('D', 'x', $side['grid']),
        'sunk' => sunkShips($side),
        // The tote board is public on purpose: reading what the other side can
        // afford, and guessing what they are saving for, is half the game.
        'salvage' => $side['salvage'],
    ];
}

function roomSummary(array $room): array
{
    return [
        'code' => $room['code'],
        'status' => $room['status'],
        'lang' => $room['lang'],
        'turn' => (int) $room['turn'],
        'starter' => (int) $room['starter'],
        'turns' => (int) $room['turns'],
        'outcome' => $room['outcome'],
    ];
}

// ------------------------------------------------------------------
//  Actions
// ------------------------------------------------------------------

function createRoom(array $body): void
{
    $name = validateName($body['name'] ?? null);
    $lang = validateLang($body['lang'] ?? null);
    $db = Database::write();
    $token = bin2hex(random_bytes(16));
    $userId = signedInUserId();

    // The janitor: rooms are throwaway, so the rare create request pays for
    // purging idle ones (deletes cascade to players, events and intel).
    $db->exec('DELETE FROM battleship_rooms WHERE last_active < NOW() - INTERVAL ' . IDLE_ROOM_HOURS . ' HOUR');

    for ($attempt = 0; $attempt < 6; $attempt++) {
        $code = roomCode();
        try {
            $db->beginTransaction();
            $db->prepare('INSERT INTO battleship_rooms (code, lang) VALUES (?, ?)')->execute([$code, $lang]);
            $roomId = (int) $db->lastInsertId();
            $db->prepare(
                'INSERT INTO battleship_players (room_id, token_hash, user_id, name, seat, is_host, grid)
                 VALUES (?, ?, ?, ?, 1, 1, ?)'
            )->execute([$roomId, hash('sha256', $token), $userId, $name, EMPTY_GRID]);
            $playerId = (int) $db->lastInsertId();
            $db->commit();
            sendJson([
                'code' => $code,
                'token' => $token,
                'you' => ['id' => $playerId, 'seat' => 1, 'host' => true],
            ], 201);
        } catch (PDOException $e) {
            if ($db->inTransaction()) {
                $db->rollBack();
            }
            if ($attempt === 5 || !str_contains($e->getMessage(), '1062')) {
                throw $e;
            }
        }
    }
    sendError('Could not open a room', 500);
}

function joinRoom(array $body): void
{
    $code = validateCode($body['code'] ?? null);
    $name = validateName($body['name'] ?? null);
    $db = Database::write();
    $token = bin2hex(random_bytes(16));
    $userId = signedInUserId();

    $db->beginTransaction();
    try {
        // The room row is locked for the whole transaction, so two people
        // opening the same link at once cannot both get seat 2.
        $stmt = $db->prepare('SELECT * FROM battleship_rooms WHERE code = ? FOR UPDATE');
        $stmt->execute([$code]);
        $room = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$room) {
            $db->rollBack();
            sendError('No such room', 404);
        }
        if ($room['status'] !== 'lobby') {
            $db->rollBack();
            sendError('That room is already at sea', 409, ['reclaim' => true]);
        }

        $seated = $db->prepare('SELECT name, seat FROM battleship_players WHERE room_id = ? AND left_at IS NULL');
        $seated->execute([$room['id']]);
        $rows = $seated->fetchAll(PDO::FETCH_ASSOC);
        foreach ($rows as $r) {
            if (mb_strtolower($r['name']) === mb_strtolower($name)) {
                $db->rollBack();
                sendError('That name is taken in this room', 409, ['reason' => 'nameTaken']);
            }
        }
        if (count($rows) >= ROOM_CAP) {
            $db->rollBack();
            sendError('That room is full', 409, ['reclaim' => true]);
        }

        $taken = array_map(static fn ($r) => (int) $r['seat'], $rows);
        $seat = in_array(1, $taken, true) ? 2 : 1;
        $db->prepare(
            'INSERT INTO battleship_players (room_id, token_hash, user_id, name, seat, is_host, grid)
             VALUES (?, ?, ?, ?, ?, 0, ?)'
        )->execute([$room['id'], hash('sha256', $token), $userId, $name, $seat, EMPTY_GRID]);
        $playerId = (int) $db->lastInsertId();

        // Joining starts the placement phase. There is no host "start" button:
        // the second person arriving IS the start, same as seam.
        if (count($rows) + 1 >= ROOM_CAP) {
            $starter = random_int(1, 2);
            $db->prepare('UPDATE battleship_rooms SET status = ?, starter = ?, turn = ? WHERE id = ?')
               ->execute(['place', $starter, $starter, $room['id']]);
            logEvent($db, (int) $room['id'], null, 'placing', ['starter' => $starter]);
        }
        touchRoom($db, (int) $room['id']);
        $db->commit();

        sendJson([
            'code' => $code,
            'token' => $token,
            'you' => ['id' => $playerId, 'seat' => $seat, 'host' => false],
        ], 201);
    } catch (\Throwable $e) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }
        throw $e;
    }
}

function listSeats(array $body): void
{
    // The one tokenless endpoint, so a phone that lost its token can pick its
    // seat back. It discloses names and idleness, and nothing about a plot.
    $code = validateCode($body['code'] ?? null);
    $db = Database::read();
    $stmt = $db->prepare(
        'SELECT p.id, p.name, p.seat, p.is_host,
                TIMESTAMPDIFF(SECOND, p.last_seen, NOW()) AS idle
         FROM battleship_players p
         JOIN battleship_rooms r ON r.id = p.room_id
         WHERE r.code = ? AND p.left_at IS NULL ORDER BY p.seat'
    );
    $stmt->execute([$code]);
    $seats = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
        $seats[] = [
            'id' => (int) $r['id'],
            'name' => $r['name'],
            'seat' => (int) $r['seat'],
            'host' => (bool) $r['is_host'],
            'claimable' => (int) $r['idle'] >= RECLAIM_IDLE_SECONDS,
        ];
    }
    sendJson(['seats' => $seats]);
}

function reclaimSeat(array $body): void
{
    $code = validateCode($body['code'] ?? null);
    $seat = $body['seat'] ?? null;
    if (!is_int($seat) || $seat < 1 || $seat > ROOM_CAP) {
        sendError('No such seat', 400);
    }
    $db = Database::write();
    $token = bin2hex(random_bytes(16));

    $db->beginTransaction();
    try {
        $stmt = $db->prepare('SELECT * FROM battleship_rooms WHERE code = ? FOR UPDATE');
        $stmt->execute([$code]);
        $room = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$room) {
            $db->rollBack();
            sendError('No such room', 404);
        }
        $stmt = $db->prepare(
            'SELECT id, TIMESTAMPDIFF(SECOND, last_seen, NOW()) AS idle
             FROM battleship_players WHERE room_id = ? AND seat = ? AND left_at IS NULL'
        );
        $stmt->execute([$room['id'], $seat]);
        $player = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$player) {
            $db->rollBack();
            sendError('No such seat', 404);
        }
        if ((int) $player['idle'] < RECLAIM_IDLE_SECONDS) {
            $db->rollBack();
            sendError('Somebody is still sitting there', 409, ['reason' => 'seatBusy']);
        }
        // Overwriting the hash evicts the old phone: its next poll 401s. This
        // hands over a fleet, so it is deliberately gated on real idleness.
        $db->prepare('UPDATE battleship_players SET token_hash = ?, last_seen = NOW() WHERE id = ?')
           ->execute([hash('sha256', $token), $player['id']]);
        $db->commit();
        sendJson(['code' => $code, 'token' => $token, 'you' => ['id' => (int) $player['id'], 'seat' => $seat]]);
    } catch (\Throwable $e) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }
        throw $e;
    }
}

function postPlacement(array $body): void
{
    $db = Database::write();
    [$room, $me] = seatByToken($db, $body, true);
    if ($room['status'] !== 'place') {
        sendError('Not laying fleets right now', 409, ['reason' => 'notPlacing']);
    }
    // Read the fleet, and nothing else. A body that also carries a grid, a
    // salvage total or an outcome is read straight past: the server owns both.
    $err = placementError($body['fleet'] ?? null);
    if ($err !== null) {
        sendError('That fleet cannot be laid', 400, ['reason' => $err]);
    }
    $fleet = [];
    foreach ($body['fleet'] as $s) {
        $fleet[] = ['key' => $s['key'], 'at' => $s['at'], 'dir' => $s['dir']];
    }

    $db->beginTransaction();
    try {
        $stmt = $db->prepare('SELECT * FROM battleship_rooms WHERE id = ? FOR UPDATE');
        $stmt->execute([$room['id']]);
        $room = $stmt->fetch(PDO::FETCH_ASSOC);
        if ($room['status'] !== 'place') {
            $db->rollBack();
            sendError('Not laying fleets right now', 409, ['reason' => 'notPlacing']);
        }
        $db->prepare('UPDATE battleship_players SET fleet = ?, grid = ? WHERE id = ?')
           ->execute([json_encode($fleet), EMPTY_GRID, $me['id']]);
        // The event says which seat is ready. It could not carry the fleet
        // even if somebody tried: nothing reads it back out of the log.
        logEvent($db, (int) $room['id'], (int) $me['id'], 'placed', ['seat' => (int) $me['seat']]);

        $rows = seatRows($db, (int) $room['id']);
        $ready = 0;
        foreach ($rows as $r) {
            if ($r['fleet'] !== null) {
                $ready++;
            }
        }
        if ($ready >= ROOM_CAP && count($rows) >= ROOM_CAP) {
            $second = (int) $room['starter'] === 1 ? 2 : 1;
            // The only salvage nobody earned: compensation for the first shot.
            $db->prepare('UPDATE battleship_players SET salvage = ? WHERE room_id = ? AND seat = ?')
               ->execute([SALVAGE_SECOND_MOVER, $room['id'], $second]);
            $db->prepare('UPDATE battleship_rooms SET status = ?, turn = ?, turns = 0 WHERE id = ?')
               ->execute(['battle', (int) $room['starter'], $room['id']]);
            logEvent($db, (int) $room['id'], null, 'start', ['starter' => (int) $room['starter']]);
        }
        touchRoom($db, (int) $room['id']);
        $db->commit();
    } catch (\Throwable $e) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }
        throw $e;
    }
    sendJson(['ok' => true]);
}

function postAction(array $body): void
{
    $db = Database::write();
    [$room, $me] = seatByToken($db, $body, true);

    // Read the coordinates, and nothing else. json_decode gives ints for whole
    // numbers, so anything else in these fields is a client that made it up.
    $action = ['kind' => (string) ($body['kind'] ?? '')];
    foreach (['at', 'dir', 'ship'] as $field) {
        if (array_key_exists($field, $body)) {
            $action[$field] = $body[$field];
        }
    }
    if (isset($action['at']) && !is_int($action['at'])) {
        sendError('That is not a cell', 400, ['reason' => 'offPlot']);
    }

    $db->beginTransaction();
    try {
        $stmt = $db->prepare('SELECT * FROM battleship_rooms WHERE id = ? FOR UPDATE');
        $stmt->execute([$room['id']]);
        $room = $stmt->fetch(PDO::FETCH_ASSOC);
        $rows = seatRows($db, (int) $room['id']);
        if (count($rows) < ROOM_CAP) {
            $db->rollBack();
            sendError('The other seat is empty', 409, ['reason' => 'noOpponent']);
        }
        $sides = [];
        $byId = [];
        foreach ($rows as $r) {
            $sides[(int) $r['seat']] = sideOf($r);
            $byId[(int) $r['seat']] = $r;
        }
        $seat = (int) $me['seat'];

        $err = actionError($room, $sides, $seat, $action);
        if ($err !== null) {
            $db->rollBack();
            sendError('That move is refused', $err === 'over' ? 409 : 400, ['reason' => $err]);
        }

        $out = applyAction($sides, $seat, $action);
        $report = $out['report'];
        $foeSeat = $seat === 1 ? 2 : 1;

        writeSide($db, $sides[$seat]);
        writeSide($db, $sides[$foeSeat]);

        if ($out['intel'] !== null) {
            // Into its own table, never into the log.
            $db->prepare(
                'INSERT INTO battleship_intel (room_id, player_id, kind, at_cell, reading) VALUES (?, ?, ?, ?, ?)'
            )->execute([$room['id'], $sides[$seat]['id'], $out['intel']['kind'],
                        $out['intel']['at'], $out['intel']['reading']]);
        }

        if ($report['cells'] !== []) {
            logEvent($db, (int) $room['id'], $sides[$seat]['id'], 'shot', [
                'seat' => $seat,
                'kind' => $report['kind'],
                'cells' => $report['cells'],
                'sunk' => $report['sunk'],
            ]);
        }
        foreach ($report['sunk'] as $key) {
            logEvent($db, (int) $room['id'], null, 'sunk', ['seat' => $foeSeat, 'ship' => $key]);
        }
        if ($report['swept'] !== null) {
            // The block, never the reading. Information costs information.
            logEvent($db, (int) $room['id'], $sides[$seat]['id'], 'swept',
                ['seat' => $seat, 'at' => $report['swept']]);
        }
        if ($report['moved']) {
            // The fact of it, and nothing else. Work out where yourself.
            logEvent($db, (int) $room['id'], $sides[$seat]['id'], 'moved', ['seat' => $seat]);
        }

        $down = count(sunkShips($sides[$foeSeat])) >= count(fleetSpec());
        if ($down) {
            $outcome = $seat === 1 ? 'p1' : 'p2';
            $db->prepare('UPDATE battleship_rooms SET status = ?, outcome = ?, turns = turns + 1 WHERE id = ?')
               ->execute(['over', $outcome, $room['id']]);
            $db->prepare('UPDATE battleship_players SET wins = wins + 1 WHERE id = ?')
               ->execute([$sides[$seat]['id']]);
            logEvent($db, (int) $room['id'], null, 'verdict', ['outcome' => $outcome, 'seat' => $seat]);
            writeRecords($db, $room, $byId, $sides, $seat);
        } else {
            $db->prepare('UPDATE battleship_rooms SET turn = ?, turns = turns + 1 WHERE id = ?')
               ->execute([$foeSeat, $room['id']]);
        }
        touchRoom($db, (int) $room['id']);
        $db->commit();
    } catch (\Throwable $e) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }
        throw $e;
    }
    // The consequence is learned through the poll, the same path the other
    // seat takes. That one rule removes a whole class of divergence bugs.
    sendJson(['ok' => true]);
}

function postAgain(array $body): void
{
    $db = Database::write();
    [$room, $me] = seatByToken($db, $body, true);
    $db->beginTransaction();
    try {
        $stmt = $db->prepare('SELECT * FROM battleship_rooms WHERE id = ? FOR UPDATE');
        $stmt->execute([$room['id']]);
        $room = $stmt->fetch(PDO::FETCH_ASSOC);
        if ($room['status'] !== 'over') {
            $db->rollBack();
            sendError('That match is still running', 409, ['reason' => 'notOver']);
        }
        $db->prepare('UPDATE battleship_players SET wants_again = 1 WHERE id = ?')->execute([$me['id']]);

        $rows = seatRows($db, (int) $room['id']);
        $keen = 0;
        foreach ($rows as $r) {
            if ((int) $r['wants_again'] === 1) {
                $keen++;
            }
        }
        if ($keen >= ROOM_CAP && count($rows) >= ROOM_CAP) {
            // Fresh plots, fresh fleets, and the other seat opens this time.
            $starter = (int) $room['starter'] === 1 ? 2 : 1;
            $db->prepare(
                'UPDATE battleship_players SET fleet = NULL, grid = ?, decoys = NULL, swept = NULL,
                        salvage = 0, salvage_spent = 0, shots_fired = 0, shots_hit = 0, wants_again = 0
                 WHERE room_id = ?'
            )->execute([EMPTY_GRID, $room['id']]);
            $db->prepare('DELETE FROM battleship_intel WHERE room_id = ?')->execute([$room['id']]);
            $db->prepare(
                'UPDATE battleship_rooms SET status = ?, outcome = NULL, starter = ?, turn = ?, turns = 0 WHERE id = ?'
            )->execute(['place', $starter, $starter, $room['id']]);
            logEvent($db, (int) $room['id'], null, 'again', ['starter' => $starter]);
        }
        touchRoom($db, (int) $room['id']);
        $db->commit();
    } catch (\Throwable $e) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }
        throw $e;
    }
    sendJson(['ok' => true]);
}

function leaveRoom(array $body): void
{
    $db = Database::write();
    [$room, $me] = seatByToken($db, $body, false);
    $db->prepare('UPDATE battleship_players SET left_at = NOW() WHERE id = ?')->execute([$me['id']]);
    voidIfAbandoned($db, (int) $room['id']);
    sendJson(['ok' => true]);
}

function pollRoom(array $body): void
{
    $since = $body['since'] ?? 0;
    if (!is_int($since) || $since < 0) {
        $since = 0;
    }
    $db = Database::write();
    [$room, $me] = seatByToken($db, $body, false);

    heartbeat($db, (int) $me['id'], $me['last_seen']);
    sweepSilent($db, (int) $room['id']);
    handOverHost($db, (int) $room['id']);
    voidIfAbandoned($db, (int) $room['id']);

    $stmt = $db->prepare('SELECT * FROM battleship_rooms WHERE id = ?');
    $stmt->execute([$room['id']]);
    $room = $stmt->fetch(PDO::FETCH_ASSOC);

    $rows = seatRows($db, (int) $room['id']);
    $mySeat = (int) $me['seat'];
    $you = null;
    $enemy = null;
    foreach ($rows as $r) {
        $side = sideOf($r);
        if ((int) $r['seat'] === $mySeat) {
            $you = youPayload($side, $r, readIntel($db, (int) $r['id']));
        } else {
            $enemy = enemyPayload($side, $r);
        }
    }

    $stmt = $db->prepare(
        'SELECT id, player_id, type, data FROM battleship_events
         WHERE room_id = ? AND id > ? ORDER BY id LIMIT ' . (EVENT_PAGE + 1)
    );
    $stmt->execute([$room['id'], $since]);
    $raw = $stmt->fetchAll(PDO::FETCH_ASSOC);
    $more = count($raw) > EVENT_PAGE;
    if ($more) {
        array_pop($raw);
    }
    $events = [];
    $last = $since;
    foreach ($raw as $r) {
        $last = (int) $r['id'];
        $events[] = [
            'seq' => (int) $r['id'],
            'player' => $r['player_id'] !== null ? (int) $r['player_id'] : null,
            'type' => $r['type'],
            'data' => $r['data'] !== null ? json_decode($r['data'], true) : null,
        ];
    }

    sendJson([
        'room' => roomSummary($room) + ['seated' => count($rows)],
        'you' => $you,
        'enemy' => $enemy,
        'events' => $events,
        'last' => $last,
        'more' => $more,
    ]);
}

function records(array $body): void
{
    $user = Auth::currentUser();
    if ($user === null) {
        // Not an error: the game is open to everyone, and a visitor with no
        // account simply has no card. The page renders a sign-in prompt.
        sendJson(['viewer' => null, 'records' => []]);
    }
    $db = Database::write();

    // A solo game never touches the server, so its result is self reported.
    // The card labels these practice for exactly that reason.
    if (($body['mode'] ?? null) === 'bot') {
        $result = ($body['result'] ?? '') === 'win' ? 'win' : 'loss';
        $db->prepare(
            'INSERT INTO battleship_records (user_id, mode, result, opponent, turns, shots, hits, salvage_spent)
             VALUES (?, "bot", ?, ?, ?, ?, ?, ?)'
        )->execute([
            (int) $user['id'], $result, mb_substr((string) ($body['opponent'] ?? 'Bot'), 0, 20),
            clampInt($body['turns'] ?? 0), clampInt($body['shots'] ?? 0),
            clampInt($body['hits'] ?? 0), clampInt($body['salvageSpent'] ?? 0),
        ]);
    }

    $stmt = $db->prepare(
        'SELECT mode, result, opponent, turns, shots, hits, salvage_spent, finished_at
         FROM battleship_records WHERE user_id = ? ORDER BY finished_at DESC, id DESC LIMIT ' . RECORD_PAGE
    );
    $stmt->execute([(int) $user['id']]);
    $rows = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
        $rows[] = [
            'mode' => $r['mode'],
            'result' => $r['result'],
            'opponent' => $r['opponent'],
            'turns' => (int) $r['turns'],
            'shots' => (int) $r['shots'],
            'hits' => (int) $r['hits'],
            'salvageSpent' => (int) $r['salvage_spent'],
            'at' => $r['finished_at'],
        ];
    }
    sendJson([
        'viewer' => ['id' => (int) $user['id'], 'name' => $user['display_name'] ?? ''],
        'records' => $rows,
    ]);
}

// ------------------------------------------------------------------
//  Housekeeping. There is no cron: the poll path carries all of it.
// ------------------------------------------------------------------

function heartbeat(PDO $db, int $playerId, string $lastSeen): void
{
    // Only when it is actually stale, so a 900ms poll loop is not also a
    // 900ms write loop.
    if (strtotime($lastSeen) > time() - 10) {
        return;
    }
    $db->prepare('UPDATE battleship_players SET last_seen = NOW() WHERE id = ?')->execute([$playerId]);
}

function sweepSilent(PDO $db, int $roomId): void
{
    $db->prepare(
        'UPDATE battleship_players SET left_at = NOW()
         WHERE room_id = ? AND left_at IS NULL AND last_seen < NOW() - INTERVAL ' . SWEEP_MINUTES . ' MINUTE'
    )->execute([$roomId]);
}

function handOverHost(PDO $db, int $roomId): void
{
    $rows = seatRows($db, $roomId);
    if ($rows === []) {
        return;
    }
    foreach ($rows as $r) {
        if ((int) $r['is_host'] === 1) {
            return;
        }
    }
    $heir = $rows[0];
    $db->prepare('UPDATE battleship_players SET is_host = 1 WHERE id = ?')->execute([$heir['id']]);
    logEvent($db, $roomId, (int) $heir['id'], 'host', ['id' => (int) $heir['id']]);
}

/**
 * A match needs two seats. Losing one voids it back to the lobby, so the
 * shared link still works for whoever turns up next.
 */
function voidIfAbandoned(PDO $db, int $roomId): void
{
    $stmt = $db->prepare('SELECT status FROM battleship_rooms WHERE id = ?');
    $stmt->execute([$roomId]);
    $status = $stmt->fetchColumn();
    if ($status !== 'place' && $status !== 'battle') {
        return;
    }
    if (count(seatRows($db, $roomId)) >= ROOM_CAP) {
        return;
    }
    $db->prepare(
        'UPDATE battleship_players SET fleet = NULL, grid = ?, decoys = NULL, swept = NULL,
                salvage = 0, salvage_spent = 0, shots_fired = 0, shots_hit = 0, wants_again = 0
         WHERE room_id = ?'
    )->execute([EMPTY_GRID, $roomId]);
    $db->prepare('DELETE FROM battleship_intel WHERE room_id = ?')->execute([$roomId]);
    $db->prepare('UPDATE battleship_rooms SET status = "lobby", outcome = NULL, turns = 0 WHERE id = ?')
       ->execute([$roomId]);
    logEvent($db, $roomId, null, 'abandon', []);
}

/** Write the verdict to whichever seats happened to be signed in. */
function writeRecords(PDO $db, array $room, array $byId, array $sides, int $winner): void
{
    foreach ([1, 2] as $seat) {
        $row = $byId[$seat] ?? null;
        if ($row === null || $row['user_id'] === null) {
            continue;
        }
        $foe = $byId[$seat === 1 ? 2 : 1] ?? null;
        $db->prepare(
            'INSERT INTO battleship_records (user_id, mode, result, opponent, turns, shots, hits, salvage_spent)
             VALUES (?, "room", ?, ?, ?, ?, ?, ?)'
        )->execute([
            (int) $row['user_id'],
            $seat === $winner ? 'win' : 'loss',
            $foe['name'] ?? '',
            (int) $room['turns'] + 1,
            $sides[$seat]['shots'],
            $sides[$seat]['hits'],
            $sides[$seat]['spent'],
        ]);
    }
}

// ------------------------------------------------------------------
//  Shared helpers
// ------------------------------------------------------------------

function seatRows(PDO $db, int $roomId): array
{
    $stmt = $db->prepare(
        'SELECT * FROM battleship_players WHERE room_id = ? AND left_at IS NULL ORDER BY seat'
    );
    $stmt->execute([$roomId]);
    return $stmt->fetchAll(PDO::FETCH_ASSOC);
}

function readIntel(PDO $db, int $playerId): array
{
    $stmt = $db->prepare(
        'SELECT kind, at_cell, reading FROM battleship_intel WHERE player_id = ? ORDER BY id'
    );
    $stmt->execute([$playerId]);
    $out = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
        $out[] = ['kind' => $r['kind'], 'at' => (int) $r['at_cell'], 'count' => (int) $r['reading']];
    }
    return $out;
}

/**
 * The room and the seat holding this token. Denies 401 on a token that names
 * no live seat, which is also how an evicted phone learns it was evicted.
 */
function seatByToken(PDO $db, array $body, bool $needsBoth): array
{
    $code = validateCode($body['code'] ?? null);
    $token = $body['token'] ?? null;
    if (!is_string($token) || !preg_match('/^[a-f0-9]{32}$/', $token)) {
        sendError('Not your seat', 401);
    }
    $stmt = $db->prepare(
        'SELECT p.*, r.id AS room_id_, r.code, r.status, r.turn, r.starter, r.outcome, r.lang, r.turns
         FROM battleship_players p JOIN battleship_rooms r ON r.id = p.room_id
         WHERE r.code = ? AND p.token_hash = ? AND p.left_at IS NULL'
    );
    $stmt->execute([$code, hash('sha256', $token)]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row) {
        sendError('Not your seat', 401);
    }
    $room = [
        'id' => (int) $row['room_id'],
        'code' => $row['code'],
        'status' => $row['status'],
        'turn' => (int) $row['turn'],
        'starter' => (int) $row['starter'],
        'outcome' => $row['outcome'],
        'lang' => $row['lang'],
        'turns' => (int) $row['turns'],
    ];
    if ($needsBoth && count(seatRows($db, $room['id'])) < ROOM_CAP) {
        sendError('The other seat is empty', 409, ['reason' => 'noOpponent']);
    }
    return [$room, $row];
}

function logEvent(PDO $db, int $roomId, ?int $playerId, string $type, array $data): void
{
    $db->prepare('INSERT INTO battleship_events (room_id, player_id, type, data) VALUES (?, ?, ?, ?)')
       ->execute([$roomId, $playerId, $type, json_encode($data, JSON_UNESCAPED_UNICODE)]);
}

function touchRoom(PDO $db, int $roomId): void
{
    $db->prepare('UPDATE battleship_rooms SET last_active = NOW() WHERE id = ?')->execute([$roomId]);
}

function roomCode(): string
{
    $out = '';
    for ($i = 0; $i < 4; $i++) {
        $out .= CODE_ALPHABET[random_int(0, strlen(CODE_ALPHABET) - 1)];
    }
    return $out;
}

/** The signed-in user's id, or null. Never a gate: play is anonymous. */
function signedInUserId(): ?int
{
    $user = Auth::currentUser();
    return $user === null ? null : (int) $user['id'];
}

function validateCode(mixed $raw): string
{
    $code = strtoupper(preg_replace('/[^A-Za-z]/', '', (string) $raw));
    if (!preg_match('/^[A-Z]{4}$/', $code)) {
        throw new InvalidArgumentException('That is not a room code');
    }
    return $code;
}

function validateName(mixed $raw): string
{
    $name = preg_replace('/[\x00-\x1f\x7f]/u', '', (string) $raw);
    $name = trim(preg_replace('/\s+/u', ' ', $name));
    $len = mb_strlen($name);
    if ($len < 1 || $len > 20) {
        throw new InvalidArgumentException('A name is 1 to 20 characters');
    }
    return $name;
}

function validateLang(mixed $raw): string
{
    return in_array($raw, ['en', 'sl'], true) ? $raw : 'en';
}

function clampInt(mixed $raw, int $max = 9999): int
{
    return is_int($raw) ? max(0, min($max, $raw)) : 0;
}

function jsonBody(): array
{
    // CSRF backstop: endpoints only accept JSON bodies.
    $contentType = $_SERVER['CONTENT_TYPE'] ?? '';
    if (!str_contains($contentType, 'application/json')) {
        sendError('Expected application/json body', 415);
    }
    $raw = file_get_contents('php://input');
    if ($raw !== false && strlen($raw) > 65536) {
        sendError('Body too large', 413);
    }
    $json = $raw ? json_decode($raw, true) : null;
    return is_array($json) ? $json : [];
}

function sendJson(mixed $data, int $code = 200): void
{
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

function sendError(string $message, int $code = 400, array $extra = []): void
{
    http_response_code($code);
    echo json_encode(['error' => $message] + $extra, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}
