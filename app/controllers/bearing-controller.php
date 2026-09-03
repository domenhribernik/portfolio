<?php
declare(strict_types=1);
define('SECURE_ACCESS', true);

header('Content-Type: application/json; charset=utf-8');
// Per-room realtime state: never cache.
header('Cache-Control: no-store');
// Deliberately no Access-Control-Allow-Origin: consumers are same-origin only.

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }

require_once __DIR__ . '/../config/dev-mode.php';
require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/bearing/movement.php';   // pulls in bearing/valley.php

// No auth include on purpose: rooms are anonymous and throwaway. A player is
// a secret token minted at create/join/reclaim, stored only as a SHA-256 hash.
//
// THE AUTHORITY RULE. The server owns the valley: terrain, the animals,
// their hidden behaviour profiles and their movement all derive from
// bearing_rooms.seed and are generated here. A client posts an intent
// (sweep this collar, walk to this cell, log a fix, call an intercept) and
// everything else in the body is ignored.
//
// WHAT IS DELIBERATELY NOT SECRET. A sweep hands back the whole 360-sample
// trace, and the true bearing is the peak of it. That IS the game: the skill
// is reading it well. Reading it perfectly by script would only be cheating
// if there were an opponent, and there is not: both seats want the same
// outcome. So the trace goes over honestly. What never goes over is where
// the animal actually IS, what she DOES, and where she has BEEN, because
// those are what the pair has to earn.

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

const CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
const ROOM_CAP = 2;
// Ten, not twenty-four. A night is one sitting of fifteen to twenty minutes,
// and the old length was mostly repetition of the same three actions.
const CYCLES = 10;
const EVENT_PAGE = 200;
const IDLE_ROOM_HOURS = 6;
const RECLAIM_IDLE_SECONDS = 20;
const ONLINE_SECONDS = 25;
const SWEEP_MINUTES = 15;
const MOVE_MAX = 6;              // cells a station can walk in one cycle
// How near a station has to be standing for a called intercept to count as
// attended at all. Mirrored in views/bearing/logic.js.
const INTERCEPT_RADIUS = 3;
const CONTACT_M = 300;           // a call this close to her is contact
const NEAR_M = 650;              // this close is near, beyond it is a miss
// Two collars, not three. Ten cycles buys about three fixes per animal and
// three animals meant nobody ever learned enough about any of them.
const COLLARS = ['F2', 'M7'];

/* ---------------------------------------------------------------- plumbing */

function sendJson(array $payload, int $code = 200): void {
    http_response_code($code);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}
function sendError(string $msg, int $code = 400, array $extra = []): void {
    sendJson(array_merge(['error' => $msg], $extra), $code);
}
function readBody(): array {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') sendError('POST only', 405);
    $ctype = $_SERVER['CONTENT_TYPE'] ?? '';
    if (stripos($ctype, 'application/json') === false) sendError('JSON body required', 415);
    $raw = file_get_contents('php://input');
    if ($raw === false || strlen($raw) > 65536) sendError('Body too large', 413);
    $body = json_decode($raw, true);
    return is_array($body) ? $body : [];
}
function db(): PDO { return Database::write(); }

function normalizeCode($raw): string {
    return substr(preg_replace('/[^A-Z]/', '', strtoupper((string)$raw)), 0, 4);
}
function isValidCode(string $code): bool {
    if (strlen($code) !== 4) return false;
    for ($i = 0; $i < 4; $i++) if (strpos(CODE_ALPHABET, $code[$i]) === false) return false;
    return true;
}
function cleanName($raw): string {
    $n = trim(preg_replace('/\s+/u', ' ', (string)$raw));
    return mb_substr($n, 0, 20);
}
function mintToken(): string { return bin2hex(random_bytes(16)); }
function hashToken(string $t): string { return hash('sha256', $t); }

/* ------------------------------------------------------------- the animals */

