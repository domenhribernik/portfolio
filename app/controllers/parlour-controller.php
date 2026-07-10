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

// No auth include on purpose: rooms are anonymous and throwaway. A guest is
// identified by the secret token minted at create/join time, stored only as
// a SHA-256 hash (same rule as the sessions table). Tokens travel in JSON
// POST bodies, never in URLs, so they stay out of access logs.

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

// No vowels: codes can never spell words, and there are no 0/O 1/I lookalikes.
const CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
// Stroke palette indexes are 0..INK_COUNT-1; -1 is the eraser. The hex values
// live in views/parlour/logic.js (INKS); the server only validates the range.
const INK_COUNT = 10;
// Active (not left) guests a room seats.
const ROOM_CAP = 12;
// Rooms idle this long are purged whenever someone opens a new room.
const IDLE_ROOM_HOURS = 12;
// Events per poll page; a client that gets a full page polls again at once.
const EVENT_PAGE = 400;
// The shared sheet every client draws on, in logical pixels. Clients render
// it letterboxed at any display size; coordinates on the wire live here.
const CANVAS_W = 1500;
const CANVAS_H = 1000;
// Per chunk, after client-side thinning. A chunk is one flush of the pen.
const MAX_CHUNK_POINTS = 600;

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
        case 'poll':
            pollRoom($body);
            break;
        case 'event':
            postEvent($body);
            break;
        case 'leave':
            leaveRoom($body);
            break;
        default:
            sendError('Unknown action', 400);
    }
} catch (InvalidArgumentException $e) {
    sendError($e->getMessage(), 400);
} catch (\Throwable $e) {
    global $DEV_MODE;
    error_log('Parlour controller error: ' . $e->getMessage() . ' in ' . $e->getFile() . ':' . $e->getLine());
    $msg = ($DEV_MODE ?? false)
        ? get_class($e) . ': ' . $e->getMessage() . ' [' . basename($e->getFile()) . ':' . $e->getLine() . ']'
        : 'Internal server error';
    sendError($msg, 500);
}

// ------------------------------------------------------------------
//  Actions
// ------------------------------------------------------------------

function createRoom(array $body): void
{
    $name  = validateGuestName($body['name'] ?? null);
    $db    = Database::write();
    $token = bin2hex(random_bytes(16));

    // The janitor: rooms are throwaway, so the rare create request pays for
    // purging idle ones (deletes cascade to guests and events).
    $db->exec('DELETE FROM parlour_rooms WHERE last_active < NOW() - INTERVAL ' . IDLE_ROOM_HOURS . ' HOUR');

    // Room codes are random; on the rare UNIQUE collision, redraw.
    for ($attempt = 0; $attempt < 6; $attempt++) {
        $code = roomCode();
        try {
            $db->beginTransaction();
            $db->prepare('INSERT INTO parlour_rooms (code) VALUES (?)')->execute([$code]);
            $roomId = (int) $db->lastInsertId();
            $db->prepare(
                'INSERT INTO parlour_guests (room_id, token_hash, name, ink, is_host) VALUES (?, ?, ?, 0, 1)'
            )->execute([$roomId, hash('sha256', $token), $name]);
            $guestId = (int) $db->lastInsertId();
            $db->commit();
            sendJson([
                'code'  => $code,
                'token' => $token,
                'you'   => ['id' => $guestId, 'host' => true, 'ink' => 0],
                'room'  => ['code' => $code, 'status' => 'lobby'],
            ], 201);
        } catch (PDOException $e) {
            if ($db->inTransaction()) {
                $db->rollBack();
            }
            if ((int) ($e->errorInfo[1] ?? 0) === 1062) {
                continue;
            }
            throw $e;
        }
    }
    sendError('Could not allocate a room code, try again', 503);
}

