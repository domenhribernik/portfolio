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
// THE AUTHORITY RULE, which is what makes this game different from the
// parlour it is built on: the parlour's server guards state but never
// computes it, because a stroke is public and harmless. Here the board is
// the game. A client sends a shaft number and nothing else; every drop,
// every cave, every permit spent and every seam struck is decided in this
// file against seam_rooms.board, which is the only section that exists.
// Anything else in the request body is ignored on purpose.

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

// The section. Mirrors COLS / ROWS in views/seam/logic.js: change them in both.
const COLS = 7;
const ROWS = 6;

// Draw permits per seat for the whole game. Mirrors CHARGES in
// views/seam/logic.js: change them in both. Together with the never-twice-
// running cooldown this is the anti-spam rule, and it is what bounds a game
// at COLS * ROWS + 2 * CHARGES * COLS cuts.
const CHARGES = 3;

// Two seats, and that is the whole room.
const ROOM_CAP = 2;

const IDLE_ROOM_HOURS = 6;
const EVENT_PAGE = 200;

// A seat is takeable only after this much silence from the phone holding it.
const RECLAIM_IDLE_SECONDS = 20;
const ONLINE_SECONDS = 25;
const SWEEP_MINUTES = 15;

try {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        sendError('Method not allowed', 405);
    }
    $body = jsonBody();
    switch ($_GET['action'] ?? '') {
        case 'create':  createRoom($body);  break;
        case 'join':    joinRoom($body);    break;
        case 'seats':   listSeats($body);   break;
        case 'reclaim': reclaimSeat($body); break;
        case 'poll':    pollRoom($body);    break;
        case 'move':    postMove($body);    break;
        case 'again':   postAgain($body);   break;
        case 'leave':   leaveRoom($body);   break;
        default:        sendError('Unknown action', 400);
    }
} catch (InvalidArgumentException $e) {
    sendError($e->getMessage(), 400);
} catch (\Throwable $e) {
    global $DEV_MODE;
    error_log('Seam controller error: ' . $e->getMessage() . ' in ' . $e->getFile() . ':' . $e->getLine());
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
    $name = validatePlayerName($body['name'] ?? null);
    // The one moment a language is chosen. Whoever joins this section reads
    // it in the same one, so joiners are never asked.
    $lang  = validateLang($body['lang'] ?? null);
    $db    = Database::write();
    $token = bin2hex(random_bytes(16));

    // The janitor: rooms are throwaway, so the rare create request pays for
    // purging idle ones (deletes cascade to players and events).
    $db->exec('DELETE FROM seam_rooms WHERE last_active < NOW() - INTERVAL ' . IDLE_ROOM_HOURS . ' HOUR');

    // Room codes are random; on the rare UNIQUE collision, redraw.
    for ($attempt = 0; $attempt < 6; $attempt++) {
        $code = roomCode();
        try {
            $db->beginTransaction();
            $db->prepare(
                'INSERT INTO seam_rooms (code, lang, board, charges_1, charges_2) VALUES (?, ?, ?, ?, ?)'
            )->execute([$code, $lang, emptyBoard(), CHARGES, CHARGES]);
            $roomId = (int) $db->lastInsertId();
            $db->prepare(
                'INSERT INTO seam_players (room_id, token_hash, name, seat, is_host) VALUES (?, ?, ?, 1, 1)'
            )->execute([$roomId, hash('sha256', $token), $name]);
            $playerId = (int) $db->lastInsertId();
            $db->commit();

            sendJson([
                'code'  => $code,
                'token' => $token,
                'you'   => ['id' => $playerId, 'seat' => 1, 'host' => true],
                'room'  => roomSummary(roomById($db, $roomId)),
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


/**
 * Seats the second surveyor, which is also what starts the match: there is
 * no host tap between a shared link and a live section, which is the one
 * place this deliberately diverges from spy. The room row is locked for the
 * whole transaction so two people opening the link at the same instant
 * cannot both be handed seat 2.
 */
function joinRoom(array $body): void
{
    $name = validatePlayerName($body['name'] ?? null);
    $db   = Database::write();
    $room = roomByCode($db, $body['code'] ?? null);
    $roomId = (int) $room['id'];

    $db->beginTransaction();
    try {
        // Claim the room row first: everything below counts seats, and the
        // count has to be stable until the INSERT lands.
        $locked = $db->prepare('SELECT status FROM seam_rooms WHERE id = ? FOR UPDATE');
        $locked->execute([$roomId]);
        $status = $locked->fetchColumn();
        if ($status === false) {
            $db->rollBack();
            sendError('Section not found', 404);
        }
        // Joining mid-match would leave the newcomer without a seat, so the
        // door shuts the moment the match starts. The `reclaim` flag tells
        // the client to offer the seat picker instead of just failing.
        if ($status !== 'lobby') {
            $db->rollBack();
            sendError('That section is already being worked', 409, ['reclaim' => true]);
        }

        $seated = $db->prepare(
            'SELECT seat, name FROM seam_players WHERE room_id = ? AND left_at IS NULL'
        );
        $seated->execute([$roomId]);
        $rows = $seated->fetchAll();
        if (count($rows) >= ROOM_CAP) {
            $db->rollBack();
            sendError('That section already has two surveyors', 409);
        }
        // Names label the seats on both plates, so two people cannot answer
        // to the same one. The column collation is case-insensitive, so this
        // catches "Ana" against "ana" too.
        foreach ($rows as $r) {
            if (mb_strtolower($r['name']) === mb_strtolower($name)) {
                $db->rollBack();
                sendError('Someone in that section already goes by that name', 409);
            }
        }

        $taken = array_map(static fn (array $r) => (int) $r['seat'], $rows);
        $seat  = in_array(1, $taken, true) ? 2 : 1;

        $token = bin2hex(random_bytes(16));
        $db->prepare(
            'INSERT INTO seam_players (room_id, token_hash, name, seat, is_host) VALUES (?, ?, ?, ?, 0)'
        )->execute([$roomId, hash('sha256', $token), $name, $seat]);
        $playerId = (int) $db->lastInsertId();

        // Both seats filled: deal the section and start. One event announces
        // it, inside the same transaction that seated the player, so no poll
        // can ever see a full section still sitting in the lobby.
        if (count($rows) + 1 >= ROOM_CAP) {
            startMatch($db, $roomId, (int) $room['starter']);
        }
        $db->commit();
    } catch (PDOException $e) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }
        throw $e;
    }

    sendJson([
        'code'  => $room['code'],
        'token' => $token,
        'you'   => ['id' => $playerId, 'seat' => $seat, 'host' => false],
        'room'  => roomSummary(roomById($db, $roomId)),
    ]);
}

// ------------------------------------------------------------------
//  The match
// ------------------------------------------------------------------

/** Wipes the section, hands the first cut to `starter`, and says so once. */
function startMatch(PDO $db, int $roomId, int $starter): void
{
    $starter = $starter === 2 ? 2 : 1;
    $db->prepare(
        "UPDATE seam_rooms
            SET status = 'play', board = ?, turn = ?, starter = ?,
                charges_1 = ?, charges_2 = ?, cooling_1 = 0, cooling_2 = 0,
                moves = 0, outcome = NULL, seam = NULL
          WHERE id = ?"
    )->execute([emptyBoard(), $starter, $starter, CHARGES, CHARGES, $roomId]);

    $db->prepare("INSERT INTO seam_events (room_id, player_id, type, data) VALUES (?, NULL, 'deal', ?)")
       ->execute([$roomId, json_encode(['starter' => $starter])]);
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

    // No cron exists on the host, so the poll path carries the transitions
    // nobody presses a button for: sweeping a phone that stopped polling,
    // and handing the host chair on when its holder walked out. Each is
    // guarded so exactly one of two simultaneous pollers does the write.
    heartbeat($db, $roomId, (int) $player['id']);

    // Re-read: the sweep and the handover above may have moved things on
    // this very request.
    $room   = roomById($db, $roomId);
    $player = playerById($db, (int) $player['id']);

    $stmt = $db->prepare(
        'SELECT id, name, seat, is_host, wins, wants_again,
                (last_seen >= NOW() - INTERVAL ' . ONLINE_SECONDS . ' SECOND) AS online
         FROM seam_players WHERE room_id = ? AND left_at IS NULL
         ORDER BY seat ASC, id ASC'
    );
    $stmt->execute([$roomId]);
    $players = array_map(static fn (array $p) => [
        'id'     => (int) $p['id'],
        'name'   => $p['name'],
        'seat'   => (int) $p['seat'],
        'host'   => (bool) $p['is_host'],
        'wins'       => (int) $p['wins'],
        'wantsAgain' => (bool) $p['wants_again'],
        'online'     => (bool) $p['online'],
    ], $stmt->fetchAll());

    [$events, $last, $more] = eventsSince($db, $roomId, $since);

    sendJson([
        'room'    => roomSummary($room) + ['seated' => count($players)],
        'you'     => [
            'id'   => (int) $player['id'],
            'seat' => (int) $player['seat'],
            'host' => (bool) $player['is_host'],
            'wins' => (int) $player['wins'],
        ],
        'players' => $players,
        'events'  => $events,
        'last'    => $last,
        'more'    => $more,
    ]);
}

/**
 * One cut. The client sends a shaft number; everything else in the body is
 * ignored. The room row is locked for the whole transaction, so two phones
 * tapping the same instant are serialised and the second one is told it is
 * not their turn rather than both landing a piece.
 */
function postMove(array $body): void
{
    $db     = Database::write();
    $room   = roomByCode($db, $body['code'] ?? null);
    $roomId = (int) $room['id'];
    $player = playerByToken($db, $roomId, $body['token'] ?? null);
    $seat   = (int) $player['seat'];

    // Read the shaft, and nothing else. json_decode gives ints for whole
    // numbers, so anything else here is a client that made something up.
    $col = $body['col'] ?? null;
    if (!is_int($col)) {
        sendError('That shaft is not on the plate', 400, ['reason' => 'badShaft']);
    }

    $db->beginTransaction();
    try {
        $locked = $db->prepare('SELECT * FROM seam_rooms WHERE id = ? FOR UPDATE');
        $locked->execute([$roomId]);
        $room = $locked->fetch();
        if (!$room) {
            $db->rollBack();
            sendError('Section not found', 404);
        }
        if ($room['status'] !== 'play') {
            $db->rollBack();
            sendError($room['status'] === 'lobby'
                ? 'The section is not being worked yet'
                : 'This section is finished', 409, ['reason' => 'over']);
        }
        if ((int) $room['turn'] !== $seat) {
            $db->rollBack();
            sendError('It is not your cut', 409, ['reason' => 'notYourTurn']);
        }

        $reason = moveError($room, $col);
        if ($reason !== null) {
            $db->rollBack();
            sendError(moveErrorMessage($reason), 400, ['reason' => $reason]);
        }

        $next = applyMove($room, $col);
        $db->prepare(
            "UPDATE seam_rooms
                SET board = ?, turn = ?, charges_1 = ?, charges_2 = ?,
                    cooling_1 = ?, cooling_2 = ?, moves = ?, status = ?,
                    outcome = ?, seam = ?
              WHERE id = ?"
        )->execute([
            $next['board'], $next['turn'], $next['charges'][0], $next['charges'][1],
            $next['cooling'][0] ? 1 : 0, $next['cooling'][1] ? 1 : 0, $next['moves'],
            $next['outcome'] === null ? 'play' : 'over',
            $next['outcome'], $next['seam'], $roomId,
        ]);

        $db->prepare("INSERT INTO seam_events (room_id, player_id, type, data) VALUES (?, ?, 'move', ?)")
           ->execute([$roomId, (int) $player['id'], json_encode([
               'seat'  => $seat,
               'col'   => $col,
               'caved' => $next['caved'],
           ])]);

        if ($next['outcome'] !== null) {
            // Settled once, here, so the result never depends on who is still
            // connected when it is read.
            if ($next['outcome'] === 'p1' || $next['outcome'] === 'p2') {
                $db->prepare(
                    'UPDATE seam_players SET wins = wins + 1 WHERE room_id = ? AND seat = ? AND left_at IS NULL'
                )->execute([$roomId, $next['outcome'] === 'p1' ? 1 : 2]);
            }
            $db->prepare("INSERT INTO seam_events (room_id, player_id, type, data) VALUES (?, NULL, 'verdict', ?)")
               ->execute([$roomId, json_encode(['outcome' => $next['outcome']])]);
        }

        $db->commit();
    } catch (PDOException $e) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }
        throw $e;
    }

    sendJson(['room' => roomSummary(roomById($db, $roomId))]);
}

/**
 * The seats in a section, for the picker a surveyor lands on when their
 * phone lost its session mid-match. The one endpoint that takes no token, so
 * it stays as uninteresting as the lobby anyone with the link can see.
 */
function listSeats(array $body): void
{
    $db   = Database::read();
    $room = roomByCode($db, $body['code'] ?? null);

    $stmt = $db->prepare(
        'SELECT id, name, seat,
                (last_seen >= NOW() - INTERVAL ' . ONLINE_SECONDS . ' SECOND) AS online,
                (last_seen < NOW() - INTERVAL ' . RECLAIM_IDLE_SECONDS . ' SECOND) AS reclaimable
         FROM seam_players WHERE room_id = ? AND left_at IS NULL
         ORDER BY seat ASC, id ASC'
    );
    $stmt->execute([(int) $room['id']]);

    sendJson([
        'room'    => ['code' => $room['code'], 'status' => $room['status']],
        'players' => array_map(static fn (array $p) => [
            'id'          => (int) $p['id'],
            'name'        => $p['name'],
            'seat'        => (int) $p['seat'],
            'online'      => (bool) $p['online'],
            'reclaimable' => (bool) $p['reclaimable'],
        ], $stmt->fetchAll()),
    ]);
}

/**
 * Take back a seat whose phone has gone quiet. Nothing in this game is
 * secret, so unlike spy this hands over no hidden information: the section,
 * the permits and the turn are on every plate in the room already.
 */
function reclaimSeat(array $body): void
{
    $db   = Database::write();
    $room = roomByCode($db, $body['code'] ?? null);
    $id   = (int) ($body['playerId'] ?? 0);

    $stmt = $db->prepare(
        'SELECT id, seat, is_host, wins,
                (last_seen < NOW() - INTERVAL ' . RECLAIM_IDLE_SECONDS . ' SECOND) AS idle
         FROM seam_players WHERE id = ? AND room_id = ? AND left_at IS NULL'
    );
    $stmt->execute([$id, (int) $room['id']]);
    $player = $stmt->fetch();
    if (!$player) {
        sendError('That seat is gone', 404);
    }
    if (!(bool) $player['idle']) {
        sendError('That seat is still being worked', 409);
    }

    // Overwriting the hash is what evicts the old phone: its next poll finds
    // no row for its token and answers 401.
    $token = bin2hex(random_bytes(16));
    $db->prepare('UPDATE seam_players SET token_hash = ?, last_seen = NOW() WHERE id = ?')
       ->execute([hash('sha256', $token), $id]);

    sendJson([
        'code'  => $room['code'],
        'token' => $token,
        'you'   => [
            'id'   => $id,
            'seat' => (int) $player['seat'],
            'host' => (bool) $player['is_host'],
            'wins' => (int) $player['wins'],
        ],
        'room'  => roomSummary(roomById($db, (int) $room['id'])),
    ]);
}

/**
 * Another section, once BOTH surveyors have asked for one. Asking alone is a
 * toggle: nobody gets the result wiped out from under them while they are
 * still reading it, and either seat can change its mind until the other
 * agrees.
 */
function postAgain(array $body): void
{
    $db     = Database::write();
    $room   = roomByCode($db, $body['code'] ?? null);
    $roomId = (int) $room['id'];
    $player = playerByToken($db, $roomId, $body['token'] ?? null);

    $db->beginTransaction();
    try {
        $locked = $db->prepare('SELECT * FROM seam_rooms WHERE id = ? FOR UPDATE');
        $locked->execute([$roomId]);
        $room = $locked->fetch();
        if (!$room || $room['status'] !== 'over') {
            $db->rollBack();
            sendError('That section is not finished', 409, ['reason' => 'notOver']);
        }

        $db->prepare('UPDATE seam_players SET wants_again = 1 - wants_again WHERE id = ?')
           ->execute([(int) $player['id']]);

        $tally = $db->prepare(
            'SELECT COUNT(*) AS seated, COALESCE(SUM(wants_again), 0) AS asking
             FROM seam_players WHERE room_id = ? AND left_at IS NULL'
        );
        $tally->execute([$roomId]);
        $row = $tally->fetch();

        if ((int) $row['seated'] >= ROOM_CAP && (int) $row['asking'] >= (int) $row['seated']) {
            // The first cut alternates, so neither seat keeps the advantage
            // over a series.
            startMatch($db, $roomId, (int) $room['starter'] === 1 ? 2 : 1);
            $db->prepare('UPDATE seam_players SET wants_again = 0 WHERE room_id = ?')->execute([$roomId]);
        }
        $db->commit();
    } catch (PDOException $e) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }
        throw $e;
    }

    sendJson(['room' => roomSummary(roomById($db, $roomId))]);
}