function seedAnimals(PDO $pdo, int $roomId, int $seed, string $terrain): void {
    $ins = $pdo->prepare(
        'INSERT INTO bearing_animals (room_id, collar, at, profile, den_cell, track, duty, phase)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    $profiles = assignProfiles($seed, count(COLLARS));
    $i = 0;
    foreach (COLLARS as $collar) {
        $profile = $profiles[$i];
        $at = bearingStart($terrain, $profile, $seed, $i);
        // A den animal orbits where she started. Nothing else uses this.
        $den = $profile === 'den' ? $at : null;
        $duty = [1, 2][$i];                          // F2 every cycle, M7 alternate
        $phase = [0, 0][$i];
        $ins->execute([$roomId, $collar, $at, $profile, $den, (string)$at, $duty, $phase]);
        $i++;
    }
}

/** Everything moves once both seats have committed, along the shape it was
    dealt. The track is appended as it goes, because dawn draws the real one
    over the one the pair reconstructed and that comparison is the payoff. */
function moveAnimals(PDO $pdo, array $room, array $players): void {
    $rows = $pdo->prepare('SELECT * FROM bearing_animals WHERE room_id = ?');
    $rows->execute([$room['id']]);
    $upd = $pdo->prepare('UPDATE bearing_animals SET at = ?, track = ? WHERE id = ?');
    $cycle = (int)$room['cycle'];
    $stations = array_map(fn($p) => (int)$p['pos'], $players);
    foreach ($rows->fetchAll(PDO::FETCH_ASSOC) as $a) {
        $next = bearingStep(
            $room['terrain'], $a['profile'], (int)$a['at'],
            $a['den_cell'] === null ? null : (int)$a['den_cell'],
            $cycle, (int)$room['seed'], $a['collar'], $stations
        );
        $upd->execute([$next, $a['track'] . ',' . $next, $a['id']]);
    }
}

/* ------------------------------------------------------------------ rooms */

function purgeIdleRooms(PDO $pdo): void {
    // No cron on the host, so the rare create request pays for the sweeping.
    $pdo->exec('DELETE FROM bearing_rooms WHERE last_active < NOW() - INTERVAL ' . IDLE_ROOM_HOURS . ' HOUR');
}
function logEvent(PDO $pdo, int $roomId, ?int $playerId, string $type, array $data = []): void {
    $st = $pdo->prepare('INSERT INTO bearing_events (room_id, player_id, type, data) VALUES (?, ?, ?, ?)');
    $st->execute([$roomId, $playerId, $type, $data ? json_encode($data) : null]);
}
function lockRoomByCode(PDO $pdo, string $code): ?array {
    $st = $pdo->prepare('SELECT * FROM bearing_rooms WHERE code = ? FOR UPDATE');
    $st->execute([$code]);
    $r = $st->fetch(PDO::FETCH_ASSOC);
    return $r ?: null;
}
function playerByToken(PDO $pdo, int $roomId, string $token): ?array {
    $st = $pdo->prepare('SELECT * FROM bearing_players WHERE room_id = ? AND token_hash = ? AND left_at IS NULL');
    $st->execute([$roomId, hashToken($token)]);
    $p = $st->fetch(PDO::FETCH_ASSOC);
    return $p ?: null;
}
function heartbeat(PDO $pdo, array $player): void {
    // Only when already stale, so a 900ms poll loop is not a 900ms write loop.
    $st = $pdo->prepare(
        'UPDATE bearing_players SET last_seen = NOW() WHERE id = ? AND last_seen < NOW() - INTERVAL 10 SECOND');
    $st->execute([$player['id']]);
}

function startPosition(int $seed, int $seat): int {
    // The two stations start apart, because a night that opens with both of
    // you on the same hilltop opens with every fix already ruined.
    $y = (int)floor(N / 2) + ($seat === 1 ? -2 : 2);
    $x = $seat === 1 ? 5 : N - 6;
    return cellIndex($x, max(1, min(N - 2, $y)));
}
function revealAround(string $revealed, int $pos, int $radius = 4): string {
    [$cx, $cy] = cellXY($pos);
    for ($y = max(0, $cy - $radius); $y <= min(N - 1, $cy + $radius); $y++) {
        for ($x = max(0, $cx - $radius); $x <= min(N - 1, $cx + $radius); $x++) {
            if (pow($x - $cx, 2) + pow($y - $cy, 2) <= $radius * $radius) $revealed[$y * N + $x] = '1';
        }
    }
    return $revealed;
}

/* --------------------------------------------------------------- payloads */

/** Everything a seat may know, built UP from observations rather than
    filtered down from the animal rows, so a column added later cannot leak
    here by being forgotten in a blacklist. */
function roomSummary(array $room): array {
    return [
        'code'    => $room['code'],
        'status'  => $room['status'],
        'cycle'   => (int)$room['cycle'],
        'cycles'  => (int)$room['cycles'],
        'weather' => $room['weather'],
        'collars' => COLLARS,
        'profiles' => PROFILES,          // the four names, never which is which
        'n'       => N,
        'cellM'   => CELL_M,
        'radius'  => INTERCEPT_RADIUS,
    ];
}
function collarSchedule(PDO $pdo, int $roomId): array {
    $st = $pdo->prepare('SELECT collar, duty, phase FROM bearing_animals WHERE room_id = ? ORDER BY id');
    $st->execute([$roomId]);
    $out = [];
    foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $a) {
        // duty and phase are published: sweeping a silent collar should be a
        // planning mistake, never a guess. profile and den_cell are NOT here,
        // and that omission is the entire night.
        $out[] = ['collar' => $a['collar'], 'duty' => (int)$a['duty'], 'phase' => (int)$a['phase']];
    }
    return $out;
}
function seatPayload(array $p, bool $self): array {
    $out = [
        'id' => (int)$p['id'], 'name' => $p['name'], 'seat' => (int)$p['seat'],
        'host' => (int)$p['is_host'] === 1, 'pos' => (int)$p['pos'],
        'committed' => (int)$p['committed_cycle'], 'fixes' => (int)$p['fixes_logged'],
        'online' => strtotime($p['last_seen']) >= time() - ONLINE_SECONDS,
    ];
    // A seat's walked ground is its own. The other station is described, not shown.
    if ($self) $out['revealed'] = $p['revealed'];
    return $out;
}
/** Called intercepts. Safe to publish in full: the pair authored every field
    except the grade, and a grade only exists once the cycle it names has
    already been played out. */
function interceptPayload(PDO $pdo, int $roomId): array {
    $st = $pdo->prepare('SELECT * FROM bearing_intercepts WHERE room_id = ? ORDER BY id');
    $st->execute([$roomId]);
    $out = [];
    foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $r) {
        $out[] = [
            'id' => (int)$r['id'], 'collar' => $r['collar'], 'at' => (int)$r['at'],
            'cycle' => (int)$r['target_cycle'],
            'by' => (int)$r['proposed_by'],
            'confirmed' => $r['confirmed_by'] === null ? null : (int)$r['confirmed_by'],
            'grade' => $r['grade'],
            'errorM' => $r['error_m'] === null ? null : (int)$r['error_m'],
        ];
    }
    return $out;
}

/* ---------------------------------------------------------------- actions */

$action = $_GET['action'] ?? '';
try {
    Database::init();
    switch ($action) {
        case 'create':    createRoom();     break;
        case 'join':      joinRoom();       break;
        case 'seats':     listSeats();      break;
        case 'reclaim':   reclaimSeat();    break;
        case 'poll':      pollRoom();       break;
        case 'commit':    postCommit();     break;
        case 'read':      postRead();       break;
        case 'note':      postNote();       break;
        case 'intercept': postIntercept();  break;
        case 'again':     postAgain();      break;
        case 'leave':     leaveRoom();      break;
        default: sendError('Unknown action', 404);
    }
} catch (Throwable $e) {
    global $DEV_MODE;
    sendError(($DEV_MODE ?? false) ? $e->getMessage() : 'Internal server error', 500);
}

function newValley(int $seed): array {
    return [generateTerrain($seed), WEATHERS[$seed % count(WEATHERS)]];
}