function joinRoom(array $body): void
{
    $name = validateGuestName($body['name'] ?? null);
    $db   = Database::write();
    $room = roomByCode($db, $body['code'] ?? null);

    $seated = $db->prepare('SELECT COUNT(*) FROM parlour_guests WHERE room_id = ? AND left_at IS NULL');
    $seated->execute([(int) $room['id']]);
    if ((int) $seated->fetchColumn() >= ROOM_CAP) {
        sendError('The room is full', 409);
    }

    $token = bin2hex(random_bytes(16));
    $ink   = leastUsedInk($db, (int) $room['id']);
    $db->prepare(
        'INSERT INTO parlour_guests (room_id, token_hash, name, ink, is_host) VALUES (?, ?, ?, ?, 0)'
    )->execute([(int) $room['id'], hash('sha256', $token), $name, $ink]);
    $guestId = (int) $db->lastInsertId();

    sendJson([
        'code'  => $room['code'],
        'token' => $token,
        'you'   => ['id' => $guestId, 'host' => false, 'ink' => $ink],
        'room'  => ['code' => $room['code'], 'status' => $room['status']],
    ]);
}

function pollRoom(array $body): void
{
    // One connection for the whole request: the poll is the hot path and
    // mixes reads with heartbeat writes, so a second handshake per poll
    // would cost more than it isolates.
    $db     = Database::write();
    $room   = roomByCode($db, $body['code'] ?? null);
    $roomId = (int) $room['id'];
    $guest  = guestByToken($db, $roomId, $body['token'] ?? null);
    $since  = max(0, (int) ($body['since'] ?? 0));

    heartbeat($db, $roomId, (int) $guest['id']);

    $stmt = $db->prepare(
        'SELECT id, name, ink, is_host, (last_seen >= NOW() - INTERVAL 25 SECOND) AS online
         FROM parlour_guests WHERE room_id = ? AND left_at IS NULL
         ORDER BY joined_at ASC, id ASC'
    );
    $stmt->execute([$roomId]);
    $guests = array_map(fn (array $g) => [
        'id'     => (int) $g['id'],
        'name'   => $g['name'],
        'ink'    => (int) $g['ink'],
        'host'   => (bool) $g['is_host'],
        'online' => (bool) $g['online'],
    ], $stmt->fetchAll());

    [$events, $last, $more] = eventsSince($db, $roomId, $since);

    sendJson([
        'room'   => ['code' => $room['code'], 'status' => $room['status']],
        'you'    => ['id' => (int) $guest['id'], 'host' => (bool) $guest['is_host'], 'ink' => (int) $guest['ink']],
        'guests' => $guests,
        'events' => $events,
        'last'   => $last,
        'more'   => $more,
    ]);
}

/**
 * Appends one event to the room's log after per-type authorization. This is
 * the extension point of the whole feature: a new game action is a new type
 * branch here plus a reducer branch in views/parlour/logic.js.
 */
function postEvent(array $body): void
{
    $db     = Database::write();
    $room   = roomByCode($db, $body['code'] ?? null);
    $roomId = (int) $room['id'];
    $guest  = guestByToken($db, $roomId, $body['token'] ?? null);
    $type   = $body['type'] ?? '';

    switch ($type) {
        case 'stroke':
            if ($room['status'] !== 'live') {
                sendError('The sitting has not begun', 409);
            }
            $data = validateStroke($body['data'] ?? null, (int) $guest['id']);
            break;
        case 'start':
            if (!(bool) $guest['is_host']) {
                sendError('Only the host may ring the bell', 403);
            }
            if ($room['status'] !== 'lobby') {
                sendError('The sitting has already begun', 409);
            }
            $db->prepare("UPDATE parlour_rooms SET status = 'live' WHERE id = ?")->execute([$roomId]);
            $data = null;
            break;
        case 'clear':
            if (!(bool) $guest['is_host']) {
                sendError('Only the host may fetch a fresh sheet', 403);
            }
            if ($room['status'] !== 'live') {
                sendError('The sitting has not begun', 409);
            }
            $data = null;
            break;
        default:
            sendError('Unknown event type', 400);
    }

    $db->prepare(
        'INSERT INTO parlour_events (room_id, guest_id, type, data) VALUES (?, ?, ?, ?)'
    )->execute([$roomId, (int) $guest['id'], $type, $data !== null ? json_encode($data) : null]);
    $seq = (int) $db->lastInsertId();

    if ($type === 'clear') {
        // A fresh sheet makes every older stroke invisible on all clients,
        // so compact them out of the log: late joiners replay less and
        // storage stays flat however long a room runs.
        $db->prepare(
            "DELETE FROM parlour_events WHERE room_id = ? AND id < ? AND type = 'stroke'"
        )->execute([$roomId, $seq]);
    }

    // Any accepted event counts as room activity.
    $db->prepare(
        'UPDATE parlour_rooms SET last_active = NOW()
         WHERE id = ? AND last_active < NOW() - INTERVAL 60 SECOND'
    )->execute([$roomId]);

    sendJson(['seq' => $seq]);
}