function leaveRoom(array $body): void
{
    $db     = Database::write();
    $room   = roomByCode($db, $body['code'] ?? null);
    $roomId = (int) $room['id'];
    $player = playerByToken($db, $roomId, $body['token'] ?? null);

    // left_at is the liveness predicate every lookup carries, so this also
    // kills the token: the phone's next poll answers 401 and it self-evicts.
    $db->prepare('UPDATE seam_players SET left_at = NOW() WHERE id = ?')->execute([(int) $player['id']]);
    reopenIfAbandoned($db, $roomId);

    sendJson(['ok' => true]);
}

/**
 * A match needs two surveyors. When one walks out (or is swept for going
 * quiet), the section is void: it returns to the lobby so the shared link
 * still works and somebody new can take the empty seat. Guarded on the
 * status so two simultaneous pollers cannot both announce it.
 */
function reopenIfAbandoned(PDO $db, int $roomId): void
{
    $seated = $db->prepare('SELECT COUNT(*) FROM seam_players WHERE room_id = ? AND left_at IS NULL');
    $seated->execute([$roomId]);
    if ((int) $seated->fetchColumn() >= ROOM_CAP) {
        return;
    }

    $claim = $db->prepare(
        "UPDATE seam_rooms
            SET status = 'lobby', board = ?, turn = starter,
                charges_1 = ?, charges_2 = ?, cooling_1 = 0, cooling_2 = 0,
                moves = 0, outcome = NULL, seam = NULL
          WHERE id = ? AND status <> 'lobby'"
    );
    $claim->execute([emptyBoard(), CHARGES, CHARGES, $roomId]);
    if ($claim->rowCount() === 0) {
        return;
    }

    $db->prepare('UPDATE seam_players SET wants_again = 0 WHERE room_id = ?')->execute([$roomId]);
    $db->prepare("INSERT INTO seam_events (room_id, player_id, type) VALUES (?, NULL, 'abandon')")
       ->execute([$roomId]);
}

