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

// No auth include on purpose: rooms are anonymous and throwaway. A player is
// a secret token minted at create/join/reclaim, stored only as a SHA-256 hash.
//
// THE AUTHORITY RULE. The server owns the valley: terrain, the animals and
// their movement all derive from bearing_rooms.seed and are generated here.
// A client posts an intent (sweep this collar, walk to this cell, log a fix
// here) and everything else in the body is ignored.
//
// WHAT IS DELIBERATELY NOT SECRET. A sweep hands back the whole 360-sample
// trace, and the true bearing is the peak of it. That IS the game: the skill
// is reading it well. Reading it perfectly by script would only be cheating
// if there were an opponent, and there is not: both seats want the same
// outcome. So the trace goes over honestly. What never goes over is where
// the animal actually IS, because distance is the thing the pair has to earn
// by crossing two bearings from two different places.

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
const N = 32;                    // valley is N x N cells
const CELL_M = 100;              // one cell is a hundred metres
const CYCLES = 24;               // dusk to dawn
const EVENT_PAGE = 200;
const IDLE_ROOM_HOURS = 6;
const RECLAIM_IDLE_SECONDS = 20;
const ONLINE_SECONDS = 25;
const SWEEP_MINUTES = 15;
const MOVE_MAX = 6;              // cells a station can walk in one cycle
const FIX_TIGHT_M = 250;         // a fix this close to truth counts as tight
const COLLARS = ['F2', 'M7', 'F9'];
// Two questions a night can ask, both answerable from the fixes alone.
// 'den': she stops moving and doubles her pulse. Find where.
// 'silent': a collar fails partway through and is never heard again.
//            Whatever you had on it by then is all you will ever have.
const BRIEFS = ['den', 'silent'];

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

/* ---- deterministic noise, mirrored in views/bearing/logic.js -------------
   Same integer hash on both sides so a trace generated here and a trace
   generated in the practice trainer behave identically. */
function hash32(int $x): float {
    $x = ($x ^ 61) ^ (($x >> 16) & 0xFFFF);
    $x = ($x + ($x << 3)) & 0xFFFFFFFF;
    $x = $x ^ (($x >> 4) & 0x0FFFFFFF);
    $x = ($x * 0x27d4eb2d) & 0xFFFFFFFF;
    $x = $x ^ (($x >> 15) & 0x1FFFF);
    return ($x & 0xFFFFFFFF) / 4294967296.0;
}
function valueNoise(float $pos, int $period, int $salt): float {
    $s = $pos / $period; $i = (int)floor($s); $f = $s - $i;
    $h0 = hash32($i * 7919 + $salt); $h1 = hash32(($i + 1) * 7919 + $salt);
    $t = $f * $f * (3 - 2 * $f);
    return $h0 + ($h1 - $h0) * $t;
}

/* ------------------------------------------------------------- the valley */

/** Row-major elevation, one digit per cell. Ridges are what make a bearing
    lie, so the generator has to produce real ones rather than gentle hills. */
function generateTerrain(int $seed): string {
    $out = '';
    for ($y = 0; $y < N; $y++) {
        for ($x = 0; $x < N; $x++) {
            $v  = valueNoise($x + $y * 0.37, 9, $seed) * 0.55;
            $v += valueNoise($y - $x * 0.29, 7, $seed + 991) * 0.45;
            $v += valueNoise($x * 0.6 + $y * 0.6, 3, $seed + 5077) * 0.22;
            // a valley floor: pull the middle band down so there is somewhere to walk
            $v -= 0.30 * exp(-pow(($y - N / 2) / (N * 0.28), 2));
            $d = (int)max(0, min(9, round($v * 11)));
            $out .= (string)$d;
        }
    }
    return $out;
}
function elevAt(string $terrain, int $x, int $y): int {
    if ($x < 0 || $y < 0 || $x >= N || $y >= N) return 0;
    return (int)$terrain[$y * N + $x];
}
function cellIndex(int $x, int $y): int { return $y * N + $x; }
function cellXY(int $idx): array { return [$idx % N, intdiv($idx, N)]; }

/** Does the ground get in the way? Walk the line and compare each cell's
    height against the straight path between the two ends. */
