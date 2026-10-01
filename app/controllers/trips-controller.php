<?php
declare(strict_types=1);
define('SECURE_ACCESS', true);

header('Content-Type: application/json; charset=utf-8');
// Responses vary with the session cookie, so they must never be cached. The
// photo branch overrides this for its bytes, privately.
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
require_once __DIR__ . '/../services/image-service.php';
require_once __DIR__ . '/../services/trips-service.php';

// A fatal (GD out of memory) bypasses every catch. Still answer in JSON with a
// code, so the outbox reads it as a server fault and retries later.
register_shutdown_function(function () {
    $err = error_get_last();
    if ($err && in_array($err['type'], [E_ERROR, E_CORE_ERROR, E_COMPILE_ERROR], true) && !headers_sent()) {
        http_response_code(500);
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode(['error' => 'Server error.', 'code' => 'server']);
    }
});

// Travel photo albums on a map (views/trips).
//
// A trip is an ordered chain of places and a place is an album of photos. A
// trip belongs to its owner and to the travellers who joined through its
// invite link; to anyone else it does not exist, so every miss is a 404 that
// looks exactly like "no such trip".
//
// Every create is idempotent by a uuid the phone minted. The offline outbox
// retries until it hears back, so the same uuid twice answers with the row
// that already exists, and a uuid that was deleted answers 410 rather than
// coming back to life (trips_tombstones).
//
// Errors are always {error, code}. The client's outbox decides retry, give up
// or ask the user from `code`, and tests/trips-logic.test.mjs holds every code
// emitted here to a case in classifyResponse().

// The fixed set of line colours. Same keys as LINE_COLOURS in
// views/trips/logic.js; a test holds the two lists together.
const LINE_COLOURS = ['red', 'blue', 'green', 'yellow', 'magenta', 'brown', 'teal', 'orange', 'violet', 'grey'];

const MAX_NAME_LEN = 120;
const MAX_TRIPS_OWNED = 100;
const MAX_PLACES_PER_TRIP = 200;
const MAX_PHOTOS_PER_TRIP = 3000;
const MAX_MEMBERS = 20;
const MAX_CAPTION_LEN = 500;
// Where the photos live: assets/uploads/trips/, denied to the web by a
// runtime .htaccess (ImageService::protectFolder) and read back only through
// ?resource=photo below, after the same access check as the trip itself.
const PHOTO_FOLDER = 'trips';
const LOC_SOURCES = ['exif', 'device', 'place', 'manual'];
// Below this much free disk, refuse uploads rather than fill the server.
const MIN_FREE_DISK = 2 * 1024 ** 3;
// The client resizes to 2048 on the long edge; anything past this is not ours.
const MAX_EDGE = 2560;
const DEFAULT_QUOTA_BYTES = 1073741824; // 1 GiB per account

