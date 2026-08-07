<?php
declare(strict_types=1);
define('SECURE_ACCESS', true);

header('Content-Type: application/json; charset=utf-8');
// Responses vary with the session cookie, so they must never be cached. The
// shared-flight branch keeps this too: a public link is not a public cache.
header('Cache-Control: no-store');
// No Access-Control-Allow-Origin here: everything is gated by the session
// cookie, and wildcard CORS is incompatible with cookie auth.

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

require_once __DIR__ . '/../config/dev-mode.php';
require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../config/auth.php';

// Cloud copy of recorded flights (views/trails).
//
// This controller is entirely optional to the feature. Recording, history,
// the chart and playback all run on the device with no account and no
// network; a flight only reaches this file if someone signs in and wants it
// on another device or behind a share link.
//
// Two rules shape everything below.
//
// First, sync MERGES and is idempotent. The device holds the original and
// re-uploads whatever it has whenever it reconnects, keyed by a uuid it
// minted itself. UNIQUE (user_id, uuid) plus a last-write-wins comparison on
// the client's own `updated_at` clock means a repeated upload is a no-op and
// a stale device cannot overwrite a newer edit. A flight is effectively
// immutable once it ends (only its name and its deletion change afterwards),
// which is what makes last-write-wins safe here.
//
// Second, junk is dropped, never fatal. The payload comes out of IndexedDB on
// devices this code will never see; one unreadable flight must not stop the
// other nine from syncing. Only the envelope itself can fail a request.

const MAX_FLIGHTS_PER_SYNC = 10;
const MAX_POINTS_PER_FLIGHT = 2500;
const MAX_FLIGHTS_RETURNED = 200;
const MAX_NAME_LEN = 120;
const MAX_DELETES_PER_SYNC = 200;