// ------------------------------------------------------------------
//  The rules
//
//  A direct mirror of views/seam/logic.js. The browser needs them to grey
//  out a dead shaft and to run the bot; this file needs them because it is
//  the only thing allowed to decide what actually happened. Change them in
//  both, and tests/seam-logic.test.mjs greps this file to keep the shared
//  constants honest.
// ------------------------------------------------------------------

/** The bed a piece cut into this shaft would settle on, or -1 if it is full. */
function dropRow(string $board, int $col): int
{
    for ($r = ROWS - 1; $r >= 0; $r--) {
        if ($board[$r * COLS + $col] === '.') {
            return $r;
        }
    }
    return -1;
}

function columnFull(string $board, int $col): bool
{
    return dropRow($board, $col) < 0;
}

function cutInto(string $board, int $col, string $seat): string
{
    $row = dropRow($board, $col);
    if ($row < 0) {
        return $board;
    }
    $board[$row * COLS + $col] = $seat;
    return $board;
}

/**
 * The bottom is drawn and the column caves: the basement bed is cut away and
 * every piece above it settles one bed down. The row-major surface-first
 * encoding is chosen so this is one line.
 */
function caveBoard(string $board): string
{
    return str_repeat('.', COLS) . substr($board, 0, COLS * (ROWS - 1));
}