function sendJson(mixed $data, int $status = 200): never
{
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

function sendError(string $message, int $status, string $code): never
{
    http_response_code($status);
    echo json_encode(['error' => $message, 'code' => $code], JSON_UNESCAPED_UNICODE);
    exit;
}

function notFound(): never
{
    sendError('Not found.', 404, 'not_found');
}

/**
 * The JSON body of a write, or 415. A cross-site form can only send
 * urlencoded, multipart or text/plain, so refusing everything but JSON on the
 * JSON routes is a CSRF backstop that costs nothing.
 */
function jsonBody(): array
{
    $type = strtolower(trim(explode(';', $_SERVER['CONTENT_TYPE'] ?? '')[0]));
    if ($type !== 'application/json') {
        sendError('Expected a JSON body.', 415, 'unsupported_type');
    }
    $data = json_decode((string) file_get_contents('php://input'), true);
    return is_array($data) ? $data : [];
}

/**
 * Every write carries X-Trips-Client. A cross-site form cannot set a custom
 * header and a cross-origin fetch that sets one fails the preflight, which is
 * what protects the multipart photo upload, where jsonBody() cannot apply.
 */
function requireClientHeader(): void
{
    if (($_SERVER['HTTP_X_TRIPS_CLIENT'] ?? '') !== '1') {
        sendError('Missing client header.', 403, 'client_header');
    }
}

function isUuid(mixed $v): bool
{
    return is_string($v)
        && preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/', $v) === 1;
}

function cleanName(mixed $v): string
{
    return mb_substr(trim(preg_replace('/\s+/u', ' ', (string) $v)), 0, MAX_NAME_LEN);
}

/** An ini size like "40M" in bytes. */
function iniBytes(string $key): int
{
    $raw = trim((string) ini_get($key));
    if ($raw === '') return PHP_INT_MAX;
    $n = (int) $raw;
    return match (strtolower(substr($raw, -1))) {
        'g' => $n * 1024 ** 3,
        'm' => $n * 1024 ** 2,
        'k' => $n * 1024,
        default => $n,
    };
}

function quotaBytes(): int
{
    $env = getenv('TRIPS_QUOTA_BYTES');
    return is_string($env) && ctype_digit($env) ? (int) $env : DEFAULT_QUOTA_BYTES;
}

function viewerPayload(?array $viewer): ?array
{
    if ($viewer === null) return null;
    return [
        'id' => (int) $viewer['id'],
        'display_name' => $viewer['display_name'] ?? '',
        'is_admin' => (int) ($viewer['is_admin'] ?? 0) === 1,
    ];
}

function isTombstoned(PDO $db, string $uuid): bool
{
    $stmt = $db->prepare('SELECT 1 FROM trips_tombstones WHERE uuid = ?');
    $stmt->execute([$uuid]);
    return (bool) $stmt->fetchColumn();
}

/**
 * The trip and the caller's role on it, or null when the caller may not see
 * it. Roles: owner, traveller, and viewer for anyone on the showcase trip
 * (signed out included), which is read-only and carries no one's name but
 * the owner's. The showcase only counts while its owner is an active admin.
 */
function tripAccess(PDO $db, string $uuid, ?int $userId): ?array
{
    if (!isUuid($uuid)) return null;
    $stmt = $db->prepare('SELECT t.*, u.display_name AS owner_name,
            (t.showcase = 1 AND u.is_admin = 1 AND u.is_active = 1) AS is_showcase,
            (m.user_id IS NOT NULL) AS is_member
        FROM trips t
        JOIN users u ON u.id = t.owner_id
        LEFT JOIN trips_members m ON m.trip_id = t.id AND m.user_id = ?
        WHERE t.uuid = ? LIMIT 1');
    $stmt->execute([$userId ?? 0, $uuid]);
    $trip = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$trip) return null;
    if ($userId !== null && (int) $trip['owner_id'] === $userId) {
        return ['trip' => $trip, 'role' => 'owner'];
    }
    if ($userId !== null && (int) $trip['is_member'] === 1) {
        return ['trip' => $trip, 'role' => 'traveller'];
    }
    if ((int) $trip['is_showcase'] === 1) {
        return ['trip' => $trip, 'role' => 'viewer'];
    }
    return null;
}

/** 403 unless the caller is the owner or a traveller. A viewer only looks. */
function requireMember(array $access): void
{
    if ($access['role'] !== 'owner' && $access['role'] !== 'traveller') {
        sendError('This trip is read-only for you.', 403, 'forbidden');
    }
}

function requireOwner(array $access): void
{
    if ($access['role'] !== 'owner') {
        sendError('Only the trip\'s owner can do that.', 403, 'forbidden');
    }
}

function tripPayload(array $trip, string $role): array
{
    return [
        'uuid' => $trip['uuid'],
        'name' => $trip['name'],
        'line' => $trip['line'],
        'role' => $role,
        'owner_name' => $trip['owner_name'] ?? null,
        'cover_photo_uuid' => $trip['cover_photo_uuid'],
        'showcase' => (int) ($trip['showcase'] ?? 0) === 1,
        'version' => (int) $trip['version'],
    ];
}

function placePayload(array $p, bool $withIds = true): array
{
    return [
        'uuid' => $p['uuid'],
        'name' => $p['name'],
        'lat' => (float) $p['lat'],
        'lon' => (float) $p['lon'],
        'country_code' => $p['country_code'],
        'position' => (int) $p['position'],
        'by_id' => $withIds && $p['created_by'] !== null ? (int) $p['created_by'] : null,
    ];
}

/** A coordinate pair from a body, or null when either is missing or off the globe. */
function cleanLatLon(mixed $lat, mixed $lon): ?array
{
    if (!is_numeric($lat) || !is_numeric($lon)) return null;
    $lat = (float) $lat;
    $lon = (float) $lon;
    if ($lat < -90 || $lat > 90 || $lon < -180 || $lon > 180) return null;
    return [round($lat, 6), round($lon, 6)];
}

/** Every change to a trip or anything in it moves its version on. */
function bumpVersion(PDO $db, int $tripId): void
{
    $db->prepare('UPDATE trips SET version = version + 1 WHERE id = ?')->execute([$tripId]);
}

/** A place with the caller's access to its trip, or null. */
function placeAccess(PDO $db, string $uuid, ?int $userId): ?array
{
    if (!isUuid($uuid)) return null;
    $stmt = $db->prepare('SELECT p.*, t.uuid AS trip_uuid FROM trips_places p
        JOIN trips t ON t.id = p.trip_id WHERE p.uuid = ? LIMIT 1');
    $stmt->execute([$uuid]);
    $place = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$place) return null;
    $access = tripAccess($db, $place['trip_uuid'], $userId);
    return $access === null ? null : $access + ['place' => $place];
}

const PHOTO_SELECT = 'SELECT p.*, pl.uuid AS place_uuid, u.display_name AS by_name,
        d.width AS w, d.height AS h
    FROM trips_photos p
    JOIN trips_places pl ON pl.id = p.place_id
    JOIN images d ON d.id = p.image_id
    LEFT JOIN users u ON u.id = p.uploaded_by';

/** A photo as the client renders it. Names are left out where they must not travel. */
function photoPayload(array $p, bool $withNames = true): array
{
    return [
        'uuid' => $p['uuid'],
        'place' => $p['place_uuid'],
        'lat' => (float) $p['lat'],
        'lon' => (float) $p['lon'],
        'loc_source' => $p['loc_source'],
        'taken_at' => $p['taken_at'],
        'offset_min' => $p['taken_offset_min'] === null ? null : (int) $p['taken_offset_min'],
        'caption' => $p['caption'],
        'by' => $withNames ? ($p['by_name'] ?? null) : null,
        'by_id' => $withNames && $p['uploaded_by'] !== null ? (int) $p['uploaded_by'] : null,
        'w' => (int) $p['w'],
        'h' => (int) $p['h'],
    ];
}

/** A photo with the caller's access to its trip, or null. */
function photoAccess(PDO $db, string $uuid, ?int $userId): ?array
{
    if (!isUuid($uuid)) return null;
    $stmt = $db->prepare(PHOTO_SELECT . ' WHERE p.uuid = ? LIMIT 1');
    $stmt->execute([$uuid]);
    $photo = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$photo) return null;
    $trip = $db->prepare('SELECT uuid FROM trips WHERE id = ?');
    $trip->execute([(int) $photo['trip_id']]);
    $access = tripAccess($db, (string) $trip->fetchColumn(), $userId);
    return $access === null ? null : $access + ['photo' => $photo];
}

