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

// No auth include on purpose: rooms are anonymous and throwaway. A player is
// identified by the secret token minted at create/join/reclaim time, stored
// only as a SHA-256 hash (same rule as the sessions table). Tokens travel in
// JSON POST bodies, never in URLs, so they stay out of access logs.
//
// THE SECRECY RULE, which is what makes this game different from the parlour
// it is built on: spy_players.role and spy_rooms.location are secrets. The
// event log is public to the room, so neither may ever be written into an
// event. They leave this file in exactly two places: the `you` block of a
// poll response (the polling player's own role, plus the location only when
// that player is a citizen) and the `reveal` block, which exists only once
// the room reaches 'debrief'. Nothing else selects those columns.

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
// Active (not left) players a room seats. Matches MAX_PLAYERS in logic.js.
const ROOM_CAP = 20;
// Below this the deal is refused; a spy needs a crowd to hide in.
const MIN_PLAYERS = 3;
// Round length bounds. Mirrored in views/spy/logic.js: change them in both.
const MIN_ROUND_SECONDS = 60;
const MAX_ROUND_SECONDS = 1800;
const ROUND_STEP_SECONDS = 60;
// Rooms idle this long are purged whenever someone opens a new room.
const IDLE_ROOM_HOURS = 6;
// Events per poll page; a client that gets a full page polls again at once.
const EVENT_PAGE = 200;
// A seat is only reclaimable once its phone has been silent this long, so a
// player cannot be shoved out of their own live game.
const RECLAIM_IDLE_SECONDS = 20;
// Presence: seen within this many seconds counts as online.
const ONLINE_SECONDS = 25;
// Players silent this long lose their seat (and their token).
const SWEEP_MINUTES = 15;

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
    error_log('Spy controller error: ' . $e->getMessage() . ' in ' . $e->getFile() . ':' . $e->getLine());
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
    $name  = validatePlayerName($body['name'] ?? null);
    $db    = Database::write();
    $token = bin2hex(random_bytes(16));

    // The janitor: rooms are throwaway, so the rare create request pays for
    // purging idle ones (deletes cascade to players and events).
    $db->exec('DELETE FROM spy_rooms WHERE last_active < NOW() - INTERVAL ' . IDLE_ROOM_HOURS . ' HOUR');

    // Room codes are random; on the rare UNIQUE collision, redraw.
    for ($attempt = 0; $attempt < 6; $attempt++) {
        $code = roomCode();
        try {
            $db->beginTransaction();
            $db->prepare('INSERT INTO spy_rooms (code) VALUES (?)')->execute([$code]);
            $roomId = (int) $db->lastInsertId();
            $db->prepare(
                'INSERT INTO spy_players (room_id, token_hash, name, is_host) VALUES (?, ?, ?, 1)'
            )->execute([$roomId, hash('sha256', $token), $name]);
            $playerId = (int) $db->lastInsertId();
            $db->commit();
            sendJson([
                'code'  => $code,
                'token' => $token,
                'you'   => ['id' => $playerId, 'host' => true, 'ready' => false, 'role' => null, 'location' => null],
                'room'  => ['code' => $code, 'status' => 'lobby', 'spies' => 1, 'roundSeconds' => 300],
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
    $name = validatePlayerName($body['name'] ?? null);
    $db   = Database::write();
    $room = roomByCode($db, $body['code'] ?? null);

    // Joining mid-game would leave the newcomer without a role, so the door
    // shuts once roles are dealt. The `reclaim` flag tells the client to
    // offer the seat picker instead of just failing.
    if ($room['status'] !== 'lobby') {
        sendError('That game is already under way', 409, ['reclaim' => true]);
    }

    $seated = $db->prepare('SELECT COUNT(*) FROM spy_players WHERE room_id = ? AND left_at IS NULL');
    $seated->execute([(int) $room['id']]);
    if ((int) $seated->fetchColumn() >= ROOM_CAP) {
        sendError('The room is full', 409);
    }

    // Names double as seat labels in the reclaim picker and in the dossier,
    // so two people cannot answer to the same one. The column collation is
    // case-insensitive, so this catches "Ana" against "ana" too.
    $taken = $db->prepare('SELECT COUNT(*) FROM spy_players WHERE room_id = ? AND left_at IS NULL AND name = ?');
    $taken->execute([(int) $room['id'], $name]);
    if ((int) $taken->fetchColumn() > 0) {
        sendError('Someone in that room already goes by that name', 409);
    }

    $token = bin2hex(random_bytes(16));
    $db->prepare(
        'INSERT INTO spy_players (room_id, token_hash, name, is_host) VALUES (?, ?, ?, 0)'
    )->execute([(int) $room['id'], hash('sha256', $token), $name]);
    $playerId = (int) $db->lastInsertId();

    sendJson([
        'code'  => $room['code'],
        'token' => $token,
        'you'   => ['id' => $playerId, 'host' => false, 'ready' => false, 'role' => null, 'location' => null],
        'room'  => roomSummary($room),
    ]);
}

/**
 * The seats in a room, for the reclaim picker a player lands on when their
 * phone lost its session mid-game. Deliberately carries no role: this is the
 * one place an un-authenticated caller reads a room, and it must stay as
 * uninteresting as the lobby everybody can see anyway.
 */
function listSeats(array $body): void
{
    $db   = Database::read();
    $room = roomByCode($db, $body['code'] ?? null);

    $stmt = $db->prepare(
        'SELECT id, name, is_host,
                (last_seen >= NOW() - INTERVAL ' . ONLINE_SECONDS . ' SECOND) AS online,
                (last_seen < NOW() - INTERVAL ' . RECLAIM_IDLE_SECONDS . ' SECOND) AS reclaimable
         FROM spy_players WHERE room_id = ? AND left_at IS NULL
         ORDER BY joined_at ASC, id ASC'
    );
    $stmt->execute([(int) $room['id']]);

    sendJson([
        'room'    => ['code' => $room['code'], 'status' => $room['status']],
        'players' => array_map(fn (array $p) => [
            'id'          => (int) $p['id'],
            'name'        => $p['name'],
            'host'        => (bool) $p['is_host'],
            'online'      => (bool) $p['online'],
            'reclaimable' => (bool) $p['reclaimable'],
        ], $stmt->fetchAll()),
    ]);
}

/**
 * Takes over a seat whose phone has gone quiet, keeping its role. The old
 * token is overwritten rather than kept alongside, so a device that comes
 * back finds itself signed out instead of shadowing the new one.
 */
function reclaimSeat(array $body): void
{
    $db   = Database::write();
    $room = roomByCode($db, $body['code'] ?? null);
    $id   = (int) ($body['playerId'] ?? 0);

    $stmt = $db->prepare(
        'SELECT id, is_host, ready, role,
                (last_seen < NOW() - INTERVAL ' . RECLAIM_IDLE_SECONDS . ' SECOND) AS idle
         FROM spy_players WHERE id = ? AND room_id = ? AND left_at IS NULL'
    );
    $stmt->execute([$id, (int) $room['id']]);
    $player = $stmt->fetch();
    if (!$player) {
        sendError('That seat is gone', 404);
    }
    if (!(bool) $player['idle']) {
        sendError('That seat is still in play', 409);
    }

    $token = bin2hex(random_bytes(16));
    $db->prepare('UPDATE spy_players SET token_hash = ?, last_seen = NOW() WHERE id = ?')
       ->execute([hash('sha256', $token), $id]);

    sendJson([
        'code'  => $room['code'],
        'token' => $token,
        'you'   => [
            'id'       => $id,
            'host'     => (bool) $player['is_host'],
            'ready'    => (bool) $player['ready'],
            'role'     => $player['role'],
            'location' => $player['role'] === 'citizen' ? $room['location'] : null,
        ],
        'room'  => roomSummary($room),
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
    $player = playerByToken($db, $roomId, $body['token'] ?? null);
    $since  = max(0, (int) ($body['since'] ?? 0));

    // No cron exists on the host, so the poll path carries the two
    // transitions nobody presses a button for. Both are guarded so that
    // exactly one of several simultaneous pollers does the write.
    heartbeat($db, $roomId, (int) $player['id']);
    expireRound($db, $roomId);

    // Re-read: the sweep, the handover and the expiry above may all have
    // moved the phase or the host on this very request.
    $room   = roomById($db, $roomId);
    $player = playerById($db, (int) $player['id']);

    // Note what this SELECT does not ask for: role. The player list is
    // public to the room, so it carries only what is safe to show everyone.
    $stmt = $db->prepare(
        'SELECT id, name, is_host, ready,
                (last_seen >= NOW() - INTERVAL ' . ONLINE_SECONDS . ' SECOND) AS online
         FROM spy_players WHERE room_id = ? AND left_at IS NULL
         ORDER BY joined_at ASC, id ASC'
    );
    $stmt->execute([$roomId]);
    $players = array_map(fn (array $p) => [
        'id'     => (int) $p['id'],
        'name'   => $p['name'],
        'host'   => (bool) $p['is_host'],
        'ready'  => (bool) $p['ready'],
        'online' => (bool) $p['online'],
    ], $stmt->fetchAll());

    [$events, $last, $more] = eventsSince($db, $roomId, $since);

    $paused   = $room['paused_seconds'] !== null;
    $response = [
        'room' => [
            'code'         => $room['code'],
            'status'       => $room['status'],
            'spies'        => (int) $room['spies'],
            'roundSeconds' => (int) $room['round_seconds'],
            'secondsLeft'  => $room['status'] === 'round'
                ? ($paused ? (int) $room['paused_seconds'] : (int) $room['seconds_left'])
                : null,
            'paused'       => $paused,
            'seated'       => count($players),
        ],
        // The only disclosure of a role, and only ever the caller's own. The
        // location rides along solely for citizens; a spy's payload must not
        // contain it anywhere, which is what the test suite pins.
        'you' => [
            'id'       => (int) $player['id'],
            'host'     => (bool) $player['is_host'],
            'ready'    => (bool) $player['ready'],
            'role'     => $player['role'],
            'location' => $player['role'] === 'citizen' ? $room['location'] : null,
        ],
        'players' => $players,
        'events'  => $events,
        'last'    => $last,
        'more'    => $more,
    ];

    // The dossier. The round is over by now, so this is safe to hand to
    // everyone; before the debrief it is not in the payload at all.
    if ($room['status'] === 'debrief') {
        // Includes players who walked out mid-round: a spy who dropped is
        // still a spy, and the table wants to know.
        $spies = $db->prepare(
            "SELECT id, name FROM spy_players WHERE room_id = ? AND role = 'spy' ORDER BY joined_at ASC, id ASC"
        );
        $spies->execute([$roomId]);
        $response['reveal'] = [
            'location' => $room['location'],
            'spies'    => array_map(
                fn (array $p) => ['id' => (int) $p['id'], 'name' => $p['name']],
                $spies->fetchAll()
            ),
        ];
    }

    sendJson($response);
}

/**
 * Appends one event to the room's log after per-type authorization, having
 * first moved whatever room state that event implies. This is the extension
 * point of the whole feature: a new game action is a new type branch here
 * plus a reducer branch in views/spy/logic.js.
 *
 * Nothing written into `data` here may be secret: the log is handed to every
 * player in the room on their next poll.
 */
function postEvent(array $body): void
{
    $db     = Database::write();
    $room   = roomByCode($db, $body['code'] ?? null);
    $roomId = (int) $room['id'];
    $player = playerByToken($db, $roomId, $body['token'] ?? null);
    $type   = $body['type'] ?? '';
    $isHost = (bool) $player['is_host'];

    switch ($type) {
        case 'deal':
            requireHost($isHost);
            if (!in_array($room['status'], ['lobby', 'debrief'], true)) {
                sendError('Roles are already in play', 409);
            }
            $data = dealRoles($db, $room);
            break;

        case 'ready':
            if ($room['status'] !== 'brief') {
                sendError('There is nothing to memorize yet', 409);
            }
            $db->prepare('UPDATE spy_players SET ready = 1 WHERE id = ?')->execute([(int) $player['id']]);
            $data = null;
            break;

        case 'start':
            requireHost($isHost);
            if ($room['status'] !== 'brief') {
                sendError('Deal the roles first', 409);
            }
            $db->prepare(
                "UPDATE spy_rooms SET status = 'round',
                        round_ends_at = NOW() + INTERVAL round_seconds SECOND,
                        paused_seconds = NULL
                 WHERE id = ?"
            )->execute([$roomId]);
            $data = null;
            break;

        case 'pause':
            requireHost($isHost);
            if ($room['status'] !== 'round' || $room['paused_seconds'] !== null) {
                sendError('The clock is not running', 409);
            }
            // Freeze what is left. Computed by MySQL so it agrees with the
            // NOW() that set round_ends_at in the first place.
            $db->prepare(
                'UPDATE spy_rooms
                 SET paused_seconds = GREATEST(0, TIMESTAMPDIFF(SECOND, NOW(), round_ends_at)),
                     round_ends_at = NULL
                 WHERE id = ? AND round_ends_at IS NOT NULL'
            )->execute([$roomId]);
            $data = null;
            break;

        case 'resume':
            requireHost($isHost);
            if ($room['status'] !== 'round' || $room['paused_seconds'] === null) {
                sendError('The clock is not paused', 409);
            }
            $db->prepare(
                'UPDATE spy_rooms SET round_ends_at = NOW() + INTERVAL paused_seconds SECOND,
                        paused_seconds = NULL
                 WHERE id = ? AND paused_seconds IS NOT NULL'
            )->execute([$roomId]);
            $data = null;
            break;

        case 'end':
            requireHost($isHost);
            if ($room['status'] !== 'round') {
                sendError('No round is running', 409);
            }
            $db->prepare(
                "UPDATE spy_rooms SET status = 'debrief', round_ends_at = NULL, paused_seconds = NULL WHERE id = ?"
            )->execute([$roomId]);
            $data = null;
            break;

        case 'again':
            requireHost($isHost);
            if ($room['status'] !== 'debrief') {
                sendError('The case is not closed yet', 409);
            }
            resetRoom($db, $roomId);
            $data = null;
            break;

        case 'settings':
            requireHost($isHost);
            if ($room['status'] !== 'lobby') {
                sendError('Settings are locked once roles are dealt', 409);
            }
            $data = applySettings($db, $roomId, $body['data'] ?? null);
            break;

        default:
            sendError('Unknown event type', 400);
    }

    $db->prepare(
        'INSERT INTO spy_events (room_id, player_id, type, data) VALUES (?, ?, ?, ?)'
    )->execute([$roomId, (int) $player['id'], $type, $data !== null ? json_encode($data) : null]);
    $seq = (int) $db->lastInsertId();

    // Any accepted event counts as room activity.
    $db->prepare(
        'UPDATE spy_rooms SET last_active = NOW()
         WHERE id = ? AND last_active < NOW() - INTERVAL 60 SECOND'
    )->execute([$roomId]);

    sendJson(['seq' => $seq]);
}

function leaveRoom(array $body): void
{
    $db     = Database::write();
    $room   = roomByCode($db, $body['code'] ?? null);
    $player = playerByToken($db, (int) $room['id'], $body['token'] ?? null);
    $db->prepare('UPDATE spy_players SET left_at = NOW() WHERE id = ?')
       ->execute([(int) $player['id']]);
    sendJson(['ok' => true]);
}

// ------------------------------------------------------------------
//  Game state
// ------------------------------------------------------------------

/**
 * Deals a fresh round: one location for the room, `spies` of the seated
 * players marked spy, everyone else citizen, and every card un-memorized.
 * Returns the event payload, which carries only the public shape of the deal
 * (how many players, how many spies), never who or where.
 */
function dealRoles(PDO $db, array $room): array
{
    $roomId = (int) $room['id'];

    $stmt = $db->prepare(
        'SELECT id FROM spy_players WHERE room_id = ? AND left_at IS NULL ORDER BY joined_at ASC, id ASC'
    );
    $stmt->execute([$roomId]);
    $ids = array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN));

    $count = count($ids);
    if ($count < MIN_PLAYERS) {
        sendError('A spy needs a crowd: ' . MIN_PLAYERS . ' players at least', 409);
    }

    // Spies never outnumber the citizens. Mirrors spyMax() in logic.js.
    $spies     = max(1, min((int) $room['spies'], intdiv($count, 2)));
    $locations = locations();
    $location  = $locations[random_int(0, count($locations) - 1)];

    // Fisher-Yates with a CSPRNG: the deal is the one thing in this game
    // that must not be predictable.
    for ($i = $count - 1; $i > 0; $i--) {
        $j = random_int(0, $i);
        [$ids[$i], $ids[$j]] = [$ids[$j], $ids[$i]];
    }
    $chosen = array_slice($ids, 0, $spies);

    $db->beginTransaction();
    $db->prepare("UPDATE spy_players SET role = 'citizen', ready = 0 WHERE room_id = ? AND left_at IS NULL")
       ->execute([$roomId]);
    $marks = implode(',', array_fill(0, count($chosen), '?'));
    $db->prepare("UPDATE spy_players SET role = 'spy' WHERE id IN ($marks)")->execute($chosen);
    $db->prepare(
        "UPDATE spy_rooms SET status = 'brief', location = ?, spies = ?,
                round_ends_at = NULL, paused_seconds = NULL
         WHERE id = ?"
    )->execute([$location, $spies, $roomId]);
    $db->commit();

    return ['players' => $count, 'spies' => $spies];
}

/** Back to the lobby: the dossier is shredded and every card goes blank. */
function resetRoom(PDO $db, int $roomId): void
{
    $db->prepare('UPDATE spy_players SET role = NULL, ready = 0 WHERE room_id = ?')->execute([$roomId]);
    $db->prepare(
        "UPDATE spy_rooms SET status = 'lobby', location = NULL,
                round_ends_at = NULL, paused_seconds = NULL
         WHERE id = ?"
    )->execute([$roomId]);
}

function applySettings(PDO $db, int $roomId, mixed $raw): array
{
    if (!is_array($raw)) {
        sendError('Settings required', 400);
    }
    $spies   = $raw['spies'] ?? null;
    $seconds = $raw['roundSeconds'] ?? null;
    if (!is_int($spies) || !is_int($seconds)) {
        sendError('Bad settings', 400);
    }

    $stmt = $db->prepare('SELECT COUNT(*) FROM spy_players WHERE room_id = ? AND left_at IS NULL');
    $stmt->execute([$roomId]);
    $seated = (int) $stmt->fetchColumn();

    $spies   = max(1, min($spies, max(1, intdiv($seated, 2))));
    $seconds = (int) round($seconds / ROUND_STEP_SECONDS) * ROUND_STEP_SECONDS;
    $seconds = max(MIN_ROUND_SECONDS, min(MAX_ROUND_SECONDS, $seconds));

    $db->prepare('UPDATE spy_rooms SET spies = ?, round_seconds = ? WHERE id = ?')
       ->execute([$spies, $seconds, $roomId]);

    return ['spies' => $spies, 'roundSeconds' => $seconds];
}

/**
 * The clock running out is a state change nobody presses a button for. The
 * guarded UPDATE means that of however many clients poll in the same second,
 * exactly one writes the transition and appends the single `end` event.
 */
function expireRound(PDO $db, int $roomId): void
{
    $stmt = $db->prepare(
        "UPDATE spy_rooms SET status = 'debrief', round_ends_at = NULL
         WHERE id = ? AND status = 'round'
           AND round_ends_at IS NOT NULL AND round_ends_at <= NOW()"
    );
    $stmt->execute([$roomId]);
    if ($stmt->rowCount() > 0) {
        $db->prepare("INSERT INTO spy_events (room_id, player_id, type) VALUES (?, NULL, 'end')")
           ->execute([$roomId]);
    }
}

/**
 * Only the host can deal or start, so a room whose host walked away would be
 * stuck for good. Promote the longest-seated player still present. The
 * target is deterministic and the UPDATE is conditional, so simultaneous
 * pollers cannot promote twice or announce it twice.
 */
function handOverHost(PDO $db, int $roomId): void
{
    $held = $db->prepare('SELECT 1 FROM spy_players WHERE room_id = ? AND left_at IS NULL AND is_host = 1 LIMIT 1');
    $held->execute([$roomId]);
    if ($held->fetchColumn() !== false) {
        return;
    }

    $next = $db->prepare(
        'SELECT id FROM spy_players WHERE room_id = ? AND left_at IS NULL ORDER BY joined_at ASC, id ASC LIMIT 1'
    );
    $next->execute([$roomId]);
    $heir = $next->fetchColumn();
    if ($heir === false) {
        return; // an empty room; the janitor will get it
    }

    $claim = $db->prepare('UPDATE spy_players SET is_host = 1 WHERE id = ? AND is_host = 0');
    $claim->execute([(int) $heir]);
    if ($claim->rowCount() > 0) {
        $db->prepare("INSERT INTO spy_events (room_id, player_id, type, data) VALUES (?, NULL, 'host', ?)")
           ->execute([$roomId, json_encode(['id' => (int) $heir])]);
    }
}

// ------------------------------------------------------------------
//  Room and player lookup
// ------------------------------------------------------------------

function roomByCode(PDO $db, mixed $raw): array
{
    // Be liberal with what players typed (case, spaces); malformed codes are
    // indistinguishable from missing rooms on purpose.
    $code = is_string($raw) ? strtoupper(trim($raw)) : '';
    if (preg_match('/^[A-Z]{4}$/', $code) !== 1) {
        sendError('Room not found', 404);
    }
    $stmt = $db->prepare(
        'SELECT id, code, status, spies, round_seconds, location, round_ends_at, paused_seconds
         FROM spy_rooms WHERE code = ?'
    );
    $stmt->execute([$code]);
    $room = $stmt->fetch();
    if (!$room) {
        sendError('Room not found', 404);
    }
    return $room;
}

/**
 * What create/join/reclaim hand back about the room. Enough for the client to
 * paint the lobby at once instead of sitting blank for a poll round-trip.
 */
function roomSummary(array $room): array
{
    return [
        'code'         => $room['code'],
        'status'       => $room['status'],
        'spies'        => (int) $room['spies'],
        'roundSeconds' => (int) $room['round_seconds'],
    ];
}

/** Re-read after the poll path's lazy transitions, with the clock resolved. */
function roomById(PDO $db, int $roomId): array
{
    $stmt = $db->prepare(
        'SELECT id, code, status, spies, round_seconds, location, paused_seconds,
                GREATEST(0, TIMESTAMPDIFF(SECOND, NOW(), round_ends_at)) AS seconds_left
         FROM spy_rooms WHERE id = ?'
    );
    $stmt->execute([$roomId]);
    $room = $stmt->fetch();
    if (!$room) {
        sendError('Room not found', 404);
    }
    return $room;
}

function playerByToken(PDO $db, int $roomId, mixed $raw): array
{
    $token = is_string($raw) ? $raw : '';
    if (preg_match('/^[a-f0-9]{32}$/', $token) !== 1) {
        sendError('Not in this room', 401);
    }
    $stmt = $db->prepare(
        'SELECT id, is_host, ready, role FROM spy_players
         WHERE room_id = ? AND token_hash = ? AND left_at IS NULL'
    );
    $stmt->execute([$roomId, hash('sha256', $token)]);
    $player = $stmt->fetch();
    if (!$player) {
        sendError('Not in this room', 401);
    }
    return $player;
}

function playerById(PDO $db, int $id): array
{
    $stmt = $db->prepare('SELECT id, is_host, ready, role FROM spy_players WHERE id = ?');
    $stmt->execute([$id]);
    $player = $stmt->fetch();
    if (!$player) {
        sendError('Not in this room', 401);
    }
    return $player;
}

// ------------------------------------------------------------------
//  Presence and the event log
// ------------------------------------------------------------------

function heartbeat(PDO $db, int $roomId, int $playerId): void
{
    // Presence only needs ~10s granularity; skipping fresh rows keeps the
    // hot poll path nearly write-free.
    $db->prepare(
        'UPDATE spy_players SET last_seen = NOW()
         WHERE id = ? AND last_seen < NOW() - INTERVAL 10 SECOND'
    )->execute([$playerId]);

    // Sweep players who stopped polling long ago. Runs after the self-bump,
    // so a returning sleeper is never swept by their own poll.
    $db->prepare(
        'UPDATE spy_players SET left_at = NOW()
         WHERE room_id = ? AND left_at IS NULL AND last_seen < NOW() - INTERVAL ' . SWEEP_MINUTES . ' MINUTE'
    )->execute([$roomId]);

    // Cheap enough to ask every poll, and it is the only thing standing
    // between a host walking out and a room nobody can start.
    handOverHost($db, $roomId);

    // Keep the room off the idle-purge list while anyone is still polling.
    $db->prepare(
        'UPDATE spy_rooms SET last_active = NOW()
         WHERE id = ? AND last_active < NOW() - INTERVAL 60 SECOND'
    )->execute([$roomId]);
}

function eventsSince(PDO $db, int $roomId, int $since): array
{
    $stmt = $db->prepare(
        'SELECT id, player_id, type, data FROM spy_events
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
            'seq'    => (int) $r['id'],
            'player' => $r['player_id'] !== null ? (int) $r['player_id'] : null,
            'type'   => $r['type'],
            'data'   => $r['data'] !== null ? json_decode($r['data'], true) : null,
        ];
    }
    return [$events, $last, $more];
}

// ------------------------------------------------------------------
//  Validation and helpers
// ------------------------------------------------------------------

/** The location list, shared with the browser. Canonical copy, no drift. */
function locations(): array
{
    static $cache = null;
    if ($cache === null) {
        $raw   = @file_get_contents(__DIR__ . '/../../views/spy/locations.json');
        $json  = $raw !== false ? json_decode($raw, true) : null;
        $list  = is_array($json['locations'] ?? null) ? $json['locations'] : [];
        $cache = array_values(array_filter($list, 'is_string'));
        if ($cache === []) {
            throw new RuntimeException('The location list is missing or empty');
        }
    }
    return $cache;
}

function requireHost(bool $isHost): void
{
    if (!$isHost) {
        sendError('Only the host runs the operation', 403);
    }
}

function validatePlayerName(mixed $raw): string
{
    $name = is_string($raw) ? preg_replace('/[\x00-\x1f\x7f]/u', '', $raw) : '';
    $name = trim(preg_replace('/\s+/u', ' ', $name ?? ''));
    if ($name === '' || mb_strlen($name) > 20) {
        sendError('Name is required (max 20 chars)', 400);
    }
    return $name;
}

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

function sendError(string $message, int $code = 400, array $extra = []): void
{
    http_response_code($code);
    echo json_encode(['error' => $message] + $extra, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}