function lineOfSight(string $terrain, array $from, array $to): array {
    [$x0, $y0] = $from; [$x1, $y1] = $to;
    $steps = (int)max(1, ceil(max(abs($x1 - $x0), abs($y1 - $y0))));
    $h0 = elevAt($terrain, $x0, $y0) + 2;   // an antenna is held up
    $h1 = elevAt($terrain, $x1, $y1) + 1;   // a collar is on an animal
    $worst = null; $worstBy = 0.0;
    for ($i = 1; $i < $steps; $i++) {
        $f = $i / $steps;
        $x = (int)round($x0 + ($x1 - $x0) * $f);
        $y = (int)round($y0 + ($y1 - $y0) * $f);
        $line = $h0 + ($h1 - $h0) * $f;
        $ground = elevAt($terrain, $x, $y);
        if ($ground > $line && ($ground - $line) > $worstBy) {
            $worstBy = $ground - $line; $worst = [$x, $y];
        }
    }
    return ['clear' => $worst === null, 'ridge' => $worst, 'by' => $worstBy];
}

function bearingBetween(array $from, array $to): float {
    $deg = atan2($to[0] - $from[0], -($to[1] - $from[1])) * 180 / M_PI;
    return fmod($deg + 360, 360);
}
function angleDelta(float $a, float $b): float {
    return fmod(fmod($a - $b, 360) + 540, 360) - 180;
}

/** The 360-sample trace a station hears when it sweeps a collar.
    When a ridge blocks the path the signal does not vanish: it arrives off
    the reflecting slope instead, so the trace shows a confident hump in
    the wrong direction. That is the whole reason two opinions beat one. */
function sweepTrace(string $terrain, array $station, array $animal, int $seed, int $cycle, string $collar): array {
    $los = lineOfSight($terrain, $station, $animal);
    $source = $los['clear'] ? $animal : $los['ridge'];
    $true = bearingBetween($station, $source);
    $dist = sqrt(pow($animal[0] - $station[0], 2) + pow($animal[1] - $station[1], 2));
    $reach = 1 - min(0.5, $dist / 36);
    if (!$los['clear']) $reach *= 0.55;      // a bounce is quieter and broader
    $lobe = $los['clear'] ? 5 : 3;           // and its hump is fatter

    $salt = $seed * 31 + $cycle * 7 + crc32($collar);
    $out = [];
    for ($a = 0; $a < 360; $a++) {
        $d = abs(angleDelta((float)$a, $true));
        $main = pow(max(0, cos($d * M_PI / 180)), $lobe);
        $back = 0.13 * pow(max(0, cos((180 - $d) * M_PI / 180)), 8);
        $noise = (valueNoise((float)$a, 9, $salt) * 0.62 + valueNoise((float)$a, 3, $salt + 17) * 0.38) - 0.5;
        $v = ($main + $back) * $reach + 0.06 + $noise * (0.09 + 0.16 * (1 - $reach));
        $out[] = (int)round(max(0, min(1, $v)) * 1000);
    }
    return ['trace' => $out, 'bounced' => !$los['clear']];
}

/* ------------------------------------------------------------- the animals */

function seedAnimals(PDO $pdo, int $roomId, int $seed, string $terrain): void {
    $ins = $pdo->prepare(
        'INSERT INTO bearing_animals (room_id, collar, at, duty, phase, pace) VALUES (?, ?, ?, ?, ?, ?)');
    $i = 0;
    foreach (COLLARS as $collar) {
        // spread them across the valley, away from the edges
        $x = 3 + (int)floor(hash32($seed + $i * 733) * (N - 6));
        $y = 3 + (int)floor(hash32($seed + $i * 977 + 41) * (N - 6));
        $duty = [1, 2, 2][$i];                       // F2 every cycle, the others alternate
        $phase = [0, 0, 1][$i];
        $pace = [2, 3, 2][$i];
        $ins->execute([$roomId, $collar, cellIndex($x, $y), $duty, $phase, $pace]);
        $i++;
    }
}