function leaveRoom(array $body): void
{
    $db    = Database::write();
    $room  = roomByCode($db, $body['code'] ?? null);
    $guest = guestByToken($db, (int) $room['id'], $body['token'] ?? null);
    $db->prepare('UPDATE parlour_guests SET left_at = NOW() WHERE id = ?')
       ->execute([(int) $guest['id']]);
    sendJson(['ok' => true]);
}

// ------------------------------------------------------------------
//  Room and guest lookup
// ------------------------------------------------------------------

/** @return array{id:string, code:string, status:string} */
function roomByCode(PDO $db, mixed $raw): array
{
    // Be liberal with what guests typed (case, spaces); malformed codes are
    // indistinguishable from missing rooms on purpose.
    $code = is_string($raw) ? strtoupper(trim($raw)) : '';
    if (preg_match('/^[A-Z]{4}$/', $code) !== 1) {
        sendError('Room not found', 404);
    }
    $stmt = $db->prepare('SELECT id, code, status FROM parlour_rooms WHERE code = ?');
    $stmt->execute([$code]);
    $room = $stmt->fetch();
    if (!$room) {
        sendError('Room not found', 404);
    }
    return $room;
}

/** Least-used palette index among the room's active guests (ties go low). */
function leastUsedInk(PDO $db, int $roomId): int
{
    $stmt = $db->prepare(
        'SELECT ink, COUNT(*) AS c FROM parlour_guests
         WHERE room_id = ? AND left_at IS NULL GROUP BY ink'
    );
    $stmt->execute([$roomId]);
    $used = array_fill(0, INK_COUNT, 0);
    foreach ($stmt as $row) {
        $i = (int) $row['ink'];
        if ($i >= 0 && $i < INK_COUNT) {
            $used[$i] += (int) $row['c'];
        }
    }
    $best = 0;
    foreach ($used as $i => $count) {
        if ($count < $used[$best]) {
            $best = $i;
        }
    }
    return $best;
}

/** @return array{id:string, is_host:string, ink:string} */
function guestByToken(PDO $db, int $roomId, mixed $raw): array
{
    $token = is_string($raw) ? $raw : '';
    if (preg_match('/^[a-f0-9]{32}$/', $token) !== 1) {
        sendError('Not in this room', 401);
    }
    $stmt = $db->prepare(
        'SELECT id, is_host, ink FROM parlour_guests
         WHERE room_id = ? AND token_hash = ? AND left_at IS NULL'
    );
    $stmt->execute([$roomId, hash('sha256', $token)]);
    $guest = $stmt->fetch();
    if (!$guest) {
        sendError('Not in this room', 401);
    }
    return $guest;
}

// ------------------------------------------------------------------
//  Presence and the event log
// ------------------------------------------------------------------

function heartbeat(PDO $db, int $roomId, int $guestId): void
{
    // Presence only needs ~10s granularity; skipping fresh rows keeps the
    // hot poll path nearly write-free.
    $db->prepare(
        'UPDATE parlour_guests SET last_seen = NOW()
         WHERE id = ? AND last_seen < NOW() - INTERVAL 10 SECOND'
    )->execute([$guestId]);

    // Sweep guests who stopped polling long ago. Runs after the self-bump,
    // so a returning sleeper is never swept by their own poll.
    $db->prepare(
        'UPDATE parlour_guests SET left_at = NOW()
         WHERE room_id = ? AND left_at IS NULL AND last_seen < NOW() - INTERVAL 15 MINUTE'
    )->execute([$roomId]);

    // Keep the room off the idle-purge list while anyone is still polling.
    $db->prepare(
        'UPDATE parlour_rooms SET last_active = NOW()
         WHERE id = ? AND last_active < NOW() - INTERVAL 60 SECOND'
    )->execute([$roomId]);
}

