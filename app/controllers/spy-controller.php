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
// it is built on: spy_rooms.location_key, spy_players.role and the spy_ballots
// rows are secrets. The event log is public to the room, so none of them may
// ever be written into an event. They leave this file in exactly two places:
// the `you` block of a poll response (the polling player's own role and own
// ballot, plus the location only when that player is a citizen), and the
// `reveal` block, which the HOST opens and which does not exist in any payload
// before they do. Nothing else selects those columns.
//
// The debrief now has two halves, and the split is the point. `ballot` (who
// the table accused, and the tally) is public the moment the vote closes,
// because that is what the accused has to defend themselves against. `reveal`
// (the location, who the spies actually were, and the verdict) waits for the
// host to call the round, so nothing on a phone can cut the defence short.

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
// Once the last seated ballot lands, the vote does not slam shut: it arms
// this countdown, and any ballot changed while it runs disarms and re-arms it.
// Mirrored in views/spy/logic.js: change them in both.
const VOTE_GRACE_SECONDS = 5;
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
    $name = validatePlayerName($body['name'] ?? null);
    // The one moment a language is chosen. Everyone who joins this room
    // plays and reads in it, so joiners are never asked.
    $lang  = validateLang($body['lang'] ?? null);
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
            $db->prepare('INSERT INTO spy_rooms (code, lang) VALUES (?, ?)')->execute([$code, $lang]);
            $roomId = (int) $db->lastInsertId();
            $db->prepare(
                'INSERT INTO spy_players (room_id, token_hash, name, is_host) VALUES (?, ?, ?, 1)'
            )->execute([$roomId, hash('sha256', $token), $name]);
            $playerId = (int) $db->lastInsertId();
            $db->commit();
            sendJson([
                'code'  => $code,
                'token' => $token,
                'you'   => [
                    'id' => $playerId, 'host' => true, 'ready' => false,
                    'ballot' => [], 'role' => null, 'location' => null,
                ],
                'room'  => [
                    'code' => $code, 'status' => 'lobby', 'lang' => $lang,
                    'spies' => 1, 'picks' => 1, 'roundSeconds' => 300,
                ],
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
        'you'   => [
            'id' => $playerId, 'host' => false, 'ready' => false,
            'ballot' => [], 'role' => null, 'location' => null,
        ],
        'room'  => roomSummary($db, $room),
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

    // A seat taken back mid-vote keeps the ballot it had cast, for the same
    // reason it keeps its role: it is the same seat.
    $mine = $db->prepare('SELECT target_id FROM spy_ballots WHERE voter_id = ? ORDER BY id ASC');
    $mine->execute([$id]);

    sendJson([
        'code'  => $room['code'],
        'token' => $token,
        'you'   => [
            'id'       => $id,
            'host'     => (bool) $player['is_host'],
            'ready'    => (bool) $player['ready'],
            'ballot'   => array_map('intval', $mine->fetchAll(PDO::FETCH_COLUMN)),
            'role'     => $player['role'],
            'location' => $player['role'] === 'citizen' && cardIsLive($room)
                ? locationText($room['location_key'], $room['lang'])
                : null,
        ],
        'room'  => roomSummary($db, $room),
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

    // No cron exists on the host, so the poll path carries every transition
    // nobody presses a button for: the clock running out, a majority calling
    // the vote, and the last outstanding ballot arriving (or its owner
    // leaving). Each is guarded so that exactly one of several simultaneous
    // pollers does the write.
    heartbeat($db, $roomId, (int) $player['id']);
    advancePhase($db, $roomId);

    // Re-read: the sweep, the handover and the expiry above may all have
    // moved the phase or the host on this very request.
    $room   = roomById($db, $roomId);
    $player = playerById($db, (int) $player['id']);

    // Note what this SELECT does not ask for: role, and the names on anyone's
    // ballot. The player list is public to the room, so it carries only what is
    // safe to show everyone. It counts a player's picks to answer "have they
    // voted", and never which names they are: that is the whole reason the
    // vote is simultaneous.
    $stmt = $db->prepare(
        'SELECT p.id, p.name, p.is_host, p.ready, p.wants_end,
                (SELECT COUNT(*) FROM spy_ballots b WHERE b.voter_id = p.id) AS picks,
                (p.last_seen >= NOW() - INTERVAL ' . ONLINE_SECONDS . ' SECOND) AS online
         FROM spy_players p WHERE p.room_id = ? AND p.left_at IS NULL
         ORDER BY p.joined_at ASC, p.id ASC'
    );
    $stmt->execute([$roomId]);
    $rows   = $stmt->fetchAll();
    $seated = count($rows);
    // A ballot is only cast once it names as many suspects as there are spies,
    // so this is what "everyone has voted" is measured against.
    $needed = picksNeeded((int) $room['spies'], $seated);

    $players = array_map(fn (array $p) => [
        'id'       => (int) $p['id'],
        'name'     => $p['name'],
        'host'     => (bool) $p['is_host'],
        'ready'    => (bool) $p['ready'],
        'wantsEnd' => (bool) $p['wants_end'],
        'voted'    => (int) $p['picks'] >= $needed,
        'online'   => (bool) $p['online'],
    ], $rows);

    // The caller's own ballot, in the order they picked it, which is the order
    // their phone drops the oldest from when it is already holding as many
    // names as there are spies.
    $mine = $db->prepare('SELECT target_id FROM spy_ballots WHERE voter_id = ? ORDER BY id ASC');
    $mine->execute([(int) $player['id']]);
    $ballot = array_map('intval', $mine->fetchAll(PDO::FETCH_COLUMN));

    [$events, $last, $more] = eventsSince($db, $roomId, $since);

    $paused   = $room['paused_seconds'] !== null;
    $response = [
        'room' => [
            'code'         => $room['code'],
            'status'       => $room['status'],
            'lang'         => $room['lang'],
            'spies'        => (int) $room['spies'],
            // How many names one ballot carries. Sent rather than derived on
            // the phone so a room that lost players mid-vote cannot end up
            // with clients disagreeing about what a finished ballot looks like.
            'picks'        => $needed,
            'roundSeconds' => (int) $room['round_seconds'],
            'secondsLeft'  => $room['status'] === 'round'
                ? ($paused ? (int) $room['paused_seconds'] : (int) $room['seconds_left'])
                : null,
            // The vote's own clock, and deliberately a separate field: the
            // round countdown drives a progress bar scaled to roundSeconds,
            // and secondsLeft staying null outside a round is what the ballot
            // screen keys off. Non-null means every seated ballot is in and
            // the room closes when it reaches zero.
            'graceLeft'    => $room['status'] === 'vote' && $room['seconds_left'] !== null
                ? (int) $room['seconds_left']
                : null,
            'paused'       => $paused,
            'seated'       => $seated,
            // Both tallies are public on purpose. Seeing agreement form is
            // the point of calling a vote out loud, and knowing how many
            // ballots are in tells the table what it is waiting for.
            'endVotes'     => count(array_filter($players, fn ($p) => $p['wantsEnd'])),
            'endVotesNeeded' => endVoteThreshold($seated),
            'ballots'      => count(array_filter($players, fn ($p) => $p['voted'])),
            // Whether the host has called the round yet. Until they have, the
            // debrief is a waiting room and no `reveal` block exists at all.
            'revealed'     => (bool) $room['revealed'],
        ],
        // The only disclosure of a role, and only ever the caller's own. The
        // location rides along solely for citizens; a spy's payload must not
        // contain it anywhere, which is what the test suite pins. `ballot` is
        // likewise only ever the caller's own.
        'you' => [
            'id'       => (int) $player['id'],
            'host'     => (bool) $player['is_host'],
            'ready'    => (bool) $player['ready'],
            'wantsEnd' => (bool) $player['wants_end'],
            'ballot'   => $ballot,
            'role'     => $player['role'],
            'location' => $player['role'] === 'citizen' && cardIsLive($room)
                ? locationText($room['location_key'], $room['lang'])
                : null,
        ],
        'players' => $players,
        'events'  => $events,
        'last'    => $last,
        'more'    => $more,
    ];

    if ($room['status'] === 'debrief') {
        // Half one, public the moment the vote closed: who the table accused
        // and by how much. This is what the accused defends themselves
        // against, so it cannot wait for the host.
        //
        // Every ballot cast in the room counts, including those of players who
        // have since walked out.
        $tally = $db->prepare(
            'SELECT p.id, p.name, COUNT(b.id) AS votes
             FROM spy_players p
             JOIN spy_ballots b ON b.target_id = p.id AND b.room_id = p.room_id
             WHERE p.room_id = ?
             GROUP BY p.id, p.name, p.joined_at
             ORDER BY votes DESC, p.joined_at ASC, p.id ASC'
        );
        $tally->execute([$roomId]);

        $accusedIds = idList($room['accused_ids']);
        $accused    = [];
        if ($accusedIds !== []) {
            $marks = implode(',', array_fill(0, count($accusedIds), '?'));
            $names = $db->prepare("SELECT id, name FROM spy_players WHERE id IN ($marks)");
            $names->execute($accusedIds);
            $byId = [];
            foreach ($names->fetchAll() as $row) {
                $byId[(int) $row['id']] = $row['name'];
            }
            // Kept in the order the vote settled them, so the most accused
            // name reads first however the SELECT came back.
            foreach ($accusedIds as $id) {
                if (isset($byId[$id])) {
                    $accused[] = ['id' => $id, 'name' => $byId[$id]];
                }
            }
        }

        $response['ballot'] = [
            'accused' => $accused,
            // How many names the table had to agree on, so a phone can say
            // "1 of 2 spies caught" without knowing the room's settings.
            'wanted'  => (int) $room['spies'],
            'tally'   => array_map(fn (array $t) => [
                'id'    => (int) $t['id'],
                'name'  => $t['name'],
                'votes' => (int) $t['votes'],
            ], $tally->fetchAll()),
        ];

        // Half two, the dossier, and it exists in NO payload until the host
        // has called the round. A spy is entitled to their defence, and a
        // phone quietly showing the answer is what took that away.
        if ((bool) $room['revealed']) {
            // Includes players who walked out mid-round: a spy who dropped is
            // still a spy, and the table wants to know.
            $spies = $db->prepare(
                "SELECT id, name FROM spy_players WHERE room_id = ? AND role = 'spy' ORDER BY joined_at ASC, id ASC"
            );
            $spies->execute([$roomId]);

            $response['reveal'] = [
                'location' => locationText($room['location_key'], $room['lang']),
                'spies'    => array_map(
                    fn (array $p) => ['id' => (int) $p['id'], 'name' => $p['name']],
                    $spies->fetchAll()
                ),
                // The host's call, not the ballot's arithmetic: the accused
                // has spoken by now, and a caught spy who named the location
                // still takes the round.
                'outcome'  => $room['outcome'],
            ];
        }
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
            // openVote appends the phase event itself, so this request adds
            // nothing further to the log.
            $seq = openVote($db, $roomId);
            touchRoom($db, $roomId);
            sendJson(['seq' => $seq ?? 0]);

        case 'callvote':
            if ($room['status'] !== 'round') {
                sendError('There is no round to call a vote on', 409);
            }
            // A toggle, so somebody can change their mind. The tally is
            // public: watching agreement build is the whole point of saying
            // "let us vote" out loud.
            $db->prepare('UPDATE spy_players SET wants_end = 1 - wants_end WHERE id = ?')
               ->execute([(int) $player['id']]);
            $data = null;
            break;

        case 'castvote':
            if ($room['status'] !== 'vote') {
                sendError('The vote is not open', 409);
            }
            // One ballot names as many suspects as there are spies: with two
            // in play the agents only win by putting BOTH of them on top, and
            // a table that catches one of two has let the other walk.
            $needed  = picksNeeded((int) $room['spies'], seatedCount($db, $roomId));
            $targets = validateBallot($db, $roomId, (int) $player['id'], $body['data'] ?? null, $needed);

            // The WRITE carries the phase check, not just the read above.
            // Those are separate round trips, and closeVote() can land
            // between them: an unguarded write drops a ballot into a room
            // whose verdict is already frozen, and the debrief then prints a
            // tally that disagrees with the accused it names. Taking the
            // room's row FOR UPDATE is the half closeVote()'s claim holds, so
            // the two serialize and the replacement below is atomic against it.
            //
            // The deadline is the same guard doing its second job: a tap that
            // arrives after the countdown has already run out must not rewind
            // it, or closing would mean "five seconds since the last tap AND a
            // poll happened" rather than five seconds.
            $db->beginTransaction();
            $open = $db->prepare(
                "SELECT 1 FROM spy_rooms WHERE id = ? AND status = 'vote'
                   AND (round_ends_at IS NULL OR round_ends_at > NOW())
                 FOR UPDATE"
            );
            $open->execute([$roomId]);
            if ($open->fetchColumn() === false) {
                $db->rollBack();
                sendError('The vote has closed', 409);
            }
            // A ballot is replaced wholesale rather than diffed: the phone
            // sends the whole set every time, so there is no order of
            // operations in which a half-applied change can be read.
            $db->prepare('DELETE FROM spy_ballots WHERE voter_id = ?')->execute([(int) $player['id']]);
            $pick = $db->prepare('INSERT INTO spy_ballots (room_id, voter_id, target_id) VALUES (?, ?, ?)');
            foreach ($targets as $target) {
                // Inserted in the order they were picked, so id order is pick
                // order and a phone that reloads drops the same oldest name.
                $pick->execute([$roomId, (int) $player['id'], $target]);
            }
            // Disarm the grace countdown. A ballot is changeable right up to
            // the moment the vote closes, so every arriving one restarts the
            // clock: advancePhase() below re-arms it once the table is full
            // again. Only this one line is needed for that, because arming
            // lives in exactly one place.
            $db->prepare(
                "UPDATE spy_rooms SET round_ends_at = NULL
                 WHERE id = ? AND status = 'vote' AND round_ends_at > NOW()"
            )->execute([$roomId]);
            $db->commit();
            // The log is public, so the ballot never travels in it. Only the
            // fact that this player has now voted is visible to the room.
            $data = null;
            break;

        case 'closevote':
            requireHost($isHost);
            if ($room['status'] !== 'vote') {
                sendError('The vote is not open', 409);
            }
            $seq = closeVote($db, $roomId);
            touchRoom($db, $roomId);
            sendJson(['seq' => $seq ?? 0]);

        case 'reveal':
            // The one that ends the round. The vote settled who was accused,
            // then the accused defended themselves out loud, and only the
            // table knows how that went: a spy who was caught but named the
            // location has still stolen it. So the host calls it, and calling
            // it is what declassifies the dossier for every phone at once.
            // Repeatable on purpose, so a misjudged call can be corrected.
            requireHost($isHost);
            if ($room['status'] !== 'debrief') {
                sendError('There is nothing to declassify yet', 409);
            }
            $outcome = is_array($body['data'] ?? null) ? ($body['data']['outcome'] ?? null) : null;
            if ($outcome !== 'agents' && $outcome !== 'spies') {
                sendError('Call it for the agents or for the spies', 400);
            }
            $db->prepare('UPDATE spy_rooms SET revealed = 1, outcome = ? WHERE id = ?')
               ->execute([$outcome, $roomId]);
            // Public by definition: this event IS the announcement.
            $data = ['outcome' => $outcome];
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

    // Some events tip the room into its next phase once enough players have
    // acted. Each helper guards its own UPDATE and appends its own event, so
    // simultaneous callers cannot double-announce a transition.
    if ($type === 'callvote' || $type === 'castvote') {
        advancePhase($db, $roomId);
    }

    touchRoom($db, $roomId);

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
    $spies = max(1, min((int) $room['spies'], intdiv($count, 2)));
    // Never the same place twice in one room: the deck remembers.
    [$location, $used] = dealLocation($room['used_location_keys'] ?? null);

    // Fisher-Yates with a CSPRNG: the deal is the one thing in this game
    // that must not be predictable.
    for ($i = $count - 1; $i > 0; $i--) {
        $j = random_int(0, $i);
        [$ids[$i], $ids[$j]] = [$ids[$j], $ids[$i]];
    }
    $chosen = array_slice($ids, 0, $spies);

    $db->beginTransaction();
    // Wipe every player in the room, not only the seated ones. A player who
    // walked out keeps their old role otherwise, and the debrief would name
    // them as a spy of a round they were never in.
    $db->prepare(
        'UPDATE spy_players SET role = NULL, ready = 0, wants_end = 0 WHERE room_id = ?'
    )->execute([$roomId]);
    $db->prepare('DELETE FROM spy_ballots WHERE room_id = ?')->execute([$roomId]);
    $db->prepare("UPDATE spy_players SET role = 'citizen' WHERE room_id = ? AND left_at IS NULL")
       ->execute([$roomId]);
    $marks = implode(',', array_fill(0, count($chosen), '?'));
    $db->prepare("UPDATE spy_players SET role = 'spy' WHERE id IN ($marks)")->execute($chosen);
    $db->prepare(
        "UPDATE spy_rooms SET status = 'brief', location_key = ?, used_location_keys = ?, spies = ?,
                round_ends_at = NULL, paused_seconds = NULL,
                accused_ids = NULL, outcome = NULL, revealed = 0
         WHERE id = ?"
    )->execute([$location, $used, $spies, $roomId]);
    $db->commit();

    return ['players' => $count, 'spies' => $spies];
}

/**
 * Back to the lobby: the dossier is shredded and every card goes blank.
 * used_location_keys deliberately survives, because the room does: the same
 * people are about to play again and would notice the same place twice.
 */
function resetRoom(PDO $db, int $roomId): void
{
    $db->prepare(
        'UPDATE spy_players SET role = NULL, ready = 0, wants_end = 0 WHERE room_id = ?'
    )->execute([$roomId]);
    $db->prepare('DELETE FROM spy_ballots WHERE room_id = ?')->execute([$roomId]);
    $db->prepare(
        "UPDATE spy_rooms SET status = 'lobby', location_key = NULL,
                round_ends_at = NULL, paused_seconds = NULL,
                accused_ids = NULL, outcome = NULL, revealed = 0
         WHERE id = ?"
    )->execute([$roomId]);
}

/**
 * Whether a player's own card is still live: their location travels with the
 * poll while there is a round to use it in, and stops at the debrief.
 *
 * Nobody legitimate loses anything, because by the debrief a citizen has known
 * the place for the whole round and the screen showing it is behind them. What
 * it closes is the reclaim door: a seat goes reclaimable after twenty quiet
 * seconds, and the debrief (phones down, everyone arguing) is exactly when
 * seats go quiet. A spy taking one over used to read the location out of the
 * grant and then "guess" it out loud, which is the one move the whole
 * two-half debrief exists to make them earn.
 */
function cardIsLive(array $room): bool
{
    return $room['status'] !== 'debrief';
}

/** How many players are still in their seats. */
function seatedCount(PDO $db, int $roomId): int
{
    $stmt = $db->prepare('SELECT COUNT(*) FROM spy_players WHERE room_id = ? AND left_at IS NULL');
    $stmt->execute([$roomId]);
    return (int) $stmt->fetchColumn();
}

/**
 * How many names one ballot carries: one per spy, capped at the number of
 * people a voter can actually name. Mirrors picksNeeded() in views/spy/logic.js:
 * change them in both.
 */
function picksNeeded(int $spies, int $seated): int
{
    return min(max(1, $spies), max(1, $seated - 1));
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

    $seated = seatedCount($db, $roomId);

    $spies   = max(1, min($spies, max(1, intdiv($seated, 2))));
    $seconds = (int) round($seconds / ROUND_STEP_SECONDS) * ROUND_STEP_SECONDS;
    $seconds = max(MIN_ROUND_SECONDS, min(MAX_ROUND_SECONDS, $seconds));

    $db->prepare('UPDATE spy_rooms SET spies = ?, round_seconds = ? WHERE id = ?')
       ->execute([$spies, $seconds, $roomId]);

    return ['spies' => $spies, 'roundSeconds' => $seconds];
}

/** Any accepted event, and any lazy transition, keeps the room off the purge list. */
function touchRoom(PDO $db, int $roomId): void
{
    $db->prepare(
        'UPDATE spy_rooms SET last_active = NOW()
         WHERE id = ? AND last_active < NOW() - INTERVAL 60 SECOND'
    )->execute([$roomId]);
}

/** A simple majority of the seated players carries the call to vote. */
function endVoteThreshold(int $seated): int
{
    return max(1, intdiv($seated, 2) + 1);
}

/**
 * Questioning is over, the ballot is open. Guarded so that of however many
 * callers arrive at once (a majority landing together, the clock expiring
 * under several polls, the host tapping END) exactly one writes the
 * transition and appends the single `end` event. Returns that event's id, or
 * null when somebody else got there first.
 */
function openVote(PDO $db, int $roomId): ?int
{
    $stmt = $db->prepare(
        "UPDATE spy_rooms SET status = 'vote', round_ends_at = NULL, paused_seconds = NULL
         WHERE id = ? AND status = 'round'"
    );
    $stmt->execute([$roomId]);
    if ($stmt->rowCount() === 0) {
        return null;
    }
    $db->prepare("INSERT INTO spy_events (room_id, player_id, type) VALUES (?, NULL, 'end')")
       ->execute([$roomId]);
    return (int) $db->lastInsertId();
}

/**
 * Moves the room on if enough players have acted. Both of these thresholds
 * are counted against the players still SEATED, so somebody leaving can
 * carry a call or complete a ballot just as surely as somebody tapping, and
 * the vote is the one phase with neither a clock nor a guaranteed actor to
 * fall back on. That is why this runs on the poll path as well as after the
 * events that usually trigger it. One query answers both questions, and
 * every exit is itself guarded, so racing callers settle nothing twice.
 *
 * `round_ends_at` is the deadline of whichever phase is running, so the same
 * `expired` flag ends a round and closes a vote.
 */
function advancePhase(PDO $db, int $roomId): void
{
    $stmt = $db->prepare(
        'SELECT r.status, r.spies,
                (r.round_ends_at IS NOT NULL AND r.round_ends_at <= NOW()) AS expired,
                COUNT(p.id) AS seated,
                COALESCE(SUM(p.wants_end), 0) AS wanting
         FROM spy_rooms r
         LEFT JOIN spy_players p ON p.room_id = r.id AND p.left_at IS NULL
         WHERE r.id = ?
         GROUP BY r.id, r.status, r.spies, expired'
    );
    $stmt->execute([$roomId]);
    $row = $stmt->fetch();
    if (!$row) {
        return;
    }

    $seated = (int) $row['seated'];
    if ($seated === 0) {
        return; // an empty room has nothing to settle; the janitor gets it
    }

    if ($row['status'] === 'round') {
        // Two ways out of a round, and they share an exit: the clock, and
        // enough players asking to stop.
        if ((bool) $row['expired'] || (int) $row['wanting'] >= endVoteThreshold($seated)) {
            openVote($db, $roomId);
        }
    } elseif ($row['status'] === 'vote') {
        // The last ballot no longer slams the vote shut: it arms a grace
        // countdown, so anybody can still change their mind. Casting a ballot
        // clears the deadline, and this re-arms it a moment later, which is
        // the whole of "changing your pick restarts the countdown".
        // "Everyone has voted" now means everyone has named as many suspects
        // as there are spies. Counted here rather than in the query above,
        // because how many that is depends on the seated count that query is
        // the one computing.
        // One player left and nobody to accuse: `cast >= seated` can never come
        // true, so the room would sit on a ballot with an empty list until the
        // survivor found CLOSE THE VOTE. Settle it for them.
        if ($seated <= 1) {
            closeVote($db, $roomId);
            return;
        }

        $needed = picksNeeded((int) $row['spies'], $seated);
        $done   = $db->prepare(
            'SELECT COUNT(*) FROM spy_players p
             WHERE p.room_id = ? AND p.left_at IS NULL
               AND (SELECT COUNT(*) FROM spy_ballots b WHERE b.voter_id = p.id) >= ?'
        );
        $done->execute([$roomId, $needed]);
        $cast = (int) $done->fetchColumn();

        if ((bool) $row['expired']) {
            closeVote($db, $roomId);
        } elseif ($cast >= $seated) {
            // Guarded on round_ends_at IS NULL so twenty phones polling the
            // same second cannot each shove the deadline further out.
            $db->prepare(
                "UPDATE spy_rooms SET round_ends_at = NOW() + INTERVAL " . VOTE_GRACE_SECONDS . " SECOND
                 WHERE id = ? AND status = 'vote' AND round_ends_at IS NULL"
            )->execute([$roomId]);
        }
    }
}

/**
 * Counts the ballots and settles WHO THE TABLE ACCUSED, once, rather than
 * each time the debrief is read, so it cannot drift as players come and go
 * afterwards. With n spies in play the accused are the top n of the tally.
 *
 * A tie across that line settles nothing, so the tied names are left out
 * rather than picked between: accusing four people of being two spies is not
 * an answer the table gave. What survives is the unambiguous head of the
 * list, which is why the accused can come back SHORT of n.
 *
 * Deliberately no verdict here. The accused has not spoken yet, and a spy who
 * is caught can still take the round by naming the location, so the host
 * calls it later (the 'reveal' event) and this only lays out the evidence.
 */
function closeVote(PDO $db, int $roomId): ?int
{
    // The whole close is one transaction, and it CLAIMS the room before it
    // counts. Two things fall out of that order, and both matter:
    //
    //   - the claim's rowCount is still the single-writer guard, so of
    //     however many callers race here exactly one announces the result;
    //   - the claim locks the room's row, and castvote's write joins that
    //     same row, so no ballot can be added to a tally that has already
    //     been counted. Counting first left several round trips in which a
    //     last-second tap landed in the debrief's tally but not in the
    //     verdict, and the grace countdown exists to invite exactly those
    //     taps.
    //
    // Counting first used to be deliberate, to stop a poller reading a
    // debrief whose verdict was not written yet. The transaction closes that
    // window instead of reopening it: nothing outside sees the new status
    // until the outcome is committed alongside it.
    $db->beginTransaction();

    $claim = $db->prepare(
        "UPDATE spy_rooms SET status = 'debrief', round_ends_at = NULL
         WHERE id = ? AND status = 'vote'"
    );
    $claim->execute([$roomId]);
    if ($claim->rowCount() === 0) {
        $db->rollBack();
        return null;
    }

    $spies = $db->prepare('SELECT spies FROM spy_rooms WHERE id = ?');
    $spies->execute([$roomId]);
    $wanted = max(1, (int) $spies->fetchColumn());

    $tally = $db->prepare(
        'SELECT target_id AS id, COUNT(*) AS votes FROM spy_ballots
         WHERE room_id = ? GROUP BY target_id ORDER BY votes DESC'
    );
    $tally->execute([$roomId]);
    $rows = $tally->fetchAll();

    // Everything above the cut line, and only what clears it outright. The
    // first name NOT in the top n sets the bar: anyone level with it is tied
    // for the last place and cannot be told from the people who missed out.
    $bar     = isset($rows[$wanted]) ? (int) $rows[$wanted]['votes'] : 0;
    $accused = [];
    foreach (array_slice($rows, 0, $wanted) as $row) {
        if ((int) $row['votes'] > $bar) {
            $accused[] = (int) $row['id'];
        }
    }

    $db->prepare('UPDATE spy_rooms SET accused_ids = ? WHERE id = ?')
       ->execute([$accused === [] ? null : implode(',', $accused), $roomId]);
    $db->prepare("INSERT INTO spy_events (room_id, player_id, type) VALUES (?, NULL, 'verdict')")
       ->execute([$roomId]);
    $seq = (int) $db->lastInsertId();

    $db->commit();
    return $seq;
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
        'SELECT id, code, status, lang, spies, round_seconds, location_key,
                used_location_keys, round_ends_at, paused_seconds,
                accused_ids, outcome, revealed
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
 *
 * `picks` is in here for the reclaim path specifically: a phone taking its
 * seat back lands straight into whatever phase is running, and one that
 * guessed a one name ballot in a two spy room would shift a name off the
 * ballot it had just been handed back on the player's first tap.
 */
function roomSummary(PDO $db, array $room): array
{
    return [
        'code'         => $room['code'],
        'status'       => $room['status'],
        'lang'         => $room['lang'],
        'spies'        => (int) $room['spies'],
        'picks'        => picksNeeded((int) $room['spies'], seatedCount($db, (int) $room['id'])),
        'roundSeconds' => (int) $room['round_seconds'],
    ];
}

/** Re-read after the poll path's lazy transitions, with the clock resolved. */
function roomById(PDO $db, int $roomId): array
{
    $stmt = $db->prepare(
        'SELECT id, code, status, lang, spies, round_seconds, location_key, paused_seconds,
                accused_ids, outcome, revealed,
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
        'SELECT id, is_host, ready, role, wants_end FROM spy_players
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
    $stmt = $db->prepare(
        'SELECT id, is_host, ready, role, wants_end FROM spy_players WHERE id = ?'
    );
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

/**
 * One of the shared translation tables in views/spy/i18n. Both are shaped the
 * same way, one row per concept with a column per language, so the browser
 * and this file read the identical file and nothing can drift out of step.
 */
function i18n(string $table): array
{
    static $cache = [];
    if (!isset($cache[$table])) {
        $raw  = @file_get_contents(__DIR__ . '/../../views/spy/i18n/' . $table . '.json');
        $json = $raw !== false ? json_decode($raw, true) : null;
        if (!is_array($json)) {
            throw new RuntimeException("The $table translation table is missing or unreadable");
        }
        $cache[$table] = $json;
    }
    return $cache[$table];
}

/** The languages a room may be played in, declared by the UI table. */
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

/** @return list<array<string, mixed>> */
function locationRows(): array
{
    $rows = i18n('locations')['locations'] ?? [];
    $rows = array_values(array_filter($rows, fn ($r) => is_array($r) && ($r['key'] ?? '') !== ''));
    if ($rows === []) {
        throw new RuntimeException('The location table is empty');
    }
    return $rows;
}

/**
 * The next location for a room, plus the deck to store back on it. Drawn from
 * what this room has NOT played, because the same place turning up twice in
 * one party is the one thing that makes a fresh round feel like a rerun. When
 * the deck runs out it reshuffles, minus the place just played, so a party
 * longer than the table can neither repeat nor run out of places.
 *
 * Mirrors pickUnusedLocation() in views/spy/logic.js, which does the same job
 * for the one-phone game: change them in both.
 *
 * @return array{0: string, 1: string} the key, and the new comma separated deck
 */
function dealLocation(?string $usedCsv): array
{
    $keys = array_map(fn (array $row) => (string) $row['key'], locationRows());
    $used = idList($usedCsv, false);
    $used = array_values(array_intersect($used, $keys)); // drop places since retired

    $pool = array_values(array_diff($keys, $used));
    if ($pool === []) {
        $last = $used === [] ? null : $used[count($used) - 1];
        $pool = array_values(array_filter($keys, fn (string $key) => $key !== $last));
        if ($pool === []) {
            $pool = $keys; // a one-place table has no choice to make
        }
        $used = [];
    }

    $key    = $pool[random_int(0, count($pool) - 1)];
    $used[] = $key;
    return [$key, implode(',', $used)];
}

/**
 * A plain JSON array rather than an object. array_is_list() would say this in
 * one call, but it landed in PHP 8.1 and this runs on 8.0.
 */
function isList(mixed $value): bool
{
    if (!is_array($value)) {
        return false;
    }
    $expected = 0;
    foreach ($value as $key => $_) {
        if ($key !== $expected++) {
            return false;
        }
    }
    return true;
}

/**
 * A comma separated column back into a list, in the order it was stored.
 * Used for both the accused and the location deck, which is why it can hand
 * back either ints or the raw strings.
 *
 * @return list<int|string>
 */
function idList(mixed $raw, bool $asInt = true): array
{
    if (!is_string($raw) || $raw === '') {
        return [];
    }
    $parts = array_values(array_filter(array_map('trim', explode(',', $raw)), fn ($p) => $p !== ''));
    return $asInt ? array_map('intval', $parts) : $parts;
}

/**
 * Resolves a stored location key into the room's language. Falls back to
 * English and then to the key itself, so a half-filled translation column
 * degrades to something readable instead of to a blank card.
 */
function locationText(?string $key, string $lang): ?string
{
    if ($key === null || $key === '') {
        return null;
    }
    foreach (locationRows() as $row) {
        if (($row['key'] ?? null) === $key) {
            // An empty column counts as "not translated yet", so it falls
            // through to English rather than showing the bare key.
            foreach ([$lang, 'en'] as $code) {
                $text = $row[$code] ?? null;
                if (is_string($text) && $text !== '') {
                    return $text;
                }
            }
            return $key;
        }
    }
    return $key;
}

function requireHost(bool $isHost): void
{
    if (!$isHost) {
        sendError('Only the host runs the operation', 403);
    }
}

/**
 * One ballot: as many names as there are spies, or fewer while the voter is
 * still making their mind up (an empty ballot is how a pick is taken back).
 * Every target must be somebody actually seated in this room, and never the
 * voter: accusing yourself is not a move, it is a way to skew a tally. Naming
 * the same person twice is refused for the same reason.
 *
 * @return list<int> the targets, in the order they were picked
 */
function validateBallot(PDO $db, int $roomId, int $voterId, mixed $raw, int $needed): array
{
    if (!is_array($raw)) {
        sendError('Ballot required', 400);
    }
    $targets = $raw['targets'] ?? null;
    if (!isList($targets)) {
        sendError('Bad ballot', 400);
    }
    if (count($targets) > $needed) {
        sendError('That is more names than there are spies', 400);
    }

    $seen = [];
    foreach ($targets as $target) {
        if (!is_int($target)) {
            sendError('Bad ballot', 400);
        }
        if ($target === $voterId) {
            sendError('You cannot accuse yourself', 400);
        }
        if (isset($seen[$target])) {
            sendError('That name is on the ballot twice', 400);
        }
        $seen[$target] = true;
    }

    if ($targets !== []) {
        $marks = implode(',', array_fill(0, count($targets), '?'));
        $stmt  = $db->prepare(
            "SELECT COUNT(*) FROM spy_players
             WHERE room_id = ? AND left_at IS NULL AND id IN ($marks)"
        );
        $stmt->execute(array_merge([$roomId], $targets));
        if ((int) $stmt->fetchColumn() !== count($targets)) {
            sendError('That player is not at the table', 400);
        }
    }
    return array_values($targets);
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