/** Across the beds, down a shaft, and both dips. Downward vectors only. */
function seamDirs(): array
{
    return [[0, 1], [1, 0], [1, 1], [1, -1]];
}

/** The four cells `seat` struck a seam through, or null. */
function findSeam(string $board, string $seat): ?array
{
    for ($r = 0; $r < ROWS; $r++) {
        for ($c = 0; $c < COLS; $c++) {
            if ($board[$r * COLS + $c] !== $seat) {
                continue;
            }
            foreach (seamDirs() as [$dr, $dc]) {
                $endR = $r + $dr * 3;
                $endC = $c + $dc * 3;
                if ($endR >= ROWS || $endC < 0 || $endC >= COLS) {
                    continue;
                }
                $cells = [];
                for ($i = 0; $i < 4; $i++) {
                    $cells[] = ($r + $dr * $i) * COLS + ($c + $dc * $i);
                }
                $all = true;
                foreach ($cells as $at) {
                    if ($board[$at] !== $seat) {
                        $all = false;
                        break;
                    }
                }
                if ($all) {
                    return $cells;
                }
            }
        }
    }
    return null;
}

/** Why the moving seat may not cut into this shaft, or null if they may. */
function moveError(array $room, mixed $col): ?string
{
    if (!is_int($col) || $col < 0 || $col >= COLS) {
        return 'badShaft';
    }
    if (!columnFull($room['board'], $col)) {
        return null;
    }
    // A full shaft is only playable by drawing the bottom, which costs a
    // permit and may never happen on two of a seat's own turns running.
    $seat = (int) $room['turn'];
    if ((int) $room['charges_' . $seat] <= 0) {
        return 'noPermit';
    }
    if ((int) $room['cooling_' . $seat] === 1) {
        return 'cooling';
    }
    return null;
}