function sendJson(mixed $data, int $code = 200): void
{
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

function sendError(string $message, int $code = 400): void
{
    http_response_code($code);
    echo json_encode(['error' => $message], JSON_UNESCAPED_UNICODE);
    exit;
}

function readBody(): array
{
    if (!empty($_POST)) return $_POST;
    $raw = file_get_contents('php://input');
    if (!$raw) return [];
    $json = json_decode($raw, true);
    if (is_array($json)) return $json;
    parse_str($raw, $parsed);
    return is_array($parsed) ? $parsed : [];
}

function viewerPayload(?array $viewer): ?array
{
    if ($viewer === null) return null;
    return [
        'id' => (int) $viewer['id'],
        'display_name' => $viewer['display_name'] ?? '',
        'avatar_url' => $viewer['avatar_url'] ?? null,
    ];
}

function isUuid(mixed $v): bool
{
    return is_string($v) && preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i', $v) === 1;
}

/** Epoch milliseconds to a MySQL DATETIME in UTC. */
function msToSql(?int $ms): ?string
{
    if ($ms === null) return null;
    return gmdate('Y-m-d H:i:s', intdiv($ms, 1000));
}

/**
 * Validate one uploaded flight, or return null to drop it.
 *
 * Everything here is defensive on purpose: this is the boundary between a
 * browser database nobody controls and a table that has to stay readable.
 * A flight that fails any check is skipped silently by the caller.
 */
function cleanFlight(mixed $raw): ?array
{
    if (!is_array($raw)) return null;
    if (($raw['v'] ?? null) !== 1) return null;
    if (!isUuid($raw['uuid'] ?? null)) return null;

    $points = $raw['points'] ?? null;
    if (!is_array($points)) return null;
    foreach (['t', 'lat', 'lon'] as $col) {
        if (!isset($points[$col]) || !is_array($points[$col])) return null;
    }
    $n = count($points['t']);
    if ($n === 0 || $n > MAX_POINTS_PER_FLIGHT) return null;
    if (count($points['lat']) !== $n || count($points['lon']) !== $n) return null;

    foreach ($points['lat'] as $v) {
        if (!is_numeric($v) || $v < -90 || $v > 90) return null;
    }
    foreach ($points['lon'] as $v) {
        if (!is_numeric($v) || $v < -180 || $v > 180) return null;
    }

    $startedAt = $raw['startedAt'] ?? null;
    if (!is_numeric($startedAt)) return null;
    $startedAt = (int) $startedAt;
    // Anything before powered flight or far in the future is a broken clock.
    if ($startedAt < 0 || $startedAt > (time() + 86400) * 1000) return null;

    $endedAt = is_numeric($raw['endedAt'] ?? null) ? (int) $raw['endedAt'] : null;
    $updatedAt = is_numeric($raw['updatedAt'] ?? null) ? (int) $raw['updatedAt'] : $startedAt;

    return [
        'uuid' => (string) $raw['uuid'],
        'name' => mb_substr(trim((string) ($raw['name'] ?? '')), 0, MAX_NAME_LEN),
        'started_at' => msToSql($startedAt),
        'ended_at' => msToSql($endedAt),
        'stats' => json_encode(is_array($raw['stats'] ?? null) ? $raw['stats'] : new stdClass()),
        'points' => json_encode($points),
        'point_count' => $n,
        'updated_at' => $updatedAt,
    ];
}

/** A stored row as the client's deserializeFlight() expects to read it. */
function flightPayload(array $row, bool $withTrack): array
{
    $out = [
        'v' => 1,
        'uuid' => $row['uuid'],
        'name' => $row['name'],
        'startedAt' => strtotime($row['started_at'] . ' UTC') * 1000,
        'endedAt' => $row['ended_at'] ? strtotime($row['ended_at'] . ' UTC') * 1000 : null,
        'updatedAt' => (int) $row['updated_at'],
        'stats' => json_decode($row['stats'], true) ?: new stdClass(),
        'point_count' => (int) $row['point_count'],
    ];
    if ($withTrack) {
        $out['points'] = json_decode($row['points'], true) ?: ['t' => [], 'lat' => [], 'lon' => []];
    }
    return $out;
}

/** The caller's own live flight by uuid, or null. Never another account's. */
function ownFlight(PDO $db, int $userId, string $uuid): ?array
{
    $stmt = $db->prepare('SELECT * FROM trails_flights
        WHERE user_id = ? AND uuid = ? AND deleted_at IS NULL LIMIT 1');
    $stmt->execute([$userId, $uuid]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

// ------------------------------------------------------------------

$method = $_SERVER['REQUEST_METHOD'];
$resource = $_GET['resource'] ?? '';
$action = $_GET['action'] ?? '';
$uuid = $_GET['uuid'] ?? '';

try {

    // ---- who is asking ------------------------------------------------
    if ($resource === 'session') {
        $viewer = Auth::currentUser();
        sendJson(['viewer' => viewerPayload($viewer)]);
    }

    // ---- a public share link, the one branch with no account ----------
    if ($resource === 'shared') {
        $db = Database::read();
        $token = (string) ($_GET['t'] ?? '');
        if ($token === '' || !preg_match('/^[0-9a-f]{32}$/i', $token)) {
            sendError('Not found.', 404);
        }
        $stmt = $db->prepare('SELECT f.*, u.display_name
            FROM trails_shares s
            JOIN trails_flights f ON f.id = s.flight_id
            JOIN users u ON u.id = f.user_id
            WHERE s.token_hash = ? AND f.deleted_at IS NULL
            LIMIT 1');
        $stmt->execute([hash('sha256', $token)]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            sendError('Not found.', 404);
        }
        sendJson([
            'flight' => flightPayload($row, true),
            'owner' => $row['display_name'] ?: null,
        ]);
    }

    // ---- everything below needs an account ----------------------------
    $user = Auth::requireLogin();
    $userId = (int) $user['id'];

    if ($resource === 'flights' && $method === 'GET') {
        $db = Database::read();
        $stmt = $db->prepare('SELECT f.uuid, f.name, f.started_at, f.ended_at, f.stats,
                   f.point_count, f.updated_at,
                   (s.id IS NOT NULL) AS shared
            FROM trails_flights f
            LEFT JOIN trails_shares s ON s.flight_id = f.id
            WHERE f.user_id = ? AND f.deleted_at IS NULL
            ORDER BY f.started_at DESC
            LIMIT ' . MAX_FLIGHTS_RETURNED);
        $stmt->execute([$userId]);

        $flights = [];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $flights[] = [
                'uuid' => $row['uuid'],
                'name' => $row['name'],
                'started_at' => strtotime($row['started_at'] . ' UTC') * 1000,
                'ended_at' => $row['ended_at'] ? strtotime($row['ended_at'] . ' UTC') * 1000 : null,
                'stats' => json_decode($row['stats'], true) ?: new stdClass(),
                'point_count' => (int) $row['point_count'],
                'updated_at' => (int) $row['updated_at'],
                'shared' => (bool) $row['shared'],
            ];
        }
        sendJson(['viewer' => viewerPayload($user), 'flights' => $flights]);
    }

    if ($resource === 'flight') {
        if (!isUuid($uuid)) {
            sendError('Not found.', 404);
        }
        // The write connection even for the GET: a rename that just landed
        // must be visible to the device that made it.
        $db = Database::write();
        $row = ownFlight($db, $userId, $uuid);
        // A miss is 404 rather than 403 on purpose: a 403 would confirm that
        // some other account owns this uuid.
        if (!$row) {
            sendError('Not found.', 404);
        }

        if ($method === 'GET') {
            sendJson(['flight' => flightPayload($row, true)]);
        }

        if ($method === 'POST' && $action === 'rename') {
            $body = readBody();
            $name = mb_substr(trim((string) ($body['name'] ?? '')), 0, MAX_NAME_LEN);
            $stmt = $db->prepare('UPDATE trails_flights SET name = ?, updated_at = ?
                WHERE id = ? AND user_id = ?');
            $stmt->execute([$name, (int) round(microtime(true) * 1000), (int) $row['id'], $userId]);
            sendJson(['ok' => true, 'name' => $name]);
        }

        if ($method === 'POST' && $action === 'delete') {
            // Soft delete: the tombstone is what tells the other devices, and
            // the cascade takes the public link down with it.
            $stmt = $db->prepare('UPDATE trails_flights SET deleted_at = NOW(), updated_at = ?
                WHERE id = ? AND user_id = ?');
            $stmt->execute([(int) round(microtime(true) * 1000), (int) $row['id'], $userId]);
            $db->prepare('DELETE FROM trails_shares WHERE flight_id = ?')->execute([(int) $row['id']]);
            sendJson(['ok' => true]);
        }

        sendError('Unsupported action.', 400);
    }

    // ---- the merge ----------------------------------------------------
    if ($resource === 'sync' && $method === 'POST') {
        $db = Database::write();
        $body = readBody();
        $incoming = $body['flights'] ?? [];
        $deleted = $body['deleted'] ?? [];
        if (!is_array($incoming) || !is_array($deleted)) {
            sendError('Malformed sync payload.', 400);
        }
        if (count($incoming) > MAX_FLIGHTS_PER_SYNC) {
            sendError('Too many flights in one request.', 400);
        }
        if (count($deleted) > MAX_DELETES_PER_SYNC) {
            sendError('Too many deletions in one request.', 400);
        }

        $accepted = [];
        $now = (int) round(microtime(true) * 1000);

        foreach ($incoming as $raw) {
            $flight = cleanFlight($raw);
            if ($flight === null) {
                continue;   // one bad flight never fails the batch
            }

            // Insert, or update only when the incoming copy is genuinely
            // newer. The comparison happens in SQL so two devices syncing at
            // once cannot interleave a read and a write.
            $stmt = $db->prepare('INSERT INTO trails_flights
                    (user_id, uuid, name, started_at, ended_at, stats, points, point_count, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    name        = IF(VALUES(updated_at) > trails_flights.updated_at, VALUES(name), trails_flights.name),
                    started_at  = IF(VALUES(updated_at) > trails_flights.updated_at, VALUES(started_at), trails_flights.started_at),
                    ended_at    = IF(VALUES(updated_at) > trails_flights.updated_at, VALUES(ended_at), trails_flights.ended_at),
                    stats       = IF(VALUES(updated_at) > trails_flights.updated_at, VALUES(stats), trails_flights.stats),
                    points      = IF(VALUES(updated_at) > trails_flights.updated_at, VALUES(points), trails_flights.points),
                    point_count = IF(VALUES(updated_at) > trails_flights.updated_at, VALUES(point_count), trails_flights.point_count),
                    updated_at  = GREATEST(VALUES(updated_at), trails_flights.updated_at)');
            $stmt->execute([
                $userId, $flight['uuid'], $flight['name'], $flight['started_at'], $flight['ended_at'],
                $flight['stats'], $flight['points'], $flight['point_count'], $flight['updated_at'],
            ]);
            $accepted[] = $flight['uuid'];
        }

        foreach ($deleted as $gone) {
            if (!isUuid($gone)) continue;
            $stmt = $db->prepare('UPDATE trails_flights SET deleted_at = NOW(), updated_at = ?
                WHERE user_id = ? AND uuid = ? AND deleted_at IS NULL');
            $stmt->execute([$now, $userId, $gone]);
        }

        sendJson(['accepted' => $accepted]);
    }

    // ---- share links --------------------------------------------------
    if ($resource === 'share' && $method === 'POST') {
        $db = Database::write();
        if (!isUuid($uuid)) {
            sendError('Not found.', 404);
        }
        $row = ownFlight($db, $userId, $uuid);
        if (!$row) {
            sendError('Not found.', 404);
        }
        $flightId = (int) $row['id'];

        if ($action === 'revoke') {
            $db->prepare('DELETE FROM trails_shares WHERE flight_id = ?')->execute([$flightId]);
            sendJson(['ok' => true]);
        }

        if ($action === 'create') {
            // The token is shown once and never stored: only its hash lives
            // here, so a dump of this table cannot be replayed as working
            // links to somebody's movements.
            $token = bin2hex(random_bytes(16));
            $db->prepare('DELETE FROM trails_shares WHERE flight_id = ?')->execute([$flightId]);
            $stmt = $db->prepare('INSERT INTO trails_shares (flight_id, token_hash) VALUES (?, ?)');
            $stmt->execute([$flightId, hash('sha256', $token)]);
            sendJson(['token' => $token]);
        }

        sendError('Unsupported action.', 400);
    }

    sendError('Unknown resource.', 404);
} catch (InvalidArgumentException $e) {
    sendError($e->getMessage(), 400);
} catch (\Throwable $e) {
    error_log('trails-controller: ' . $e->getMessage());
    sendError($GLOBALS['DEV_MODE'] ? $e->getMessage() : 'Server error.', 500);
}