/** @return array{0: list<array<string, mixed>>, 1: int, 2: bool} */
function eventsSince(PDO $db, int $roomId, int $since): array
{
    $stmt = $db->prepare(
        'SELECT id, guest_id, type, data FROM parlour_events
         WHERE room_id = ? AND id > ? ORDER BY id ASC LIMIT ' . (EVENT_PAGE + 1)
    );
    $stmt->execute([$roomId, $since]);
    $rows = $stmt->fetchAll();
    $more = count($rows) > EVENT_PAGE;
    if ($more) {
        array_pop($rows);
    }
    $last   = $since;
    $events = [];
    foreach ($rows as $r) {
        $last     = max($last, (int) $r['id']);
        $events[] = [
            'seq'   => (int) $r['id'],
            'guest' => $r['guest_id'] !== null ? (int) $r['guest_id'] : null,
            'type'  => $r['type'],
            'data'  => $r['data'] !== null ? json_decode($r['data'], true) : null,
        ];
    }
    return [$events, $last, $more];
}

// ------------------------------------------------------------------
//  Validation
// ------------------------------------------------------------------

/**
 * Validates one stroke chunk and returns it in canonical form (ints only,
 * clamped to the sheet). Chunks of one stroke share a client-minted sid of
 * the form "<guestId>.<n>"; requiring the sender's own guest id in it means
 * nobody can append to, or restyle, another guest's stroke.
 */
function validateStroke(mixed $raw, int $guestId): array
{
    if (!is_array($raw)) {
        sendError('Stroke data required', 400);
    }
    $sid = $raw['sid'] ?? null;
    if (!is_string($sid) || preg_match('/^\d{1,10}\.\d{1,9}$/', $sid) !== 1
        || !str_starts_with($sid, $guestId . '.')) {
        sendError('Bad stroke id', 400);
    }
    $ink = $raw['ink'] ?? null;
    if (!is_int($ink) || $ink < -1 || $ink >= INK_COUNT) {
        sendError('Bad ink', 400);
    }
    $size = $raw['size'] ?? null;
    if (!is_int($size) || $size < 2 || $size > 40) {
        sendError('Bad nib size', 400);
    }
    $pts = $raw['pts'] ?? null;
    if (!is_array($pts) || !array_is_list($pts) || count($pts) < 2
        || count($pts) > MAX_CHUNK_POINTS * 2 || count($pts) % 2 !== 0) {
        sendError('Bad stroke points', 400);
    }
    $clean = [];
    foreach ($pts as $i => $v) {
        if (!is_int($v) && !is_float($v)) {
            sendError('Bad stroke points', 400);
        }
        $limit   = ($i % 2 === 0) ? CANVAS_W : CANVAS_H;
        $clean[] = (int) max(0, min($limit, round($v)));
    }
    $data = ['sid' => $sid, 'ink' => $ink, 'size' => $size, 'pts' => $clean];
    if (($raw['end'] ?? false) === true) {
        $data['end'] = true;
    }
    return $data;
}

function validateGuestName(mixed $raw): string
{
    $name = is_string($raw) ? preg_replace('/[\x00-\x1f\x7f]/u', '', $raw) : '';
    $name = trim(preg_replace('/\s+/u', ' ', $name ?? ''));
    if ($name === '' || mb_strlen($name) > 20) {
        sendError('Name is required (max 20 chars)', 400);
    }
    return $name;
}

// ------------------------------------------------------------------
//  Helpers
// ------------------------------------------------------------------

function roomCode(): string
{
    $code = '';
    for ($i = 0; $i < 4; $i++) {
        $code .= CODE_ALPHABET[random_int(0, strlen(CODE_ALPHABET) - 1)];
    }
    return $code;
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

function sendError(string $message, int $code = 400): void
{
    http_response_code($code);
    echo json_encode(['error' => $message], JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}