function moveErrorMessage(string $reason): string
{
    return match ($reason) {
        'noPermit' => 'You have no draw permits left',
        'cooling'  => 'You cannot draw twice running',
        default    => 'That shaft is not on the plate',
    };
}

/** Every shaft the moving seat may cut into. */
function legalMoves(array $room): array
{
    $out = [];
    for ($c = 0; $c < COLS; $c++) {
        if (moveError($room, $c) === null) {
            $out[] = $c;
        }
    }
    return $out;
}

/**
 * One turn, resolved. Returns the whole next section, including whether the
 * cave fired and how the section settled.
 */
function applyMove(array $room, int $col): array
{
    $seat    = (int) $room['turn'];
    $board   = $room['board'];
    $charges = [(int) $room['charges_1'], (int) $room['charges_2']];
    $cooling = [(int) $room['cooling_1'] === 1, (int) $room['cooling_2'] === 1];

    $caved = columnFull($board, $col);
    if ($caved) {
        $charges[$seat - 1]--;
        $board = caveBoard($board);
    }
    $board = cutInto($board, $col, $seat === 2 ? '2' : '1');
    $cooling[$seat - 1] = $caved;

    $next = [
        'board'   => $board,
        'turn'    => $seat === 2 ? 1 : 2,
        'charges' => $charges,
        'cooling' => $cooling,
        'moves'   => (int) $room['moves'] + 1,
        'caved'   => $caved,
        'outcome' => null,
        'seam'    => null,
        'starter' => (int) $room['starter'],
    ];

    // A cave translates every survivor by the same vector, so it cannot line
    // four up for anyone but the seat whose piece just landed. Both seats are
    // still checked, because the server must never trust that reasoning.
    $struck = [];
    foreach ([1, 2] as $s) {
        $cells = findSeam($board, $s === 2 ? '2' : '1');
        if ($cells !== null) {
            $struck[$s] = $cells;
        }
    }
    if (count($struck) === 1) {
        $winner = array_key_first($struck);
        $next['outcome'] = 'p' . $winner;
        $next['seam']    = implode(',', $struck[$winner]);
    } elseif (count($struck) === 2) {
        $next['outcome'] = 'draw';
        $next['seam']    = implode(',', array_merge($struck[1], $struck[2]));
    } elseif (legalMoves([
        'board'     => $board,
        'turn'      => $next['turn'],
        'charges_1' => $charges[0],
        'charges_2' => $charges[1],
        'cooling_1' => $cooling[0] ? 1 : 0,
        'cooling_2' => $cooling[1] ? 1 : 0,
    ]) === []) {
        // A full section and no permit to draw with: nobody strikes.
        $next['outcome'] = 'draw';
    }

    return $next;
}