function createRoom(): void {
    $body = readBody();
    $name = cleanName($body['name'] ?? '');
    if ($name === '') sendError('Bad name', 422, ['reason' => 'badName']);

    $pdo = db();
    purgeIdleRooms($pdo);
    $seed = random_int(1, 2000000000);
    [$terrain, $weather] = newValley($seed);

    for ($attempt = 0; $attempt < 6; $attempt++) {
        $code = '';
        for ($i = 0; $i < 4; $i++) $code .= CODE_ALPHABET[random_int(0, strlen(CODE_ALPHABET) - 1)];
        try {
            $pdo->beginTransaction();
            $st = $pdo->prepare(
                'INSERT INTO bearing_rooms (code, status, seed, terrain, cycle, cycles, weather)
                 VALUES (?, "lobby", ?, ?, 0, ?, ?)');
            $st->execute([$code, $seed, $terrain, CYCLES, $weather]);
            $roomId = (int)$pdo->lastInsertId();
            seedAnimals($pdo, $roomId, $seed, $terrain);

            $token = mintToken();
            $pos = startPosition($seed, 1);
            $revealed = revealAround(str_repeat('0', N * N), $pos);
            $ps = $pdo->prepare(
                'INSERT INTO bearing_players (room_id, token_hash, name, seat, is_host, pos, revealed)
                 VALUES (?, ?, ?, 1, 1, ?, ?)');
            $ps->execute([$roomId, hashToken($token), $name, $pos, $revealed]);
            $playerId = (int)$pdo->lastInsertId();
            logEvent($pdo, $roomId, $playerId, 'open', ['name' => $name]);
            $pdo->commit();

            $st = $pdo->prepare('SELECT * FROM bearing_rooms WHERE id = ?');
            $st->execute([$roomId]);
            $room = $st->fetch(PDO::FETCH_ASSOC);
            sendJson(['code' => $code, 'token' => $token,
                      'you' => ['id' => $playerId, 'seat' => 1, 'host' => true],
                      'room' => roomSummary($room)], 201);
        } catch (PDOException $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            if ($e->getCode() !== '23000') throw $e;   // not a duplicate code: real failure
        }
    }
    sendError('Could not mint a room code', 503);
}

function joinRoom(): void {
    $body = readBody();
    $name = cleanName($body['name'] ?? '');
    $code = normalizeCode($body['code'] ?? '');
    if ($name === '') sendError('Bad name', 422, ['reason' => 'badName']);
    if (!isValidCode($code)) sendError('Bad code', 422, ['reason' => 'badCode']);

    $pdo = db();
    $pdo->beginTransaction();
    try {
        $room = lockRoomByCode($pdo, $code);
        if (!$room) { $pdo->rollBack(); sendError('No such room', 404, ['reason' => 'noRoom']); }
        if ($room['status'] !== 'lobby') {
            $pdo->rollBack();
            sendError('Night under way', 409, ['reason' => 'started', 'reclaim' => true]);
        }
        // Counting seats takes the room lock first. Not doing that is exactly
        // what deadlocked seam in production.
        $cnt = $pdo->prepare('SELECT COUNT(*) FROM bearing_players WHERE room_id = ? AND left_at IS NULL');
        $cnt->execute([$room['id']]);
        if ((int)$cnt->fetchColumn() >= ROOM_CAP) {
            $pdo->rollBack(); sendError('Room full', 409, ['reason' => 'roomFull']);
        }
        $token = mintToken();
        $pos = startPosition((int)$room['seed'], 2);
        $revealed = revealAround(str_repeat('0', N * N), $pos);
        $ps = $pdo->prepare(
            'INSERT INTO bearing_players (room_id, token_hash, name, seat, is_host, pos, revealed)
             VALUES (?, ?, ?, 2, 0, ?, ?)');
        $ps->execute([$room['id'], hashToken($token), $name, $pos, $revealed]);
        $playerId = (int)$pdo->lastInsertId();
        // Both seats are here, so the night starts. Nothing to press.
        $pdo->prepare('UPDATE bearing_rooms SET status = "night", last_active = NOW() WHERE id = ?')
            ->execute([$room['id']]);
        logEvent($pdo, (int)$room['id'], $playerId, 'dusk', ['name' => $name]);
        $pdo->commit();

        $st = $pdo->prepare('SELECT * FROM bearing_rooms WHERE id = ?');
        $st->execute([$room['id']]);
        sendJson(['code' => $code, 'token' => $token,
                  'you' => ['id' => $playerId, 'seat' => 2, 'host' => false],
                  'room' => roomSummary($st->fetch(PDO::FETCH_ASSOC))]);
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $e;
    }
}

/** The one tokenless endpoint, so a phone that lost its session can find
    its seat again without proving anything it no longer has. */
function listSeats(): void {
    $body = readBody();
    $code = normalizeCode($body['code'] ?? '');
    if (!isValidCode($code)) sendError('Bad code', 422, ['reason' => 'badCode']);
    $pdo = db();
    $st = $pdo->prepare('SELECT id, status FROM bearing_rooms WHERE code = ?');
    $st->execute([$code]);
    $room = $st->fetch(PDO::FETCH_ASSOC);
    if (!$room) sendError('No such room', 404, ['reason' => 'noRoom']);
    $ps = $pdo->prepare(
        'SELECT id, name, seat, last_seen FROM bearing_players WHERE room_id = ? AND left_at IS NULL ORDER BY seat');
    $ps->execute([$room['id']]);
    $seats = [];
    foreach ($ps->fetchAll(PDO::FETCH_ASSOC) as $p) {
        $idle = time() - strtotime($p['last_seen']);
        $seats[] = ['id' => (int)$p['id'], 'name' => $p['name'], 'seat' => (int)$p['seat'],
                    'online' => $idle < ONLINE_SECONDS, 'reclaimable' => $idle >= RECLAIM_IDLE_SECONDS];
    }
    sendJson(['room' => ['code' => $code, 'status' => $room['status']], 'players' => $seats]);
}

function reclaimSeat(): void {
    $body = readBody();
    $code = normalizeCode($body['code'] ?? '');
    $playerId = (int)($body['playerId'] ?? 0);
    if (!isValidCode($code)) sendError('Bad code', 422, ['reason' => 'badCode']);
    $pdo = db();
    $pdo->beginTransaction();
    try {
        $room = lockRoomByCode($pdo, $code);
        if (!$room) { $pdo->rollBack(); sendError('No such room', 404, ['reason' => 'noRoom']); }
        $st = $pdo->prepare(
            'SELECT * FROM bearing_players WHERE id = ? AND room_id = ? AND left_at IS NULL
             AND last_seen < NOW() - INTERVAL ' . RECLAIM_IDLE_SECONDS . ' SECOND FOR UPDATE');
        $st->execute([$playerId, $room['id']]);
        $p = $st->fetch(PDO::FETCH_ASSOC);
        if (!$p) { $pdo->rollBack(); sendError('Seat not free', 409, ['reason' => 'seatBusy']); }
        // Minting a new token overwrites the hash, which is what evicts the
        // old phone: its next poll 401s and it puts itself out.
        $token = mintToken();
        $pdo->prepare('UPDATE bearing_players SET token_hash = ?, last_seen = NOW() WHERE id = ?')
            ->execute([hashToken($token), $playerId]);
        $pdo->commit();
        $st = $pdo->prepare('SELECT * FROM bearing_rooms WHERE id = ?');
        $st->execute([$room['id']]);
        sendJson(['code' => $code, 'token' => $token,
                  'you' => ['id' => $playerId, 'seat' => (int)$p['seat'], 'host' => (int)$p['is_host'] === 1],
                  'room' => roomSummary($st->fetch(PDO::FETCH_ASSOC))]);
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $e;
    }
}

/* ------------------------------------------------------------------- poll */

function pollRoom(): void {
    $body = readBody();
    $code = normalizeCode($body['code'] ?? '');
    $token = (string)($body['token'] ?? '');
    $since = max(0, (int)($body['since'] ?? 0));
    if (!isValidCode($code)) sendError('Bad code', 422, ['reason' => 'badCode']);

    $pdo = db();
    $st = $pdo->prepare('SELECT * FROM bearing_rooms WHERE code = ?');
    $st->execute([$code]);
    $room = $st->fetch(PDO::FETCH_ASSOC);
    if (!$room) sendError('No such room', 404, ['reason' => 'noRoom']);
    $me = playerByToken($pdo, (int)$room['id'], $token);
    if (!$me) sendError('Not seated', 401, ['reason' => 'seatTaken']);

    heartbeat($pdo, $me);
    // Housekeeping rides the poll, because the host has no cron. Anything
    // nobody presses a button for happens here.
    if (strtotime($room['last_active']) < time() - 60) {
        $pdo->prepare('UPDATE bearing_rooms SET last_active = NOW() WHERE id = ?')->execute([$room['id']]);
    }
    $pdo->prepare(
        'UPDATE bearing_players SET left_at = NOW()
         WHERE room_id = ? AND left_at IS NULL AND last_seen < NOW() - INTERVAL ' . SWEEP_MINUTES . ' MINUTE')
        ->execute([$room['id']]);
    // The invariant is re-checked every poll, not applied once: a commit
    // request that died after writing must not strand the pair forever.
    resolveIfBothCommitted($pdo, (int)$room['id']);

    $st->execute([$code]);
    $room = $st->fetch(PDO::FETCH_ASSOC);
    $me = playerByToken($pdo, (int)$room['id'], $token);
    if (!$me) sendError('Not seated', 401, ['reason' => 'seatTaken']);

    $ps = $pdo->prepare('SELECT * FROM bearing_players WHERE room_id = ? AND left_at IS NULL ORDER BY seat');
    $ps->execute([$room['id']]);
    $you = null; $partner = null;
    foreach ($ps->fetchAll(PDO::FETCH_ASSOC) as $p) {
        if ((int)$p['id'] === (int)$me['id']) $you = seatPayload($p, true);
        else $partner = seatPayload($p, false);
    }

    $ev = $pdo->prepare(
        'SELECT id, player_id, type, data FROM bearing_events WHERE room_id = ? AND id > ? ORDER BY id LIMIT ' . (EVENT_PAGE + 1));
    $ev->execute([$room['id'], $since]);
    $rows = $ev->fetchAll(PDO::FETCH_ASSOC);
    $more = count($rows) > EVENT_PAGE;
    if ($more) array_pop($rows);
    $events = [];
    $last = $since;
    foreach ($rows as $r) {
        $events[] = ['id' => (int)$r['id'], 'by' => $r['player_id'] === null ? null : (int)$r['player_id'],
                     'type' => $r['type'], 'data' => $r['data'] ? json_decode($r['data'], true) : null];
        $last = (int)$r['id'];
    }

    sendJson([
        'room' => roomSummary($room),
        'you' => $you,
        'partner' => $partner,
        'collars' => collarSchedule($pdo, (int)$room['id']),
        'intercepts' => interceptPayload($pdo, (int)$room['id']),
        'terrain' => maskedTerrain($room['terrain'], $you['revealed'] ?? str_repeat('0', N * N)),
        'events' => $events,
        'last' => $last,
        'more' => $more,
    ]);
}

/** A seat sees the ground it has walked and nothing else, which is what
    gives each station something real to tell the other. */
function maskedTerrain(string $terrain, string $revealed): string {
    $out = str_repeat('.', N * N);
    for ($i = 0; $i < N * N; $i++) if ($revealed[$i] === '1') $out[$i] = $terrain[$i];
    return $out;
}

/* ----------------------------------------------------------- the lockstep */

function postCommit(): void {
    $body = readBody();
    $code = normalizeCode($body['code'] ?? '');
    $token = (string)($body['token'] ?? '');
    $action = is_array($body['action'] ?? null) ? $body['action'] : [];
    if (!isValidCode($code)) sendError('Bad code', 422, ['reason' => 'badCode']);

    $pdo = db();
    $pdo->beginTransaction();
    try {
        $room = lockRoomByCode($pdo, $code);
        if (!$room) { $pdo->rollBack(); sendError('No such room', 404, ['reason' => 'noRoom']); }
        if ($room['status'] !== 'night') { $pdo->rollBack(); sendError('Not tonight', 409, ['reason' => 'notNight']); }
        $me = playerByToken($pdo, (int)$room['id'], $token);
        if (!$me) { $pdo->rollBack(); sendError('Not seated', 401, ['reason' => 'seatTaken']); }
        if ((int)$me['committed_cycle'] === (int)$room['cycle']) {
            $pdo->rollBack(); sendError('Already committed', 409, ['reason' => 'alreadyCommitted']);
        }

        // Only the shape of an intent survives. Everything else in the body,
        // including anything that looks like a result, is ignored.
        $kind = (string)($action['kind'] ?? '');
        $clean = ['kind' => $kind];
        if ($kind === 'sweep') {
            $collar = (string)($action['collar'] ?? '');
            if (!in_array($collar, COLLARS, true)) { $pdo->rollBack(); sendError('No such collar', 422, ['reason' => 'badCollar']); }
            $clean['collar'] = $collar;
        } elseif ($kind === 'move') {
            $at = (int)($action['at'] ?? -1);
            if ($at < 0 || $at >= N * N) { $pdo->rollBack(); sendError('Off the plate', 422, ['reason' => 'badCell']); }
            if (chebyshev($at, (int)$me['pos']) > MOVE_MAX) { $pdo->rollBack(); sendError('Too far to walk', 422, ['reason' => 'tooFar']); }
            $clean['at'] = $at;
        } elseif ($kind === 'log') {
            $collar = (string)($action['collar'] ?? '');
            $at = (int)($action['at'] ?? -1);
            if (!in_array($collar, COLLARS, true)) { $pdo->rollBack(); sendError('No such collar', 422, ['reason' => 'badCollar']); }
            if ($at < 0 || $at >= N * N) { $pdo->rollBack(); sendError('Off the plate', 422, ['reason' => 'badCell']); }
            $clean = ['kind' => 'log', 'collar' => $collar, 'at' => $at];
        } else {
            $pdo->rollBack(); sendError('Unknown action', 422, ['reason' => 'badAction']);
        }

        $pdo->prepare('UPDATE bearing_players SET committed_cycle = ?, committed_action = ? WHERE id = ?')
            ->execute([(int)$room['cycle'], json_encode($clean), $me['id']]);
        logEvent($pdo, (int)$room['id'], (int)$me['id'], 'commit', ['kind' => $kind, 'cycle' => (int)$room['cycle']]);
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $e;
    }
    resolveIfBothCommitted($pdo, (int)$room['id']);
    sendJson(['ok' => true]);
}

/** Bracketing a trace you already have costs nothing: it is reading, not
    sweeping. Posting it is what puts your ray on your partner's plate. */
function postRead(): void {
    $body = readBody();
    $code = normalizeCode($body['code'] ?? '');
    $token = (string)($body['token'] ?? '');
    if (!isValidCode($code)) sendError('Bad code', 422, ['reason' => 'badCode']);
    $pdo = db();
    $st = $pdo->prepare('SELECT * FROM bearing_rooms WHERE code = ?');
    $st->execute([$code]);
    $room = $st->fetch(PDO::FETCH_ASSOC);
    if (!$room) sendError('No such room', 404, ['reason' => 'noRoom']);
    $me = playerByToken($pdo, (int)$room['id'], $token);
    if (!$me) sendError('Not seated', 401, ['reason' => 'seatTaken']);

    $collar = (string)($body['collar'] ?? '');
    $deg = (float)($body['deg'] ?? -1);
    $sigma = (float)($body['sigma'] ?? 0);
    if (!in_array($collar, COLLARS, true)) sendError('No such collar', 422, ['reason' => 'badCollar']);
    if ($deg < 0 || $deg >= 360) sendError('Not a bearing', 422, ['reason' => 'badBearing']);
    logEvent($pdo, (int)$room['id'], (int)$me['id'], 'bearing', [
        'collar' => $collar, 'deg' => round($deg, 1), 'cycle' => (int)$room['cycle'],
        'sigma' => round(max(0.2, min(45, $sigma)), 2), 'from' => (int)$me['pos'], 'seat' => (int)$me['seat'],
    ]);
    sendJson(['ok' => true]);
}

/** A hypothesis chip. Free, non-binding, shared, and costing no cycle,
    because its whole job is to give the pair something concrete to disagree
    about out loud. The server stores no opinion of its own about it. */
function postNote(): void {
    $body = readBody();
    $code = normalizeCode($body['code'] ?? '');
    $token = (string)($body['token'] ?? '');
    if (!isValidCode($code)) sendError('Bad code', 422, ['reason' => 'badCode']);
    $pdo = db();
    $st = $pdo->prepare('SELECT * FROM bearing_rooms WHERE code = ?');
    $st->execute([$code]);
    $room = $st->fetch(PDO::FETCH_ASSOC);
    if (!$room) sendError('No such room', 404, ['reason' => 'noRoom']);
    $me = playerByToken($pdo, (int)$room['id'], $token);
    if (!$me) sendError('Not seated', 401, ['reason' => 'seatTaken']);

    $collar = (string)($body['collar'] ?? '');
    $profile = (string)($body['profile'] ?? '');
    if (!in_array($collar, COLLARS, true)) sendError('No such collar', 422, ['reason' => 'badCollar']);
    if (!in_array($profile, PROFILES, true)) sendError('No such shape', 422, ['reason' => 'badProfile']);
    logEvent($pdo, (int)$room['id'], (int)$me['id'], 'note', [
        'collar' => $collar, 'profile' => $profile,
        'on' => !empty($body['on']), 'seat' => (int)$me['seat'],
    ]);
    sendJson(['ok' => true]);
}

/* -------------------------------------------------------- the commitment */

/** Propose, confirm or withdraw an intercept.
 *
 * TWO SEATS ARE REQUIRED, and that is the point of the whole mechanic: one
 * player names a cell and a cycle, the other has to agree before it locks.
 * Each of them has walked different ground, so each knows things about the
 * proposed cell the other cannot see, and that disagreement is the only
 * conversation in the game that needs two people who can talk freely.
 *
 * Deliberately NOT costing a cycle, which the design sketch had it do. The
 * real price is already there and is far more legible: the call is only
 * attended if a station is standing within INTERCEPT_RADIUS of the cell at
 * the target cycle, and walking there costs cycles you wanted for sweeping.
 * Taxing the proposal on top would have charged twice for one decision and
 * would have forced the lockstep to carry a second kind of commit.
 */
function postIntercept(): void {
    $body = readBody();
    $code = normalizeCode($body['code'] ?? '');
    $token = (string)($body['token'] ?? '');
    if (!isValidCode($code)) sendError('Bad code', 422, ['reason' => 'badCode']);

    $pdo = db();
    $pdo->beginTransaction();
    try {
        $room = lockRoomByCode($pdo, $code);
        if (!$room) { $pdo->rollBack(); sendError('No such room', 404, ['reason' => 'noRoom']); }
        if ($room['status'] !== 'night') { $pdo->rollBack(); sendError('Not tonight', 409, ['reason' => 'notNight']); }
        $me = playerByToken($pdo, (int)$room['id'], $token);
        if (!$me) { $pdo->rollBack(); sendError('Not seated', 401, ['reason' => 'seatTaken']); }
        $roomId = (int)$room['id'];
        $cycle = (int)$room['cycle'];
        $mode = (string)($body['mode'] ?? 'propose');

        if ($mode === 'propose') {
            $collar = (string)($body['collar'] ?? '');
            $at = (int)($body['at'] ?? -1);
            $target = (int)($body['cycle'] ?? -1);
            if (!in_array($collar, COLLARS, true)) { $pdo->rollBack(); sendError('No such collar', 422, ['reason' => 'badCollar']); }
            if ($at < 0 || $at >= N * N) { $pdo->rollBack(); sendError('Off the plate', 422, ['reason' => 'badCell']); }
            // Strictly ahead: calling a cycle already played would be calling
            // a result, and calling the last one leaves no time to walk.
            if ($target <= $cycle || $target >= (int)$room['cycles']) {
                $pdo->rollBack(); sendError('Not a future cycle', 422, ['reason' => 'badCycle']);
            }
            $live = $pdo->prepare(
                'SELECT COUNT(*) FROM bearing_intercepts WHERE room_id = ? AND collar = ? AND grade IS NULL');
            $live->execute([$roomId, $collar]);
            if ((int)$live->fetchColumn() > 0) {
                $pdo->rollBack(); sendError('One call at a time', 409, ['reason' => 'callPending']);
            }
            $pdo->prepare(
                'INSERT INTO bearing_intercepts (room_id, collar, proposed_by, at, target_cycle)
                 VALUES (?, ?, ?, ?, ?)')->execute([$roomId, $collar, (int)$me['id'], $at, $target]);
            logEvent($pdo, $roomId, (int)$me['id'], 'called', [
                'collar' => $collar, 'at' => $at, 'cycle' => $target, 'seat' => (int)$me['seat']]);

        } elseif ($mode === 'confirm') {
            $id = (int)($body['id'] ?? 0);
            $st = $pdo->prepare(
                'SELECT * FROM bearing_intercepts WHERE id = ? AND room_id = ? AND grade IS NULL FOR UPDATE');
            $st->execute([$id, $roomId]);
            $row = $st->fetch(PDO::FETCH_ASSOC);
            if (!$row) { $pdo->rollBack(); sendError('No such call', 404, ['reason' => 'noCall']); }
            // The one rule that makes this a two-person mechanic rather than
            // a button: you cannot second your own proposal.
            if ((int)$row['proposed_by'] === (int)$me['id']) {
                $pdo->rollBack(); sendError('Your partner has to agree', 409, ['reason' => 'needPartner']);
            }
            if ($row['confirmed_by'] !== null) {
                $pdo->rollBack(); sendError('Already agreed', 409, ['reason' => 'alreadyAgreed']);
            }
            if ((int)$row['target_cycle'] <= $cycle) {
                $pdo->rollBack(); sendError('Too late for that call', 409, ['reason' => 'callStale']);
            }
            $pdo->prepare('UPDATE bearing_intercepts SET confirmed_by = ? WHERE id = ?')
                ->execute([(int)$me['id'], $id]);
            logEvent($pdo, $roomId, (int)$me['id'], 'agreed', [
                'id' => $id, 'collar' => $row['collar'], 'seat' => (int)$me['seat']]);

        } elseif ($mode === 'withdraw') {
            $id = (int)($body['id'] ?? 0);
            // Only while it is still a proposal. Once both seats have agreed
            // it is a commitment and the night has to answer it.
            $st = $pdo->prepare(
                'DELETE FROM bearing_intercepts
                 WHERE id = ? AND room_id = ? AND grade IS NULL AND confirmed_by IS NULL');
            $st->execute([$id, $roomId]);
            if ($st->rowCount() === 0) { $pdo->rollBack(); sendError('Nothing to withdraw', 409, ['reason' => 'noCall']); }
            logEvent($pdo, $roomId, (int)$me['id'], 'dropped', ['id' => $id, 'seat' => (int)$me['seat']]);

        } else {
            $pdo->rollBack(); sendError('Unknown action', 422, ['reason' => 'badAction']);
        }
        $pdo->commit();
        sendJson(['ok' => true]);
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $e;
    }
}

/** Elected by rowCount(): two pollers arriving in the same second cannot
    both advance the night, because only one UPDATE matches the cycle. */
function resolveIfBothCommitted(PDO $pdo, int $roomId): void {
    $pdo->beginTransaction();
    try {
        $st = $pdo->prepare('SELECT * FROM bearing_rooms WHERE id = ? FOR UPDATE');
        $st->execute([$roomId]);
        $room = $st->fetch(PDO::FETCH_ASSOC);
        if (!$room || $room['status'] !== 'night') { $pdo->rollBack(); return; }
        $cycle = (int)$room['cycle'];

        $ps = $pdo->prepare('SELECT * FROM bearing_players WHERE room_id = ? AND left_at IS NULL ORDER BY seat');
        $ps->execute([$roomId]);
        $players = $ps->fetchAll(PDO::FETCH_ASSOC);
        if (count($players) < ROOM_CAP) { $pdo->rollBack(); return; }
        foreach ($players as $p) if ((int)$p['committed_cycle'] !== $cycle) { $pdo->rollBack(); return; }

        $claim = $pdo->prepare('UPDATE bearing_rooms SET cycle = cycle + 1 WHERE id = ? AND cycle = ?');
        $claim->execute([$roomId, $cycle]);
        if ($claim->rowCount() === 0) { $pdo->rollBack(); return; }   // someone else got here first

        applyCycle($pdo, $room, $players);
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $e;
    }
}

function animalsByCollar(PDO $pdo, int $roomId): array {
    $st = $pdo->prepare('SELECT * FROM bearing_animals WHERE room_id = ?');
    $st->execute([$roomId]);
    $out = [];
    foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $a) $out[$a['collar']] = $a;
    return $out;
}

function applyCycle(PDO $pdo, array $room, array $players): void {
    $roomId = (int)$room['id'];
    $cycle = (int)$room['cycle'];
    $animals = animalsByCollar($pdo, $roomId);

    foreach ($players as $p) {
        $act = json_decode((string)$p['committed_action'], true);
        if (!is_array($act)) continue;
        [$sx, $sy] = cellXY((int)$p['pos']);

        if ($act['kind'] === 'move') {
            $revealed = revealAround($p['revealed'], (int)$act['at']);
            $pdo->prepare('UPDATE bearing_players SET pos = ?, revealed = ? WHERE id = ?')
                ->execute([(int)$act['at'], $revealed, $p['id']]);
            logEvent($pdo, $roomId, (int)$p['id'], 'moved', ['at' => (int)$act['at'], 'seat' => (int)$p['seat']]);

        } elseif ($act['kind'] === 'sweep') {
            $a = $animals[$act['collar']] ?? null;
            $transmitting = $a && (int)$a['duty'] > 0 && ($cycle % (int)$a['duty']) === (int)$a['phase'];
            if (!$transmitting) {
                logEvent($pdo, $roomId, (int)$p['id'], 'silence', ['collar' => $act['collar'], 'seat' => (int)$p['seat']]);
            } else {
                $res = sweepTrace($room['terrain'], [$sx, $sy], cellXY((int)$a['at']),
                                  (int)$room['seed'], $cycle, $act['collar'], $room['weather']);
                logEvent($pdo, $roomId, (int)$p['id'], 'trace', [
                    'collar' => $act['collar'], 'seat' => (int)$p['seat'], 'from' => (int)$p['pos'],
                    'trace' => $res['trace'],
                ]);
            }

        } elseif ($act['kind'] === 'log') {
            // A fix is EVIDENCE, not an answer, so nothing here compares it
            // to the truth. Grading it against her real position used to be
            // the night's score, which made the game "reduce your
            // measurement error" and gave three fixes in a row no meaning
            // beyond three separate numbers. What the fix is worth now is
            // whatever the pair can read off the shape it helps draw, and
            // its confidence is the crossing angle of the two bearings that
            // made it, which both seats can already see for themselves.
            $pdo->prepare('UPDATE bearing_players SET fixes_logged = fixes_logged + 1 WHERE id = ?')
                ->execute([$p['id']]);
            logEvent($pdo, $roomId, (int)$p['id'], 'fix', [
                'collar' => $act['collar'], 'at' => (int)$act['at'],
                'cycle' => $cycle, 'seat' => (int)$p['seat'],
            ]);
        }
    }

    $room['cycle'] = $cycle;
    // Everything walks, then anything called for the cycle we have just
    // arrived at is answered against where she actually ended up.
    $ps = $pdo->prepare('SELECT * FROM bearing_players WHERE room_id = ? AND left_at IS NULL');
    $ps->execute([$roomId]);
    $moved = $ps->fetchAll(PDO::FETCH_ASSOC);
    moveAnimals($pdo, $room, $moved);
    resolveIntercepts($pdo, $roomId, $cycle + 1, $moved);
    $pdo->prepare('UPDATE bearing_players SET committed_action = NULL WHERE room_id = ?')->execute([$roomId]);

    if ($cycle + 1 >= (int)$room['cycles']) {
        $pdo->prepare('UPDATE bearing_rooms SET status = "dawn", last_active = NOW() WHERE id = ?')->execute([$roomId]);
        logEvent($pdo, $roomId, null, 'dawn', dawnReport($pdo, $roomId));
    } else {
        logEvent($pdo, $roomId, null, 'cycle', ['cycle' => $cycle + 1]);
    }
}

/** Answer every call standing for this cycle.
 *
 * Two conditions, and they are different questions. Was anybody THERE, which
 * is about walking and is entirely in the pair's hands; and was the call
 * RIGHT, which is about how well they read her. Missing either is a miss,
 * and the report says which so a pair knows what to fix. */
function resolveIntercepts(PDO $pdo, int $roomId, int $cycle, array $players): void {
    $st = $pdo->prepare(
        'SELECT * FROM bearing_intercepts
         WHERE room_id = ? AND target_cycle = ? AND grade IS NULL FOR UPDATE');
    $st->execute([$roomId, $cycle]);
    $calls = $st->fetchAll(PDO::FETCH_ASSOC);
    if (!$calls) return;
    $animals = animalsByCollar($pdo, $roomId);
    $upd = $pdo->prepare('UPDATE bearing_intercepts SET grade = ?, error_m = ? WHERE id = ?');

    foreach ($calls as $c) {
        $at = (int)$c['at'];
        $attended = false;
        foreach ($players as $p) if (chebyshev((int)$p['pos'], $at) <= INTERCEPT_RADIUS) $attended = true;
        $a = $animals[$c['collar']] ?? null;
        $errM = $a ? cellMetres($at, (int)$a['at']) : 9999.0;

        // An unconfirmed call was never a commitment: one seat's opinion is
        // not the pair's, so it resolves as a miss rather than a free roll.
        if ($c['confirmed_by'] === null) $grade = 'missed';
        elseif (!$attended)              $grade = 'missed';
        elseif ($errM <= CONTACT_M)      $grade = 'contact';
        elseif ($errM <= NEAR_M)         $grade = 'near';
        else                             $grade = 'missed';

        $upd->execute([$grade, (int)round($errM), (int)$c['id']]);
        logEvent($pdo, $roomId, null, 'intercept', [
            'id' => (int)$c['id'], 'collar' => $c['collar'], 'at' => $at, 'cycle' => $cycle,
            'grade' => $grade, 'errorM' => (int)round($errM),
            'attended' => $attended, 'agreed' => $c['confirmed_by'] !== null,
        ]);
    }
}

/** Dawn is the only moment the truth is published, because the night is
    over and there is nothing left to earn. The real track goes over here so
    the plate can draw it against the one the pair reconstructed, which is
    the moment a night is supposed to be worth having played. */
function dawnReport(PDO $pdo, int $roomId): array {
    $st = $pdo->prepare('SELECT * FROM bearing_rooms WHERE id = ?');
    $st->execute([$roomId]);
    $room = $st->fetch(PDO::FETCH_ASSOC);

    $animals = animalsByCollar($pdo, $roomId);
    $truth = [];
    foreach ($animals as $c => $a) {
        $truth[$c] = [
            'profile' => $a['profile'],
            'at' => (int)$a['at'],
            'den' => $a['den_cell'] === null ? null : (int)$a['den_cell'],
            'track' => array_map('intval', explode(',', $a['track'])),
        ];
    }

    $ic = $pdo->prepare('SELECT * FROM bearing_intercepts WHERE room_id = ? ORDER BY id');
    $ic->execute([$roomId]);
    $calls = []; $best = [];
    foreach (COLLARS as $c) $best[$c] = 'none';
    $rank = ['none' => 0, 'missed' => 1, 'near' => 2, 'contact' => 3];
    foreach ($ic->fetchAll(PDO::FETCH_ASSOC) as $r) {
        $g = $r['grade'] ?? 'missed';
        $calls[] = ['collar' => $r['collar'], 'at' => (int)$r['at'], 'cycle' => (int)$r['target_cycle'],
                    'grade' => $g, 'errorM' => $r['error_m'] === null ? null : (int)$r['error_m']];
        if ($rank[$g] > $rank[$best[$r['collar']]]) $best[$r['collar']] = $g;
    }

    $contacts = count(array_filter($best, fn($g) => $g === 'contact'));
    $nears = count(array_filter($best, fn($g) => $g === 'near'));
    $grade = $contacts === count(COLLARS) ? 'triumph'
           : ($contacts + $nears === 0 ? 'disaster'
           : ($contacts >= 1 ? 'good' : 'partial'));

    $fx = $pdo->prepare("SELECT COUNT(*) FROM bearing_events WHERE room_id = ? AND type = 'fix'");
    $fx->execute([$roomId]);

    return [
        'weather' => $room['weather'],
        'truth' => $truth,
        'calls' => $calls,
        'best' => $best,
        'contacts' => $contacts,
        'fixes' => (int)$fx->fetchColumn(),
        'grade' => $grade,
    ];
}

function postAgain(): void {
    $body = readBody();
    $code = normalizeCode($body['code'] ?? '');
    $token = (string)($body['token'] ?? '');
    if (!isValidCode($code)) sendError('Bad code', 422, ['reason' => 'badCode']);
    $pdo = db();
    $pdo->beginTransaction();
    try {
        $room = lockRoomByCode($pdo, $code);
        if (!$room) { $pdo->rollBack(); sendError('No such room', 404, ['reason' => 'noRoom']); }
        $me = playerByToken($pdo, (int)$room['id'], $token);
        if (!$me) { $pdo->rollBack(); sendError('Not seated', 401, ['reason' => 'seatTaken']); }
        $pdo->prepare('UPDATE bearing_players SET wants_again = 1 WHERE id = ?')->execute([$me['id']]);

        $cnt = $pdo->prepare('SELECT COUNT(*) FROM bearing_players WHERE room_id = ? AND left_at IS NULL AND wants_again = 0');
        $cnt->execute([$room['id']]);
        if ((int)$cnt->fetchColumn() === 0) {
            // Both asked, so a fresh valley. Nobody has their report wiped
            // out from under them while they are still reading it.
            $seed = random_int(1, 2000000000);
            [$terrain, $weather] = newValley($seed);
            $pdo->prepare(
                'UPDATE bearing_rooms SET status = "night", seed = ?, terrain = ?, cycle = 0,
                 weather = ?, last_active = NOW() WHERE id = ?')
                ->execute([$seed, $terrain, $weather, $room['id']]);
            $pdo->prepare('DELETE FROM bearing_animals WHERE room_id = ?')->execute([$room['id']]);
            $pdo->prepare('DELETE FROM bearing_intercepts WHERE room_id = ?')->execute([$room['id']]);
            seedAnimals($pdo, (int)$room['id'], $seed, $terrain);
            $ps = $pdo->prepare('SELECT id, seat FROM bearing_players WHERE room_id = ? AND left_at IS NULL');
            $ps->execute([$room['id']]);
            foreach ($ps->fetchAll(PDO::FETCH_ASSOC) as $p) {
                $pos = startPosition($seed, (int)$p['seat']);
                $pdo->prepare(
                    'UPDATE bearing_players SET pos = ?, revealed = ?, committed_cycle = -1,
                     committed_action = NULL, fixes_logged = 0, wants_again = 0 WHERE id = ?')
                    ->execute([$pos, revealAround(str_repeat('0', N * N), $pos), $p['id']]);
            }
            logEvent($pdo, (int)$room['id'], null, 'dusk', ['again' => true]);
        }
        $pdo->commit();
        sendJson(['ok' => true]);
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $e;
    }
}

function leaveRoom(): void {
    $body = readBody();
    $code = normalizeCode($body['code'] ?? '');
    $token = (string)($body['token'] ?? '');
    if (!isValidCode($code)) sendError('Bad code', 422, ['reason' => 'badCode']);
    $pdo = db();
    $st = $pdo->prepare('SELECT * FROM bearing_rooms WHERE code = ?');
    $st->execute([$code]);
    $room = $st->fetch(PDO::FETCH_ASSOC);
    if (!$room) sendError('No such room', 404, ['reason' => 'noRoom']);
    $me = playerByToken($pdo, (int)$room['id'], $token);
    if ($me) {
        $pdo->prepare('UPDATE bearing_players SET left_at = NOW() WHERE id = ?')->execute([$me['id']]);
        logEvent($pdo, (int)$room['id'], (int)$me['id'], 'left', ['seat' => (int)$me['seat']]);
    }
    sendJson(['ok' => true]);
}