/** Everything moves once both seats have committed. A denned collar does not. */
function moveAnimals(PDO $pdo, array $room): void {
    $rows = $pdo->prepare('SELECT * FROM bearing_animals WHERE room_id = ?');
    $rows->execute([$room['id']]);
    $upd = $pdo->prepare('UPDATE bearing_animals SET at = ?, denned = ? WHERE id = ?');
    $cycle = (int)$room['cycle'];
    foreach ($rows->fetchAll(PDO::FETCH_ASSOC) as $a) {
        $denned = (int)$a['denned'];
        if ($a['collar'] === $room['brief_collar'] && $cycle >= (int)$room['den_cycle']) $denned = 1;
        if ($denned) { $upd->execute([(int)$a['at'], 1, $a['id']]); continue; }
        [$x, $y] = cellXY((int)$a['at']);
        $dir = hash32((int)$room['seed'] + crc32($a['collar']) + $cycle * 131) * 2 * M_PI;
        $step = (int)$a['pace'];
        $nx = max(1, min(N - 2, $x + (int)round(cos($dir) * $step)));
        $ny = max(1, min(N - 2, $y + (int)round(sin($dir) * $step)));
        $upd->execute([cellIndex($nx, $ny), 0, $a['id']]);
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
        'brief'   => $room['brief'],
        'collar'  => $room['brief_collar'],
        'collars' => COLLARS,
        'n'       => N,
        'cellM'   => CELL_M,
    ];
}
function collarSchedule(PDO $pdo, int $roomId): array {
    $st = $pdo->prepare('SELECT collar, duty, phase, denned FROM bearing_animals WHERE room_id = ?');
    $st->execute([$roomId]);
    $out = [];
    foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $a) {
        // duty and phase are published: sweeping a silent collar should be a
        // planning mistake, never a guess. `denned` is only ever true once the
        // pair could already hear the doubled pulse for themselves.
        $out[] = ['collar' => $a['collar'], 'duty' => (int)$a['duty'],
                  'phase' => (int)$a['phase'], 'fast' => (int)$a['denned'] === 1];
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

/* ---------------------------------------------------------------- actions */

$action = $_GET['action'] ?? '';
try {
    Database::init();
    switch ($action) {
        case 'create':  createRoom();  break;
        case 'join':    joinRoom();    break;
        case 'seats':   listSeats();   break;
        case 'reclaim': reclaimSeat(); break;
        case 'poll':    pollRoom();    break;
        case 'commit':  postCommit();  break;
        case 'read':    postRead();    break;
        case 'again':   postAgain();   break;
        case 'leave':   leaveRoom();   break;
        default: sendError('Unknown action', 404);
    }
} catch (Throwable $e) {
    global $DEV_MODE;
    sendError(($DEV_MODE ?? false) ? $e->getMessage() : 'Internal server error', 500);
}

function createRoom(): void {
    $body = readBody();
    $name = cleanName($body['name'] ?? '');
    if ($name === '') sendError('Bad name', 422, ['reason' => 'badName']);

    $pdo = db();
    purgeIdleRooms($pdo);
    $seed = random_int(1, 2000000000);
    $terrain = generateTerrain($seed);
    $brief = BRIEFS[$seed % count(BRIEFS)];
    $briefCollar = COLLARS[($seed >> 3) % count(COLLARS)];
    $denCycle = 9 + ($seed % 8);

    for ($attempt = 0; $attempt < 6; $attempt++) {
        $code = '';
        for ($i = 0; $i < 4; $i++) $code .= CODE_ALPHABET[random_int(0, strlen(CODE_ALPHABET) - 1)];
        try {
            $pdo->beginTransaction();
            $st = $pdo->prepare(
                'INSERT INTO bearing_rooms (code, status, seed, terrain, cycle, cycles, brief, brief_collar, den_cycle)
                 VALUES (?, "lobby", ?, ?, 0, ?, ?, ?, ?)');
            $st->execute([$code, $seed, $terrain, CYCLES, $brief, $briefCollar, $denCycle]);
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
            [$nx, $ny] = cellXY($at); [$ox, $oy] = cellXY((int)$me['pos']);
            if (max(abs($nx - $ox), abs($ny - $oy)) > MOVE_MAX) { $pdo->rollBack(); sendError('Too far to walk', 422, ['reason' => 'tooFar']); }
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
        'collar' => $collar, 'deg' => round($deg, 1),
        'sigma' => round(max(0.2, min(45, $sigma)), 2), 'from' => (int)$me['pos'], 'seat' => (int)$me['seat'],
    ]);
    sendJson(['ok' => true]);
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

    // the night's turn: she dens, or a collar fails
    if ($cycle === (int)$room['den_cycle']) {
        $target = $animals[$room['brief_collar']] ?? null;
        if ($target) {
            if ($room['brief'] === 'den') {
                $pdo->prepare('UPDATE bearing_animals SET denned = 1 WHERE id = ?')->execute([$target['id']]);
                logEvent($pdo, $roomId, null, 'den', ['collar' => $room['brief_collar']]);
            } else {
                $pdo->prepare('UPDATE bearing_animals SET duty = 0 WHERE id = ?')->execute([$target['id']]);
                logEvent($pdo, $roomId, null, 'silent', ['collar' => $room['brief_collar']]);
            }
            $pdo->prepare('UPDATE bearing_rooms SET den_at = ? WHERE id = ?')
                ->execute([(int)$target['at'], $roomId]);
        }
    }
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
                                  (int)$room['seed'], $cycle, $act['collar']);
                logEvent($pdo, $roomId, (int)$p['id'], 'trace', [
                    'collar' => $act['collar'], 'seat' => (int)$p['seat'], 'from' => (int)$p['pos'],
                    'fast' => (int)$a['denned'] === 1, 'trace' => $res['trace'],
                ]);
            }

        } elseif ($act['kind'] === 'log') {
            $a = $animals[$act['collar']] ?? null;
            if ($a) {
                [$gx, $gy] = cellXY((int)$act['at']);
                [$tx, $ty] = cellXY((int)$a['at']);
                $errM = sqrt(pow($gx - $tx, 2) + pow($gy - $ty, 2)) * CELL_M;
                $grade = $errM < FIX_TIGHT_M ? 'tight' : ($errM < 550 ? 'usable' : ($errM < 1100 ? 'loose' : 'miss'));
                $pdo->prepare('UPDATE bearing_players SET fixes_logged = fixes_logged + 1 WHERE id = ?')
                    ->execute([$p['id']]);
                // The distance is graded, never the truth: telling the pair
                // exactly how wrong they were would hand them the answer.
                logEvent($pdo, $roomId, (int)$p['id'], 'fix', [
                    'collar' => $act['collar'], 'at' => (int)$act['at'],
                    'grade' => $grade, 'seat' => (int)$p['seat'],
                ]);
            }
        }
    }

    $room['cycle'] = $cycle;
    moveAnimals($pdo, $room);
    $pdo->prepare('UPDATE bearing_players SET committed_action = NULL WHERE room_id = ?')->execute([$roomId]);

    if ($cycle + 1 >= (int)$room['cycles']) {
        $pdo->prepare('UPDATE bearing_rooms SET status = "dawn", last_active = NOW() WHERE id = ?')->execute([$roomId]);
        logEvent($pdo, $roomId, null, 'dawn', dawnReport($pdo, $roomId));
    } else {
        logEvent($pdo, $roomId, null, 'cycle', ['cycle' => $cycle + 1]);
    }
}