// ------------------------------------------------------------------
//  Room and player lookup
// ------------------------------------------------------------------

function emptyBoard(): string
{
    return str_repeat('.', COLS * ROWS);
}

function roomByCode(PDO $db, mixed $raw): array
{
    // Be liberal with what players typed (case, spaces); malformed codes are
    // indistinguishable from missing rooms on purpose.
    $code = is_string($raw) ? strtoupper(trim($raw)) : '';
    if (preg_match('/^[A-Z]{4}$/', $code) !== 1) {
        sendError('Section not found', 404);
    }
    $stmt = $db->prepare('SELECT * FROM seam_rooms WHERE code = ?');
    $stmt->execute([$code]);
    $room = $stmt->fetch();
    if (!$room) {
        sendError('Section not found', 404);
    }
    return $room;
}

function roomById(PDO $db, int $roomId): array
{
    $stmt = $db->prepare('SELECT * FROM seam_rooms WHERE id = ?');
    $stmt->execute([$roomId]);
    $room = $stmt->fetch();
    if (!$room) {
        sendError('Section not found', 404);
    }
    return $room;
}

/**
 * The public snapshot of a section. This is the ONLY board any client ever
 * sees, and it is read straight out of the row this file wrote.
 */
function roomSummary(array $room): array
{
    return [
        'code'    => $room['code'],
        'status'  => $room['status'],
        'lang'    => $room['lang'],
        'board'   => $room['board'],
        'turn'    => (int) $room['turn'],
        'starter' => (int) $room['starter'],
        'charges' => [(int) $room['charges_1'], (int) $room['charges_2']],
        'cooling' => [(bool) $room['cooling_1'], (bool) $room['cooling_2']],
        'moves'   => (int) $room['moves'],
        'outcome' => $room['outcome'],
        'seam'    => $room['seam'] !== null && $room['seam'] !== ''
            ? array_map('intval', explode(',', $room['seam']))
            : null,
    ];
}