/** Bytes of both files of every photo the user uploaded, anywhere. */
function usageBytes(PDO $db, int $userId): int
{
    $stmt = $db->prepare('SELECT COALESCE(SUM(d.file_size + t.file_size), 0)
        FROM trips_photos p
        JOIN images d ON d.id = p.image_id
        JOIN images t ON t.id = p.thumb_image_id
        WHERE p.uploaded_by = ?');
    $stmt->execute([$userId]);
    return (int) $stmt->fetchColumn();
}

/** The whole trip as the client renders it. A viewer gets no names but the owner's. */
function tripTree(PDO $db, array $access): array
{
    $trip = $access['trip'];
    $isMember = $access['role'] !== 'viewer';
    $places = $db->prepare('SELECT * FROM trips_places WHERE trip_id = ? ORDER BY position, id');
    $places->execute([(int) $trip['id']]);

    $photos = $db->prepare(PHOTO_SELECT . ' WHERE p.trip_id = ? ORDER BY p.taken_at IS NULL, p.taken_at, p.id');
    $photos->execute([(int) $trip['id']]);

    $members = [];
    if ($isMember) {
        $members[] = ['id' => (int) $trip['owner_id'], 'name' => $trip['owner_name'], 'role' => 'owner'];
        $m = $db->prepare('SELECT u.id, u.display_name FROM trips_members m
            JOIN users u ON u.id = m.user_id WHERE m.trip_id = ? ORDER BY m.joined_at, u.id');
        $m->execute([(int) $trip['id']]);
        foreach ($m->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $members[] = ['id' => (int) $row['id'], 'name' => $row['display_name'], 'role' => 'traveller'];
        }
    }

    return [
        'trip' => tripPayload($trip, $access['role']) + ['invite_on' => $trip['token_hash'] !== null && $access['role'] === 'owner'],
        'places' => array_map(fn ($p) => placePayload($p, $isMember), $places->fetchAll(PDO::FETCH_ASSOC)),
        'photos' => array_map(fn ($p) => photoPayload($p, $isMember), $photos->fetchAll(PDO::FETCH_ASSOC)),
        'members' => $members,
    ];
}

/** The trip row again after a write, with the caller's role. */
function freshAccess(PDO $db, string $uuid, int $userId): array
{
    return tripAccess($db, $uuid, $userId);
}

/** Clears a cover that pointed at any of these photos. */
function clearCover(PDO $db, int $tripId, array $photoUuids): void
{
    if (!$photoUuids) return;
    $marks = implode(',', array_fill(0, count($photoUuids), '?'));
    $db->prepare("UPDATE trips SET cover_photo_uuid = NULL WHERE id = ? AND cover_photo_uuid IN ($marks)")
        ->execute([$tripId, ...$photoUuids]);
}

// ------------------------------------------------------------------

$method = $_SERVER['REQUEST_METHOD'];
$resource = $_GET['resource'] ?? '';
$action = $_GET['action'] ?? '';
$uuid = $_GET['uuid'] ?? '';

try {

    // ---- who is asking, and what the server will accept ----------------
    if ($resource === 'session') {
        sendJson([
            'viewer' => viewerPayload(Auth::currentUser()),
            'limits' => [
                'max_upload_bytes' => min(iniBytes('upload_max_filesize'), iniBytes('post_max_size')),
                'max_edge' => MAX_EDGE,
                'quota_bytes' => quotaBytes(),
            ],
        ]);
    }

    // ---- the showcase: the one trip signed-out visitors see ----------------
    if ($resource === 'showcase' && $method === 'GET') {
        $db = Database::read();
        $uuidRow = $db->query('SELECT t.uuid FROM trips t JOIN users u ON u.id = t.owner_id
            WHERE t.showcase = 1 AND u.is_admin = 1 AND u.is_active = 1 LIMIT 1')->fetchColumn();
        $viewer = Auth::currentUser();
        $access = $uuidRow ? tripAccess($db, (string) $uuidRow, $viewer ? (int) $viewer['id'] : null) : null;
        if ($access === null) notFound();
        sendJson(tripTree($db, $access));
    }

    // ---- what an invite link leads to, before anyone joins -----------------
    if ($resource === 'invite' && $method === 'GET') {
        $token = strtolower((string) ($_GET['t'] ?? ''));
        if (!preg_match('/^[0-9a-f]{32}$/', $token)) notFound();
        $db = Database::read();
        $stmt = $db->prepare('SELECT t.uuid, t.name, t.line, u.display_name AS owner_name,
                (SELECT COUNT(*) FROM trips_places p WHERE p.trip_id = t.id) AS place_count,
                (SELECT COUNT(*) FROM trips_photos f WHERE f.trip_id = t.id) AS photo_count
            FROM trips t JOIN users u ON u.id = t.owner_id WHERE t.token_hash = ? LIMIT 1');
        $stmt->execute([hash('sha256', $token)]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) notFound();
        sendJson(['invite' => [
            'uuid' => $row['uuid'],
            'name' => $row['name'],
            'line' => $row['line'],
            'owner_name' => $row['owner_name'],
            'place_count' => (int) $row['place_count'],
            'photo_count' => (int) $row['photo_count'],
        ]]);
    }

    // ---- a photo's bytes ---------------------------------------------------
    // Before the login gate because a showcase trip's photos are public. The
    // files themselves are denied to the web; this is the only way in.
    if ($resource === 'photo' && $method === 'GET') {
        $db = Database::read();
        $viewer = Auth::currentUser();
        $access = photoAccess($db, (string) $uuid, $viewer ? (int) $viewer['id'] : null);
        if ($access === null) notFound();
        $imageId = ($_GET['size'] ?? '') === 'display'
            ? (int) $access['photo']['image_id']
            : (int) $access['photo']['thumb_image_id'];
        $img = $db->prepare('SELECT uuid, folder, mime_type FROM images WHERE id = ?');
        $img->execute([$imageId]);
        $row = $img->fetch(PDO::FETCH_ASSOC);
        try {
            $path = $row ? ImageService::filePath($row['uuid'], $row['folder'], $row['mime_type']) : null;
        } catch (RuntimeException) {
            $path = null;
        }
        if ($path === null) notFound();

        // A stored photo never changes (a new photo is a new uuid), so the
        // browser may keep it forever, but only for this viewer. The explicit
        // Expires keeps Apache's mod_expires from adding a shorter one.
        header('Content-Type: ' . $row['mime_type']);
        header('Content-Length: ' . filesize($path));
        header('Cache-Control: private, max-age=31536000, immutable');
        header('Expires: ' . gmdate('D, d M Y H:i:s', time() + 31536000) . ' GMT');
        header('X-Content-Type-Options: nosniff');
        readfile($path);
        exit;
    }

    // ---- everything below needs an account ----------------------------
    if ($method !== 'GET') {
        requireClientHeader();
    }
    $user = Auth::requireLogin();
    $userId = (int) $user['id'];

    if ($resource === 'trips' && $method === 'GET') {
        $db = Database::write();
        $stmt = $db->prepare('SELECT t.*, u.display_name AS owner_name,
                IF(t.owner_id = ?, \'owner\', \'traveller\') AS role,
                (SELECT COUNT(*) FROM trips_photos ph WHERE ph.trip_id = t.id) AS photo_count
            FROM trips t
            JOIN users u ON u.id = t.owner_id
            LEFT JOIN trips_members m ON m.trip_id = t.id AND m.user_id = ?
            WHERE t.owner_id = ? OR m.user_id IS NOT NULL
            ORDER BY t.created_at DESC, t.id DESC');
        $stmt->execute([$userId, $userId, $userId]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $places = $db->prepare('SELECT * FROM trips_places WHERE trip_id = ? ORDER BY position, id');
        $trips = [];
        foreach ($rows as $row) {
            $places->execute([(int) $row['id']]);
            $trips[] = tripPayload($row, $row['role']) + [
                'photo_count' => (int) $row['photo_count'],
                'places' => array_map('placePayload', $places->fetchAll(PDO::FETCH_ASSOC)),
            ];
        }
        sendJson([
            'viewer' => viewerPayload($user),
            'trips' => $trips,
            'usage' => ['bytes' => usageBytes($db, $userId), 'quota_bytes' => quotaBytes()],
        ]);
    }

    if ($resource === 'trip' && $method === 'GET') {
        // The write connection even for a read: an edit that just landed must
        // be visible to the device that made it.
        $db = Database::write();
        $access = tripAccess($db, (string) $uuid, $userId);
        if ($access === null) notFound();
        sendJson(tripTree($db, $access));
    }

    if ($resource === 'trip' && $method === 'POST' && $action === '') {
        $db = Database::write();
        $body = jsonBody();
        $newUuid = $body['uuid'] ?? null;
        $name = cleanName($body['name'] ?? '');
        if (!isUuid($newUuid) || $name === '') {
            sendError('A trip needs a uuid and a name.', 422, 'invalid');
        }
        $line = in_array($body['line'] ?? null, LINE_COLOURS, true) ? $body['line'] : LINE_COLOURS[0];

        if (isTombstoned($db, $newUuid)) {
            sendError('That trip was deleted.', 410, 'gone');
        }
        $existing = tripAccess($db, $newUuid, $userId);
        if ($existing !== null && $existing['role'] === 'owner') {
            sendJson(['trip' => tripPayload($existing['trip'], 'owner')], 200);
        }
        $taken = $db->prepare('SELECT 1 FROM trips WHERE uuid = ?');
        $taken->execute([$newUuid]);
        if ($taken->fetchColumn()) {
            sendError('That id is already in use.', 409, 'conflict');
        }

        $owned = $db->prepare('SELECT COUNT(*) FROM trips WHERE owner_id = ?');
        $owned->execute([$userId]);
        if ((int) $owned->fetchColumn() >= MAX_TRIPS_OWNED) {
            sendError('You have reached the limit of ' . MAX_TRIPS_OWNED . ' trips.', 409, 'full');
        }

        $db->prepare('INSERT INTO trips (uuid, owner_id, name, line) VALUES (?, ?, ?, ?)')
            ->execute([$newUuid, $userId, $name, $line]);
        $access = tripAccess($db, $newUuid, $userId);
        sendJson(['trip' => tripPayload($access['trip'], 'owner')], 201);
    }

    // ---- places ------------------------------------------------------
    if ($resource === 'place' && $method === 'POST' && $action === '') {
        $db = Database::write();
        $body = jsonBody();
        $newUuid = $body['uuid'] ?? null;
        $tripUuid = (string) ($body['trip'] ?? '');
        $name = cleanName($body['name'] ?? '');
        $at = cleanLatLon($body['lat'] ?? null, $body['lon'] ?? null);
        if (!isUuid($newUuid) || !isUuid($tripUuid) || $name === '' || $at === null) {
            sendError('A place needs a uuid, a trip, a name and a position on the globe.', 422, 'invalid');
        }
        $cc = strtolower((string) ($body['country_code'] ?? ''));
        $cc = preg_match('/^[a-z]{2}$/', $cc) ? $cc : null;

        if (isTombstoned($db, $newUuid)) {
            sendError('That place was deleted.', 410, 'gone');
        }
        $existing = placeAccess($db, $newUuid, $userId);
        if ($existing !== null && $existing['role'] !== 'viewer') {
            if ($existing['trip']['uuid'] !== $tripUuid) {
                sendError('That id is already in use.', 409, 'conflict');
            }
            sendJson(['place' => placePayload($existing['place'])], 200);
        }
        $taken = $db->prepare('SELECT 1 FROM trips_places WHERE uuid = ?');
        $taken->execute([$newUuid]);
        if ($taken->fetchColumn()) {
            sendError('That id is already in use.', 409, 'conflict');
        }

        $access = tripAccess($db, $tripUuid, $userId);
        if ($access === null) {
            if (isTombstoned($db, $tripUuid)) sendError('That trip was deleted.', 410, 'trip_gone');
            notFound();
        }
        requireMember($access);
        $tripId = (int) $access['trip']['id'];

        $db->beginTransaction();
        // Lock the trip so two travellers adding a stop at once cannot both
        // take the same position.
        $db->prepare('SELECT id FROM trips WHERE id = ? FOR UPDATE')->execute([$tripId]);
        $count = $db->prepare('SELECT COUNT(*), COALESCE(MAX(position) + 1, 0) FROM trips_places WHERE trip_id = ?');
        $count->execute([$tripId]);
        [$n, $next] = array_map('intval', $count->fetch(PDO::FETCH_NUM));
        if ($n >= MAX_PLACES_PER_TRIP) {
            $db->rollBack();
            sendError('A trip can hold ' . MAX_PLACES_PER_TRIP . ' places.', 409, 'full');
        }
        $db->prepare('INSERT INTO trips_places (uuid, trip_id, created_by, name, lat, lon, country_code, position)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            ->execute([$newUuid, $tripId, $userId, $name, $at[0], $at[1], $cc, $next]);
        bumpVersion($db, $tripId);
        $db->commit();

        $created = placeAccess($db, $newUuid, $userId);
        sendJson(['place' => placePayload($created['place'])], 201);
    }

    // ---- changing a trip (the owner) ---------------------------------------
    if ($resource === 'trip' && $method === 'POST' && $action !== '') {
        $db = Database::write();
        $body = jsonBody();
        $access = tripAccess($db, (string) $uuid, $userId);
        if ($access === null || $access['role'] === 'viewer') notFound();
        requireOwner($access);
        $trip = $access['trip'];
        $tripId = (int) $trip['id'];

        if ($action === 'update') {
            $name = array_key_exists('name', $body) ? cleanName($body['name']) : $trip['name'];
            $line = in_array($body['line'] ?? null, LINE_COLOURS, true) ? $body['line'] : $trip['line'];
            if ($name === '') sendError('A trip needs a name.', 422, 'invalid');
            $db->prepare('UPDATE trips SET name = ?, line = ?, version = version + 1 WHERE id = ?')
                ->execute([$name, $line, $tripId]);
            sendJson(['trip' => tripPayload(freshAccess($db, $trip['uuid'], $userId)['trip'], 'owner')]);
        }

        if ($action === 'cover') {
            $photo = (string) ($body['photo'] ?? '');
            $in = $db->prepare('SELECT 1 FROM trips_photos WHERE uuid = ? AND trip_id = ?');
            $in->execute([$photo, $tripId]);
            if (!$in->fetchColumn()) sendError('The cover has to be a photo in this trip.', 422, 'invalid');
            $db->prepare('UPDATE trips SET cover_photo_uuid = ?, version = version + 1 WHERE id = ?')->execute([$photo, $tripId]);
            sendJson(['trip' => tripPayload(freshAccess($db, $trip['uuid'], $userId)['trip'], 'owner')]);
        }

        if ($action === 'reorder') {
            $wanted = $body['places'] ?? null;
            $current = $db->prepare('SELECT uuid FROM trips_places WHERE trip_id = ?');
            $current->execute([$tripId]);
            $have = $current->fetchAll(PDO::FETCH_COLUMN);
            $sortedHave = $have;
            sort($sortedHave);
            $sortedWanted = is_array($wanted) ? array_map('strval', $wanted) : [];
            sort($sortedWanted);
            // Exactly every place, once: anything else was drawn from a stale screen.
            if (!is_array($wanted) || $sortedWanted !== $sortedHave) {
                sendError('The line changed since you loaded it. Reload and try again.', 409, 'stale_order');
            }
            $db->beginTransaction();
            $set = $db->prepare('UPDATE trips_places SET position = ? WHERE uuid = ? AND trip_id = ?');
            foreach (array_values($wanted) as $i => $placeUuid) {
                $set->execute([$i, $placeUuid, $tripId]);
            }
            bumpVersion($db, $tripId);
            $db->commit();
            sendJson(tripTree($db, freshAccess($db, $trip['uuid'], $userId)));
        }

        if ($action === 'showcase') {
            if ((int) ($user['is_admin'] ?? 0) !== 1) {
                sendError('Only an admin can choose the showcase.', 403, 'forbidden');
            }
            $db->beginTransaction();
            $db->exec('UPDATE trips SET showcase = NULL WHERE showcase = 1');
            if (!empty($body['on'])) {
                $db->prepare('UPDATE trips SET showcase = 1 WHERE id = ?')->execute([$tripId]);
            }
            $db->commit();
            sendJson(['trip' => tripPayload(freshAccess($db, $trip['uuid'], $userId)['trip'], 'owner')]);
        }

        if ($action === 'delete') {
            $rows = TripsService::imageRowsFor($db, 'p.trip_id = ?', [$tripId]);
            $db->beginTransaction();
            TripsService::tombstone($db, 'photo', TripsService::photoUuidsFor($db, 'p.trip_id = ?', [$tripId]));
            $places = $db->prepare('SELECT uuid FROM trips_places WHERE trip_id = ?');
            $places->execute([$tripId]);
            TripsService::tombstone($db, 'place', $places->fetchAll(PDO::FETCH_COLUMN));
            TripsService::tombstone($db, 'trip', [$trip['uuid']]);
            TripsService::deleteImageRows($db, $rows);
            $db->prepare('DELETE FROM trips WHERE id = ?')->execute([$tripId]);
            $db->commit();
            TripsService::removeFiles($rows);
            sendJson(['ok' => true]);
        }

        sendError('Unsupported action.', 400, 'invalid');
    }

    // ---- the invite link (the owner) ------------------------------------
    if ($resource === 'invite' && $method === 'POST') {
        $db = Database::write();
        jsonBody();
        $access = tripAccess($db, (string) $uuid, $userId);
        if ($access === null || $access['role'] === 'viewer') notFound();
        requireOwner($access);
        $tripId = (int) $access['trip']['id'];

        if ($action === 'reset') {
            // Shown once and never stored: only the hash lives here, so a dump
            // of this table is not a set of working links into people's albums.
            $token = bin2hex(random_bytes(16));
            $db->prepare('UPDATE trips SET token_hash = ? WHERE id = ?')->execute([hash('sha256', $token), $tripId]);
            sendJson(['token' => $token]);
        }
        if ($action === 'disable') {
            $db->prepare('UPDATE trips SET token_hash = NULL WHERE id = ?')->execute([$tripId]);
            sendJson(['ok' => true]);
        }
        sendError('Unsupported action.', 400, 'invalid');
    }

    if ($resource === 'join' && $method === 'POST') {
        $db = Database::write();
        $token = strtolower((string) (jsonBody()['token'] ?? ''));
        if (!preg_match('/^[0-9a-f]{32}$/', $token)) notFound();
        $find = $db->prepare('SELECT uuid FROM trips WHERE token_hash = ? LIMIT 1');
        $find->execute([hash('sha256', $token)]);
        $tripUuid = $find->fetchColumn();
        if (!$tripUuid) notFound();

        $access = tripAccess($db, (string) $tripUuid, $userId);
        if ($access !== null && $access['role'] !== 'viewer') {
            sendJson(['trip' => tripPayload($access['trip'], $access['role'])]);
        }
        $tripRow = $db->prepare('SELECT id FROM trips WHERE uuid = ?');
        $tripRow->execute([$tripUuid]);
        $tripId = (int) $tripRow->fetchColumn();
        $n = $db->prepare('SELECT COUNT(*) FROM trips_members WHERE trip_id = ?');
        $n->execute([$tripId]);
        if ((int) $n->fetchColumn() >= MAX_MEMBERS) {
            sendError('This trip already has ' . MAX_MEMBERS . ' travellers.', 409, 'full');
        }
        $db->prepare('INSERT IGNORE INTO trips_members (trip_id, user_id) VALUES (?, ?)')->execute([$tripId, $userId]);
        bumpVersion($db, $tripId);
        sendJson(['trip' => tripPayload(freshAccess($db, (string) $tripUuid, $userId)['trip'], 'traveller')]);
    }

    if ($resource === 'member' && $method === 'POST') {
        $db = Database::write();
        $body = jsonBody();
        $access = tripAccess($db, (string) $uuid, $userId);
        if ($access === null || $access['role'] === 'viewer') notFound();
        $tripId = (int) $access['trip']['id'];

        if ($action === 'leave') {
            if ($access['role'] !== 'traveller') {
                sendError('The owner cannot leave their own trip.', 403, 'forbidden');
            }
            $db->prepare('DELETE FROM trips_members WHERE trip_id = ? AND user_id = ?')->execute([$tripId, $userId]);
            bumpVersion($db, $tripId);
            sendJson(['ok' => true]);
        }
        if ($action === 'remove') {
            requireOwner($access);
            $db->prepare('DELETE FROM trips_members WHERE trip_id = ? AND user_id = ?')
                ->execute([$tripId, (int) ($body['user_id'] ?? 0)]);
            // Otherwise the person removed could simply follow the link again.
            if (($body['reset_link'] ?? true) !== false) {
                $db->prepare('UPDATE trips SET token_hash = NULL WHERE id = ?')->execute([$tripId]);
            }
            bumpVersion($db, $tripId);
            sendJson(tripTree($db, freshAccess($db, $access['trip']['uuid'], $userId)));
        }
        sendError('Unsupported action.', 400, 'invalid');
    }

    // ---- changing a place ---------------------------------------------------
    if ($resource === 'place' && $method === 'POST' && $action !== '') {
        $db = Database::write();
        $body = jsonBody();
        $access = placeAccess($db, (string) $uuid, $userId);
        if ($access === null || $access['role'] === 'viewer') notFound();
        $place = $access['place'];
        $tripId = (int) $access['trip']['id'];
        $mine = $place['created_by'] !== null && (int) $place['created_by'] === $userId;

        if ($action === 'update') {
            if ($access['role'] !== 'owner' && !$mine) {
                sendError('Only the owner or whoever added it can rename this place.', 403, 'forbidden');
            }
            $name = cleanName($body['name'] ?? '');
            if ($name === '') sendError('A place needs a name.', 422, 'invalid');
            $db->prepare('UPDATE trips_places SET name = ? WHERE id = ?')->execute([$name, (int) $place['id']]);
            bumpVersion($db, $tripId);
            sendJson(['place' => placePayload(placeAccess($db, $place['uuid'], $userId)['place'])]);
        }

        if ($action === 'delete') {
            requireOwner($access);
            $placeId = (int) $place['id'];
            $rows = TripsService::imageRowsFor($db, 'p.place_id = ?', [$placeId]);
            $photoUuids = TripsService::photoUuidsFor($db, 'p.place_id = ?', [$placeId]);
            $db->beginTransaction();
            TripsService::tombstone($db, 'photo', $photoUuids);
            TripsService::tombstone($db, 'place', [$place['uuid']]);
            TripsService::deleteImageRows($db, $rows);
            $db->prepare('DELETE FROM trips_places WHERE id = ?')->execute([$placeId]);
            clearCover($db, $tripId, $photoUuids);
            bumpVersion($db, $tripId);
            $db->commit();
            TripsService::removeFiles($rows);
            sendJson(['ok' => true]);
        }
        sendError('Unsupported action.', 400, 'invalid');
    }

    // ---- changing a photo ---------------------------------------------------
    if ($resource === 'photo' && $method === 'POST' && $action !== '') {
        $db = Database::write();
        $body = jsonBody();
        $access = photoAccess($db, (string) $uuid, $userId);
        if ($access === null || $access['role'] === 'viewer') notFound();
        $photo = $access['photo'];
        $tripId = (int) $access['trip']['id'];
        $mine = $photo['uploaded_by'] !== null && (int) $photo['uploaded_by'] === $userId;
        if ($access['role'] !== 'owner' && !$mine) {
            sendError('Only the owner or whoever added it can change this photo.', 403, 'forbidden');
        }

        if ($action === 'update') {
            $caption = array_key_exists('caption', $body)
                ? mb_substr(trim((string) $body['caption']), 0, MAX_CAPTION_LEN)
                : $photo['caption'];
            $lat = (float) $photo['lat'];
            $lon = (float) $photo['lon'];
            $source = $photo['loc_source'];
            if (array_key_exists('lat', $body) || array_key_exists('lon', $body)) {
                $at = cleanLatLon($body['lat'] ?? null, $body['lon'] ?? null);
                if ($at === null) sendError('That position is not on the globe.', 422, 'invalid');
                [$lat, $lon] = $at;
                $source = 'manual';
            }
            $db->prepare('UPDATE trips_photos SET caption = ?, lat = ?, lon = ?, loc_source = ? WHERE id = ?')
                ->execute([$caption, $lat, $lon, $source, (int) $photo['id']]);
            bumpVersion($db, $tripId);
            sendJson(['photo' => photoPayload(photoAccess($db, $photo['uuid'], $userId)['photo'])]);
        }

        if ($action === 'delete') {
            $rows = TripsService::imageRowsFor($db, 'p.id = ?', [(int) $photo['id']]);
            $db->beginTransaction();
            TripsService::tombstone($db, 'photo', [$photo['uuid']]);
            TripsService::deleteImageRows($db, $rows);
            clearCover($db, $tripId, [$photo['uuid']]);
            bumpVersion($db, $tripId);
            $db->commit();
            TripsService::removeFiles($rows);
            sendJson(['ok' => true]);
        }
        sendError('Unsupported action.', 400, 'invalid');
    }

    // ---- photos ------------------------------------------------------
    if ($resource === 'photo' && $method === 'POST' && $action === '') {
        $db = Database::write();
        // Past post_max_size PHP drops the whole body without a word.
        if (empty($_FILES) && empty($_POST) && (int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > iniBytes('post_max_size')) {
            sendError('That photo is too large to send.', 413, 'too_large');
        }
        $newUuid = $_POST['uuid'] ?? null;
        $placeUuid = (string) ($_POST['place'] ?? '');
        $at = cleanLatLon($_POST['lat'] ?? null, $_POST['lon'] ?? null);
        $source = $_POST['loc_source'] ?? null;
        $takenAt = trim((string) ($_POST['taken_at'] ?? ''));
        $offset = $_POST['taken_offset_min'] ?? '';
        $caption = mb_substr(trim((string) ($_POST['caption'] ?? '')), 0, MAX_CAPTION_LEN);
        $file = $_FILES['photo'] ?? null;

        if (is_array($file) && in_array($file['error'] ?? null, [UPLOAD_ERR_INI_SIZE, UPLOAD_ERR_FORM_SIZE], true)) {
            sendError('That photo is too large to send.', 413, 'too_large');
        }
        $validTime = $takenAt === '' || preg_match('/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/', $takenAt);
        $validOffset = $offset === '' || (preg_match('/^-?\d{1,3}$/', (string) $offset) && abs((int) $offset) <= 840);
        if (!isUuid($newUuid) || !isUuid($placeUuid) || $at === null || !in_array($source, LOC_SOURCES, true)
            || !$validTime || !$validOffset || !is_array($file) || ($file['error'] ?? null) !== UPLOAD_ERR_OK
            || !is_uploaded_file($file['tmp_name'])) {
            sendError('A photo needs a uuid, a place, a position, its source and the file.', 422, 'invalid');
        }

        if (isTombstoned($db, $newUuid)) {
            sendError('That photo was deleted.', 410, 'gone');
        }
        // A replay answers before any image work: the outbox retries until it
        // hears back, and the second try must not store a second copy.
        $existing = photoAccess($db, $newUuid, $userId);
        if ($existing !== null && $existing['role'] !== 'viewer') {
            if ($existing['photo']['place_uuid'] !== $placeUuid) {
                sendError('That id is already in use.', 409, 'conflict');
            }
            sendJson(['photo' => photoPayload($existing['photo'])], 200);
        }
        $taken = $db->prepare('SELECT 1 FROM trips_photos WHERE uuid = ?');
        $taken->execute([$newUuid]);
        if ($taken->fetchColumn()) {
            sendError('That id is already in use.', 409, 'conflict');
        }

        $access = placeAccess($db, $placeUuid, $userId);
        if ($access === null) {
            if (isTombstoned($db, $placeUuid)) sendError('That place was deleted.', 410, 'place_gone');
            notFound();
        }
        requireMember($access);
        $tripId = (int) $access['trip']['id'];
        $placeId = (int) $access['place']['id'];

        $count = $db->prepare('SELECT COUNT(*) FROM trips_photos WHERE trip_id = ?');
        $count->execute([$tripId]);
        if ((int) $count->fetchColumn() >= MAX_PHOTOS_PER_TRIP) {
            sendError('A trip can hold ' . MAX_PHOTOS_PER_TRIP . ' photos.', 409, 'full');
        }

        $size = (int) filesize($file['tmp_name']);
        if (usageBytes($db, $userId) + $size > quotaBytes()) {
            sendError('Your photo storage is full.', 507, 'quota');
        }
        $free = function_exists('disk_free_space') ? @disk_free_space(__DIR__) : false;
        if ($free !== false && $free < MIN_FREE_DISK) {
            sendError('The server is out of room for photos.', 507, 'quota');
        }

        // Dimensions before GD ever decodes it: an oversized image would run
        // GD out of memory with a fatal no catch can turn into JSON.
        $info = @getimagesize($file['tmp_name']);
        $long = $info ? max($info[0], $info[1]) : 0;
        if ($info === false || !in_array($info['mime'] ?? '', ['image/jpeg', 'image/png'], true)
            || $long > MAX_EDGE || min($info[0], $info[1]) < 64) {
            sendError('That file is not a photo this app can store.', 422, 'bad_image');
        }

        $raw = (string) file_get_contents($file['tmp_name']);
        try {
            $display = ImageService::prepare($raw, ['size' => 'original', 'format' => 'jpeg', 'quality' => 85]);
            $thumb = ImageService::prepare($raw, ['size' => 'grid', 'format' => 'jpeg', 'quality' => 80]);
        } catch (InvalidArgumentException | RuntimeException) {
            // Corrupt or CMYK: permanent, so a 422 the outbox will not retry.
            sendError('That file is not a photo this app can store.', 422, 'bad_image');
        }
        unset($raw);

        ImageService::protectFolder(PHOTO_FOLDER);
        $files = [];
        try {
            $files[] = $storedDisplay = ImageService::store($display, PHOTO_FOLDER);
            $files[] = $storedThumb = ImageService::store($thumb, PHOTO_FOLDER);

            $db->beginTransaction();
            $insertImage = $db->prepare('INSERT INTO images (uuid, folder, original_name, mime_type, width, height, file_size)
                VALUES (?, ?, NULL, ?, ?, ?, ?)');
            $ids = [];
            foreach ([$storedDisplay, $storedThumb] as $f) {
                $insertImage->execute([$f['uuid'], $f['folder'], $f['mime'], $f['width'], $f['height'], $f['file_size']]);
                $ids[] = (int) $db->lastInsertId();
            }
            $db->prepare('INSERT INTO trips_photos
                    (uuid, trip_id, place_id, uploaded_by, image_id, thumb_image_id, lat, lon, loc_source,
                     taken_at, taken_offset_min, caption)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
                ->execute([$newUuid, $tripId, $placeId, $userId, $ids[0], $ids[1], $at[0], $at[1], $source,
                    $takenAt === '' ? null : $takenAt, $offset === '' ? null : (int) $offset, $caption]);
            bumpVersion($db, $tripId);
            $db->commit();
        } catch (\Throwable $e) {
            if ($db->inTransaction()) $db->rollBack();
            foreach ($files as $f) {
                try { ImageService::remove($f['uuid'], $f['folder'], $f['mime']); } catch (\Throwable) { /* already gone */ }
            }
            // Two replays racing: the other one won, so answer with its row.
            if ($e instanceof PDOException && $e->getCode() === '23000') {
                $winner = photoAccess($db, $newUuid, $userId);
                if ($winner !== null) sendJson(['photo' => photoPayload($winner['photo'])], 200);
            }
            throw $e;
        }

        $created = photoAccess($db, $newUuid, $userId);
        sendJson(['photo' => photoPayload($created['photo'])], 201);
    }

    sendError('Unknown resource.', 404, 'not_found');
} catch (\Throwable $e) {
    if (isset($db) && $db instanceof PDO && $db->inTransaction()) {
        $db->rollBack();
    }
    error_log('trips-controller: ' . $e->getMessage());
    sendError($GLOBALS['DEV_MODE'] ? $e->getMessage() : 'Server error.', 500, 'server');
}