/** Dawn is the only moment the truth is published, because the night is
    over and there is nothing left to earn. */
function dawnReport(PDO $pdo, int $roomId): array {
    $st = $pdo->prepare('SELECT * FROM bearing_rooms WHERE id = ?');
    $st->execute([$roomId]);
    $room = $st->fetch(PDO::FETCH_ASSOC);

    $ev = $pdo->prepare("SELECT data FROM bearing_events WHERE room_id = ? AND type = 'fix' ORDER BY id");
    $ev->execute([$roomId]);
    $perCollar = [];
    foreach (COLLARS as $c) $perCollar[$c] = ['fixes' => 0, 'tight' => 0];
    $answered = false;
    foreach ($ev->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $d = json_decode((string)$row['data'], true);
        if (!is_array($d)) continue;
        $c = $d['collar'] ?? '';
        if (!isset($perCollar[$c])) continue;
        $perCollar[$c]['fixes']++;
        if (($d['grade'] ?? '') === 'tight') {
            $perCollar[$c]['tight']++;
            if ($c === $room['brief_collar']) $answered = true;
        }
    }

    $animals = animalsByCollar($pdo, $roomId);
    $truth = [];
    foreach ($animals as $c => $a) $truth[$c] = (int)$a['at'];

    $tight = array_sum(array_column($perCollar, 'tight'));
    $total = array_sum(array_column($perCollar, 'fixes'));
    return [
        'brief' => $room['brief'],
        'collar' => $room['brief_collar'],
        'answered' => $answered,
        'answerAt' => $room['den_at'] === null ? null : (int)$room['den_at'],
        'perCollar' => $perCollar,
        'fixes' => $total,
        'tight' => $tight,
        'truth' => $truth,
        'grade' => $answered && $tight >= 3 ? 'good' : ($answered || $tight >= 2 ? 'partial' : 'thin'),
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
            $terrain = generateTerrain($seed);
            $brief = BRIEFS[$seed % count(BRIEFS)];
            $briefCollar = COLLARS[($seed >> 3) % count(COLLARS)];
            $pdo->prepare(
                'UPDATE bearing_rooms SET status = "night", seed = ?, terrain = ?, cycle = 0,
                 brief = ?, brief_collar = ?, den_cycle = ?, den_at = NULL, last_active = NOW() WHERE id = ?')
                ->execute([$seed, $terrain, $brief, $briefCollar, 9 + ($seed % 8), $room['id']]);
            $pdo->prepare('DELETE FROM bearing_animals WHERE room_id = ?')->execute([$room['id']]);
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