function playerByToken(PDO $db, int $roomId, mixed $raw): array
{
    $token = is_string($raw) ? $raw : '';
    if (preg_match('/^[a-f0-9]{32}$/', $token) !== 1) {
        sendError('Not in this section', 401);
    }
    $stmt = $db->prepare(
        'SELECT id, seat, is_host, wins FROM seam_players
         WHERE room_id = ? AND token_hash = ? AND left_at IS NULL'
    );
    $stmt->execute([$roomId, hash('sha256', $token)]);
    $player = $stmt->fetch();
    if (!$player) {
        sendError('Not in this section', 401);
    }
    return $player;
}

function playerById(PDO $db, int $id): array
{
    $stmt = $db->prepare('SELECT id, seat, is_host, wins FROM seam_players WHERE id = ?');
    $stmt->execute([$id]);
    $player = $stmt->fetch();
    if (!$player) {
        sendError('Not in this section', 401);
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
        'UPDATE seam_players SET last_seen = NOW()
         WHERE id = ? AND last_seen < NOW() - INTERVAL 10 SECOND'
    )->execute([$playerId]);

    // Sweep players who stopped polling long ago. Runs after the self-bump,
    // so a returning sleeper is never swept by their own poll.
    $db->prepare(
        'UPDATE seam_players SET left_at = NOW()
         WHERE room_id = ? AND left_at IS NULL AND last_seen < NOW() - INTERVAL ' . SWEEP_MINUTES . ' MINUTE'
    )->execute([$roomId]);

    // Cheap enough to ask every poll, and it is the only thing standing
    // between the host walking out and a section nobody can restart.
    handOverHost($db, $roomId);
    reopenIfAbandoned($db, $roomId);

    // Keep the section off the idle-purge list while anyone is still polling.
    $db->prepare(
        'UPDATE seam_rooms SET last_active = NOW()
         WHERE id = ? AND last_active < NOW() - INTERVAL 60 SECOND'
    )->execute([$roomId]);
}

function handOverHost(PDO $db, int $roomId): void
{
    $held = $db->prepare('SELECT 1 FROM seam_players WHERE room_id = ? AND left_at IS NULL AND is_host = 1 LIMIT 1');
    $held->execute([$roomId]);
    if ($held->fetchColumn() !== false) {
        return;
    }

    $next = $db->prepare(
        'SELECT id FROM seam_players WHERE room_id = ? AND left_at IS NULL ORDER BY joined_at ASC, id ASC LIMIT 1'
    );
    $next->execute([$roomId]);
    $heir = $next->fetchColumn();
    if ($heir === false) {
        return; // an empty section; the janitor will get it
    }

    // rowCount() elects the announcer, so two simultaneous pollers cannot
    // both append a host event.
    $claim = $db->prepare('UPDATE seam_players SET is_host = 1 WHERE id = ? AND is_host = 0');
    $claim->execute([(int) $heir]);
    if ($claim->rowCount() > 0) {
        $db->prepare("INSERT INTO seam_events (room_id, player_id, type, data) VALUES (?, NULL, 'host', ?)")
           ->execute([$roomId, json_encode(['id' => (int) $heir])]);
    }
}

function eventsSince(PDO $db, int $roomId, int $since): array
{
    $stmt = $db->prepare(
        'SELECT id, player_id, type, data FROM seam_events
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

/**
 * One of the shared translation tables in views/seam/i18n. Both the browser
 * and this file read the identical file, so nothing can drift between them.
 */
function i18n(string $table): array
{
    static $cache = [];
    if (!isset($cache[$table])) {
        $raw  = @file_get_contents(__DIR__ . '/../../views/seam/i18n/' . $table . '.json');
        $json = $raw !== false ? json_decode($raw, true) : null;
        if (!is_array($json)) {
            throw new RuntimeException("The $table translation table is missing or unreadable");
        }
        $cache[$table] = $json;
    }
    return $cache[$table];
}

/** The languages a section may be played in, declared by the UI table. */
function languages(): array
{
    $langs = i18n('ui')['languages'] ?? [];
    $langs = array_values(array_filter($langs, 'is_string'));
    return $langs !== [] ? $langs : ['en'];
}

/** Anything unrecognised silently becomes English rather than 400ing. */
function validateLang(mixed $raw): string
{
    $lang = is_string($raw) ? strtolower(trim($raw)) : '';
    return in_array($lang, languages(), true) ? $lang : 'en';
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
