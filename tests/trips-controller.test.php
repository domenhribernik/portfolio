<?php
declare(strict_types=1);

// Integration tests for trips-controller.php (views/trips).
//
// What matters most, in order:
//
//   1. A trip is private to its owner and travellers. Anyone else gets a 404
//      that is indistinguishable from "no such trip", and that includes the
//      photo bytes: the files are served only through the controller.
//   2. Every create is idempotent by its client-minted uuid. The phone's
//      offline outbox retries until it hears back, so a retry must return the
//      same row and never store a second copy of a photo.
//   3. A deleted thing stays deleted. A queued create for a deleted uuid gets
//      410, not a resurrection.
//
// Runs ONLY against the local scratch DB (127.0.0.1/portfolio): the DB_* env
// overrides below make database.php skip loading app/.env, which points at
// the remote production database. Never run these against prod.
//
// Requires the seeded test users in the local DB:
//   admin@test.local  session token = 64 x 'a'
//   guest@test.local  session token = 64 x 'b'
// and creates a third, tripstest-c@test.local (token 64 x 'c'), itself.
//
// Run: /opt/lampp/bin/php tests/trips-controller.test.php

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit('CLI only');
}

const DB_DSN   = 'mysql:host=127.0.0.1;port=3306;dbname=portfolio;charset=utf8mb4';
const DB_USER  = 'portfolio_dev';
const DB_PASS  = 'R2miswz1pNKOxdl4';
const PHP_BIN  = '/opt/lampp/bin/php';
const DOC_ROOT = __DIR__ . '/..';
const HOST     = '127.0.0.1';
const PORT     = 8968;
const API      = 'http://' . HOST . ':' . PORT . '/app/controllers/trips-controller.php';
const UPLOADS  = __DIR__ . '/../assets/uploads/trips';

$ADMIN_SID = str_repeat('a', 64);
$GUEST_SID = str_repeat('b', 64);
$C_SID     = str_repeat('c', 64);

// ------------------------------------------------------------------
//  Tiny assertion runner
// ------------------------------------------------------------------

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

/**
 * One HTTP call. Writes carry the client header unless told otherwise, and a
 * body is JSON unless it is passed as ['multipart' => [...]].
 *
 * @return array{status:int, body:mixed, raw:string, headers:array}
 */
function request(string $method, string $url, ?string $sid = null, ?array $body = null, array $opts = []): array
{
    $headers = [];
    if ($sid !== null) {
        $headers[] = 'Cookie: portfolio_sid=' . $sid;
    }
    if ($method !== 'GET' && ($opts['clientHeader'] ?? true)) {
        $headers[] = 'X-Trips-Client: 1';
    }
    if (isset($opts['origin'])) {
        $headers[] = 'Origin: ' . $opts['origin'];
    }
    $http = ['method' => $method, 'ignore_errors' => true, 'timeout' => 20];
    if ($body !== null && isset($body['multipart'])) {
        $boundary = '----trips' . bin2hex(random_bytes(8));
        $headers[] = 'Content-Type: multipart/form-data; boundary=' . $boundary;
        $http['content'] = multipartBody($boundary, $body['multipart']);
    } elseif ($body !== null) {
        $headers[] = 'Content-Type: ' . ($opts['contentType'] ?? 'application/json');
        $http['content'] = json_encode($body);
    }
    $http['header'] = implode("\r\n", $headers);
    $raw = file_get_contents($url, false, stream_context_create(['http' => $http]));
    $status = 0;
    $seen = $http_response_header ?? [];
    foreach ($seen as $h) {
        if (preg_match('#^HTTP/\S+\s+(\d{3})#', $h, $m)) {
            $status = (int) $m[1];
        }
    }
    $raw = $raw === false ? '' : $raw;
    return ['status' => $status, 'body' => json_decode($raw, true), 'raw' => $raw, 'headers' => $seen];
}

/** Fields are strings; a file is ['file' => bytes, 'name' => ..., 'type' => ...]. */
function multipartBody(string $boundary, array $fields): string
{
    $out = '';
    foreach ($fields as $name => $value) {
        $out .= "--$boundary\r\n";
        if (is_array($value)) {
            $out .= "Content-Disposition: form-data; name=\"$name\"; filename=\"{$value['name']}\"\r\n";
            $out .= "Content-Type: {$value['type']}\r\n\r\n{$value['file']}\r\n";
        } else {
            $out .= "Content-Disposition: form-data; name=\"$name\"\r\n\r\n$value\r\n";
        }
    }
    return $out . "--$boundary--\r\n";
}

function header_value(array $headers, string $name): ?string
{
    foreach ($headers as $h) {
        if (stripos($h, $name . ':') === 0) {
            return trim(substr($h, strlen($name) + 1));
        }
    }
    return null;
}

/** Test uuids share a prefix so teardown can find every tombstone this run made. */
function tuuid(int $n): string
{
    return sprintf('7e570000-0000-4000-8000-%012d', $n);
}

// ------------------------------------------------------------------
//  Fixtures
// ------------------------------------------------------------------

$pdo = new PDO(DB_DSN, DB_USER, DB_PASS, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);

// The schema under test is the real model file, not a copy of it.
$sql = preg_replace('/^\s*--.*$/m', '', file_get_contents(__DIR__ . '/../app/models/trips-model.sql'));
foreach (array_filter(array_map('trim', explode(';', $sql))) as $statement) {
    $pdo->exec($statement);
}

$adminId = (int) $pdo->query("SELECT id FROM users WHERE email = 'admin@test.local'")->fetchColumn();
$guestId = (int) $pdo->query("SELECT id FROM users WHERE email = 'guest@test.local'")->fetchColumn();
if ($adminId === 0 || $guestId === 0) {
    fwrite(STDERR, "Missing seeded test users in local DB\n");
    exit(1);
}

$imageBaseline = (int) $pdo->query('SELECT COALESCE(MAX(id), 0) FROM images')->fetchColumn();

function teardown(PDO $pdo, int $imageBaseline): void
{
    $pdo->exec("DELETE t FROM trips t JOIN users u ON u.id = t.owner_id
        WHERE u.email IN ('admin@test.local', 'guest@test.local', 'tripstest-c@test.local')");
    $pdo->exec("DELETE FROM trips_tombstones WHERE uuid LIKE '7e570000-%'");
    $stmt = $pdo->prepare("SELECT id, uuid, mime_type FROM images WHERE folder = 'trips' AND id > ?");
    $stmt->execute([$imageBaseline]);
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $img) {
        @unlink(UPLOADS . '/' . $img['uuid'] . '.jpg');
        $pdo->prepare('DELETE FROM images WHERE id = ?')->execute([(int) $img['id']]);
    }
    $pdo->exec("DELETE FROM users WHERE email = 'tripstest-c@test.local'");
}

teardown($pdo, $imageBaseline); // leftovers from a crashed run

$pdo->exec("INSERT INTO users (email, display_name, is_active) VALUES ('tripstest-c@test.local', 'Traveller C', 1)");
$cId = (int) $pdo->lastInsertId();
$pdo->prepare('INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 1 DAY))')
    ->execute([$cId, hash('sha256', $C_SID)]);

$server = proc_open(
    [PHP_BIN, '-d', 'variables_order=EGPCS', '-S', HOST . ':' . PORT, '-t', DOC_ROOT],
    [1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']],
    $pipes,
    DOC_ROOT,
    [
        'DB_HOST'           => '127.0.0.1',
        'DB_PORT'           => '3306',
        'DB_NAME'           => 'portfolio',
        'DB_USER_W'         => DB_USER,
        'DB_PASS_W'         => DB_PASS,
        'DB_USER_R'         => DB_USER,
        'DB_PASS_R'         => DB_PASS,
        // Small enough for the quota section to hit with a handful of photos.
        'TRIPS_QUOTA_BYTES' => '400000',
        'PATH'              => getenv('PATH') ?: '/usr/bin:/bin',
    ]
);

register_shutdown_function(function () use ($server, $pdo, $imageBaseline) {
    if (is_resource($server)) {
        proc_terminate($server);
    }
    teardown($pdo, $imageBaseline);
});

for ($i = 0; $i < 50; $i++) {
    $probe = @fsockopen(HOST, PORT, $errno, $errstr, 0.2);
    if ($probe) { fclose($probe); break; }
    usleep(100000);
}

$TRIP_A = tuuid(1);

// ------------------------------------------------------------------
echo "\nTransport and gates\n";
// ------------------------------------------------------------------

$r = request('GET', API . '?resource=session');
check('session is public', $r['status'] === 200 && array_key_exists('viewer', $r['body'] ?? []), "status {$r['status']}");
check('signed-out viewer is null', array_key_exists('viewer', $r['body'] ?? []) && $r['body']['viewer'] === null);
check('responses are no-store', header_value($r['headers'], 'Cache-Control') === 'no-store');
check('no wildcard CORS', header_value($r['headers'], 'Access-Control-Allow-Origin') === null);
check('session reports upload limits',
    is_int($r['body']['limits']['max_upload_bytes'] ?? null) && ($r['body']['limits']['max_edge'] ?? 0) >= 2048);

$r = request('GET', API . '?resource=session', $ADMIN_SID);
check('signed-in viewer is reported', ($r['body']['viewer']['id'] ?? 0) === $adminId);

$r = request('GET', API . '?resource=trips');
check('trip list needs an account', $r['status'] === 401, "status {$r['status']}");

$r = request('POST', API . '?resource=trip', null, ['uuid' => $TRIP_A, 'name' => 'Slovenia']);
check('creating needs an account', $r['status'] === 401, "status {$r['status']}");

// ------------------------------------------------------------------
echo "\nCSRF backstops\n";
// ------------------------------------------------------------------

$r = request('POST', API . '?resource=trip', $ADMIN_SID, ['uuid' => $TRIP_A, 'name' => 'Slovenia'], ['clientHeader' => false]);
check('a write without the client header is refused', $r['status'] === 403 && ($r['body']['code'] ?? '') === 'client_header', "status {$r['status']}");

$r = request('POST', API . '?resource=trip', $ADMIN_SID, ['uuid' => $TRIP_A, 'name' => 'Slovenia'], ['contentType' => 'text/plain']);
check('a JSON route refuses other content types', $r['status'] === 415, "status {$r['status']}");

$r = request('POST', API . '?resource=trip', $ADMIN_SID, ['uuid' => $TRIP_A, 'name' => 'Slovenia'], ['origin' => 'https://evil.example']);
check('a foreign Origin is refused', $r['status'] === 403, "status {$r['status']}");

$count = (int) $pdo->query("SELECT COUNT(*) FROM trips WHERE uuid = '$TRIP_A'")->fetchColumn();
check('none of the refused writes created anything', $count === 0);

// ------------------------------------------------------------------
echo "\nCreating a trip\n";
// ------------------------------------------------------------------

$r = request('POST', API . '?resource=trip', $ADMIN_SID, ['uuid' => 'not-a-uuid', 'name' => 'Slovenia']);
check('a malformed uuid is invalid', $r['status'] === 422 && ($r['body']['code'] ?? '') === 'invalid', "status {$r['status']}");

$r = request('POST', API . '?resource=trip', $ADMIN_SID, ['uuid' => $TRIP_A, 'name' => '   ']);
check('a blank name is invalid', $r['status'] === 422, "status {$r['status']}");

$r = request('POST', API . '?resource=trip', $ADMIN_SID, ['uuid' => $TRIP_A, 'name' => 'Slovenia', 'line' => 'blue']);
check('a new trip is 201', $r['status'] === 201, "status {$r['status']} {$r['raw']}");
$created = $r['body']['trip'] ?? [];
check('the owner is told they own it', ($created['role'] ?? '') === 'owner');
check('the chosen line colour is kept', ($created['line'] ?? '') === 'blue');

$r = request('POST', API . '?resource=trip', $ADMIN_SID, ['uuid' => $TRIP_A, 'name' => 'Slovenia', 'line' => 'blue']);
check('replaying the same create is 200', $r['status'] === 200, "status {$r['status']}");
check('the replay returns the same trip', ($r['body']['trip'] ?? null) == $created);
$count = (int) $pdo->query("SELECT COUNT(*) FROM trips WHERE uuid = '$TRIP_A'")->fetchColumn();
check('the replay stored nothing new', $count === 1, "rows $count");

$r = request('POST', API . '?resource=trip', $ADMIN_SID, ['uuid' => tuuid(2), 'name' => 'Nowhere', 'line' => 'chartreuse']);
check('an unknown line colour falls back to a real one', $r['status'] === 201 && ($r['body']['trip']['line'] ?? '') === 'red');

$r = request('POST', API . '?resource=trip', $GUEST_SID, ['uuid' => $TRIP_A, 'name' => 'Mine now']);
check('someone else reusing the uuid gets a conflict', $r['status'] === 409 && ($r['body']['code'] ?? '') === 'conflict', "status {$r['status']}");
check('the conflict leaks nothing about the trip', !str_contains($r['raw'], 'Slovenia'));

// ------------------------------------------------------------------
echo "\nA trip is private to its members\n";
// ------------------------------------------------------------------

$r = request('GET', API . '?resource=trips', $ADMIN_SID);
$uuids = array_column($r['body']['trips'] ?? [], 'uuid');
check('the owner sees it in the atlas', in_array($TRIP_A, $uuids, true));
check('the atlas reports storage used', is_int($r['body']['usage']['bytes'] ?? null));

$r = request('GET', API . '?resource=trips', $GUEST_SID);
check('an outsider does not see it in their atlas', !str_contains($r['raw'], $TRIP_A));

$r = request('GET', API . '?resource=trip&uuid=' . $TRIP_A, $ADMIN_SID);
check('the owner can open it', $r['status'] === 200 && ($r['body']['trip']['name'] ?? '') === 'Slovenia', "status {$r['status']}");
check('an open trip lists its places and photos', is_array($r['body']['places'] ?? null) && is_array($r['body']['photos'] ?? null));

$r = request('GET', API . '?resource=trip&uuid=' . $TRIP_A, $GUEST_SID);
check('an outsider gets 404', $r['status'] === 404, "status {$r['status']}");
check('the 404 leaks nothing about the trip', !str_contains($r['raw'], 'Slovenia'));

$r = request('GET', API . '?resource=trip&uuid=' . tuuid(999), $ADMIN_SID);
check('a trip that never existed is the same 404', $r['status'] === 404);

// ------------------------------------------------------------------
echo "\nChaining places\n";
// ------------------------------------------------------------------

$PLACE_1 = tuuid(101);
$PLACE_2 = tuuid(102);
$PLACE_3 = tuuid(103);
$placeBody = fn (string $u, string $name, float $lat, float $lon, string $trip = '') => [
    'uuid' => $u, 'trip' => $trip ?: $TRIP_A, 'name' => $name, 'lat' => $lat, 'lon' => $lon, 'country_code' => 'SI',
];

$r = request('POST', API . '?resource=place', $ADMIN_SID, $placeBody($PLACE_1, 'Ljubljana', 46.0511, 14.5051));
check('a new place is 201', $r['status'] === 201, "status {$r['status']} {$r['raw']}");
check('the first place is position 0', ($r['body']['place']['position'] ?? -1) === 0);
check('the country code is stored lower-case', ($r['body']['place']['country_code'] ?? '') === 'si');
$placeOne = $r['body']['place'] ?? [];

$r = request('POST', API . '?resource=place', $ADMIN_SID, $placeBody($PLACE_1, 'Ljubljana', 46.0511, 14.5051));
check('replaying a place create is 200 with the same place', $r['status'] === 200 && ($r['body']['place'] ?? null) == $placeOne);

request('POST', API . '?resource=place', $ADMIN_SID, $placeBody($PLACE_2, 'Bled', 46.3683, 14.1146));
$r = request('POST', API . '?resource=place', $ADMIN_SID, $placeBody($PLACE_3, 'Piran', 45.5283, 13.5683));
check('each new place goes to the end of the line', ($r['body']['place']['position'] ?? -1) === 2);

$r = request('GET', API . '?resource=trip&uuid=' . $TRIP_A, $ADMIN_SID);
check('the trip lists its places in order', array_column($r['body']['places'] ?? [], 'name') === ['Ljubljana', 'Bled', 'Piran']);
check('a place change bumps the trip version', ($r['body']['trip']['version'] ?? 0) > ($created['version'] ?? 0));

$r = request('POST', API . '?resource=place', $ADMIN_SID, $placeBody(tuuid(104), 'Atlantis', 91.0, 14.0));
check('a latitude past the pole is invalid', $r['status'] === 422 && ($r['body']['code'] ?? '') === 'invalid');

$r = request('POST', API . '?resource=place', $GUEST_SID, $placeBody(tuuid(105), 'Sneaky', 46.0, 14.0));
check('an outsider cannot add a place', $r['status'] === 404 && ($r['body']['code'] ?? '') === 'not_found', "status {$r['status']}");

$r = request('POST', API . '?resource=place', $ADMIN_SID, $placeBody(tuuid(106), 'Orphan', 46.0, 14.0, tuuid(998)));
check('a place for a trip that never existed is 404', $r['status'] === 404);

$r = request('GET', API . '?resource=trips', $ADMIN_SID);
$atlasTrip = array_values(array_filter($r['body']['trips'] ?? [], fn ($t) => $t['uuid'] === $TRIP_A))[0] ?? [];
check('the atlas carries each trip\'s stations', count($atlasTrip['places'] ?? []) === 3);

// ------------------------------------------------------------------
echo "\nPhotos\n";
// ------------------------------------------------------------------

/** A JPEG of the given size; `noise` makes it incompressible. `exif` splices in a GPS APP1. */
function jpeg(int $w, int $h, bool $noise = false, bool $exif = false): string
{
    $im = imagecreatetruecolor($w, $h);
    imagefill($im, 0, 0, imagecolorallocate($im, 40, 120, 160));
    if ($noise) {
        for ($y = 0; $y < $h; $y += 2) {
            for ($x = 0; $x < $w; $x += 2) {
                imagefilledrectangle($im, $x, $y, $x + 1, $y + 1, random_int(0, 0xffffff));
            }
        }
    }
    ob_start();
    imagejpeg($im, null, 92);
    $bytes = ob_get_clean();
    if ($exif) {
        // An APP1 segment carrying "Exif" and a GPS tag marker, right after SOI.
        $payload = "Exif\0\0" . "MM\0\x2a\0\0\0\x08" . str_repeat("\0", 8) . 'GPSLatitude-46.364';
        $bytes = "\xff\xd8\xff\xe1" . pack('n', strlen($payload) + 2) . $payload . substr($bytes, 2);
    }
    return $bytes;
}

$photoFields = fn (string $u, string $place, array $over = []) => array_merge([
    'uuid' => $u, 'place' => $place, 'lat' => '46.3641', 'lon' => '14.1149',
    'loc_source' => 'exif', 'taken_at' => '2026-08-14 14:32:05', 'taken_offset_min' => '120',
    'photo' => ['file' => jpeg(1200, 900, false, true), 'name' => 'IMG_0001.jpg', 'type' => 'image/jpeg'],
], $over);

$PHOTO_1 = tuuid(201);
$r = request('POST', API . '?resource=photo', $ADMIN_SID, ['multipart' => $photoFields($PHOTO_1, $PLACE_2)]);
check('a new photo is 201', $r['status'] === 201, "status {$r['status']} {$r['raw']}");
$photoOne = $r['body']['photo'] ?? [];
check('the photo keeps its position and source', abs(($photoOne['lat'] ?? 0) - 46.3641) < 1e-6 && ($photoOne['loc_source'] ?? '') === 'exif');
check('the photo keeps the camera clock', ($photoOne['taken_at'] ?? '') === '2026-08-14 14:32:05' && ($photoOne['offset_min'] ?? null) === 120);
check('the photo names its place', ($photoOne['place'] ?? '') === $PLACE_2);
check('the photo says who added it', ($photoOne['by'] ?? '') !== '');

$rows = $pdo->query("SELECT i.uuid, i.mime_type, i.width, i.height FROM trips_photos p
    JOIN images i ON i.id IN (p.image_id, p.thumb_image_id) WHERE p.uuid = '$PHOTO_1' ORDER BY i.width DESC")->fetchAll(PDO::FETCH_ASSOC);
check('a photo stores two images', count($rows) === 2, 'rows ' . count($rows));
check('the display copy keeps its size', ($rows[0]['width'] ?? 0) === 1200);
check('the thumb is a 480 square', ($rows[1]['width'] ?? 0) === 480 && ($rows[1]['height'] ?? 0) === 480);
$stored = @file_get_contents(UPLOADS . '/' . ($rows[0]['uuid'] ?? 'x') . '.jpg');
check('both files are on disk', $stored !== false && is_file(UPLOADS . '/' . ($rows[1]['uuid'] ?? 'x') . '.jpg'));
check('the stored file carries no EXIF', $stored !== false && !str_contains($stored, 'Exif') && !str_contains($stored, 'GPSLatitude'));
check('the folder denies direct web access', str_contains((string) @file_get_contents(UPLOADS . '/.htaccess'), 'Require all denied'));
$imagesBefore = (int) $pdo->query("SELECT COUNT(*) FROM images WHERE folder = 'trips' AND id > $imageBaseline")->fetchColumn();

$r = request('POST', API . '?resource=photo', $ADMIN_SID, ['multipart' => $photoFields($PHOTO_1, $PLACE_2)]);
check('replaying an upload is 200 with the same photo', $r['status'] === 200 && ($r['body']['photo'] ?? null) == $photoOne, "status {$r['status']}");
$imagesAfter = (int) $pdo->query("SELECT COUNT(*) FROM images WHERE folder = 'trips' AND id > $imageBaseline")->fetchColumn();
check('the replay stored no second copy', $imagesAfter === $imagesBefore, "$imagesBefore -> $imagesAfter");

$r = request('POST', API . '?resource=photo', $ADMIN_SID, ['multipart' => $photoFields($PHOTO_1, $PLACE_3)]);
check('the same photo uuid under another place is a conflict', $r['status'] === 409);

$r = request('GET', API . '?resource=photo&size=thumb&uuid=' . $PHOTO_1, $ADMIN_SID);
check('the owner gets the thumb bytes', $r['status'] === 200 && str_starts_with($r['raw'], "\xff\xd8"), "status {$r['status']}");
check('the bytes are JPEG', header_value($r['headers'], 'Content-Type') === 'image/jpeg');
$cc = (string) header_value($r['headers'], 'Cache-Control');
check('the bytes cache privately and forever', str_contains($cc, 'private') && str_contains($cc, 'immutable'), $cc);
check('the bytes forbid sniffing', header_value($r['headers'], 'X-Content-Type-Options') === 'nosniff');

$r = request('GET', API . '?resource=photo&size=display&uuid=' . $PHOTO_1, $ADMIN_SID);
check('the owner gets the display bytes', $r['status'] === 200 && strlen($r['raw']) > 1000);

$r = request('GET', API . '?resource=photo&size=thumb&uuid=' . $PHOTO_1, $GUEST_SID);
check('an outsider gets 404 for the bytes', $r['status'] === 404);
$r = request('GET', API . '?resource=photo&size=thumb&uuid=' . $PHOTO_1);
check('signed out gets 404 for the bytes', $r['status'] === 404);

$r = request('GET', API . '?resource=trip&uuid=' . $TRIP_A, $ADMIN_SID);
check('the trip lists its photos', in_array($PHOTO_1, array_column($r['body']['photos'] ?? [], 'uuid'), true));

$r = request('GET', API . '?resource=trips', $ADMIN_SID);
$atlasTrip = array_values(array_filter($r['body']['trips'] ?? [], fn ($t) => $t['uuid'] === $TRIP_A))[0] ?? [];
check('the atlas counts the photos', ($atlasTrip['photo_count'] ?? 0) === 1);
check('the atlas counts storage used', ($r['body']['usage']['bytes'] ?? 0) > 0);

$r = request('POST', API . '?resource=photo', $GUEST_SID, ['multipart' => $photoFields(tuuid(202), $PLACE_2)]);
check('an outsider cannot add a photo', $r['status'] === 404, "status {$r['status']}");

$r = request('POST', API . '?resource=photo', $ADMIN_SID, ['multipart' => $photoFields(tuuid(203), $PLACE_2, [
    'photo' => ['file' => 'this is not an image', 'name' => 'x.jpg', 'type' => 'image/jpeg'],
])]);
check('a file that is not an image is 422', $r['status'] === 422 && ($r['body']['code'] ?? '') === 'bad_image', "status {$r['status']}");

$r = request('POST', API . '?resource=photo', $ADMIN_SID, ['multipart' => $photoFields(tuuid(204), $PLACE_2, [
    'photo' => ['file' => jpeg(3000, 100), 'name' => 'x.jpg', 'type' => 'image/jpeg'],
])]);
check('a photo past the size the app sends is 422', $r['status'] === 422 && ($r['body']['code'] ?? '') === 'bad_image');

$r = request('POST', API . '?resource=photo', $ADMIN_SID, ['multipart' => $photoFields(tuuid(205), $PLACE_2, ['loc_source' => 'guess'])]);
check('an unknown location source is invalid', $r['status'] === 422 && ($r['body']['code'] ?? '') === 'invalid');

$r = request('POST', API . '?resource=photo', $ADMIN_SID, ['multipart' => $photoFields(tuuid(206), $PLACE_2, ['lat' => '123'])]);
check('a photo off the globe is invalid', $r['status'] === 422);

$r = request('POST', API . '?resource=photo', $ADMIN_SID, ['multipart' => array_diff_key($photoFields(tuuid(207), $PLACE_2), ['photo' => 1])]);
check('a photo with no file is invalid', $r['status'] === 422);

$r = request('POST', API . '?resource=photo', $ADMIN_SID, ['multipart' => $photoFields(tuuid(208), tuuid(997))]);
check('a photo for a place that never existed is 404', $r['status'] === 404);

$r = request('POST', API . '?resource=photo', $ADMIN_SID, ['multipart' => $photoFields(tuuid(209), $PLACE_2, [
    'photo' => ['file' => jpeg(900, 900, true), 'name' => 'big.jpg', 'type' => 'image/jpeg'],
])]);
check('a photo past the remaining quota is 507', $r['status'] === 507 && ($r['body']['code'] ?? '') === 'quota', "status {$r['status']}");

$r = request('POST', API . '?resource=photo', $ADMIN_SID, ['multipart' => $photoFields(tuuid(210), $PLACE_2)], ['clientHeader' => false]);
check('an upload without the client header is refused', $r['status'] === 403);

// The shared images endpoint is public and used to list every stored file.
$IMAGES = 'http://' . HOST . ':' . PORT . '/app/controllers/images-controller.php';
$storedUuid = $rows[0]['uuid'] ?? 'x';
$r = request('GET', $IMAGES);
check('the public image list leaves trip photos out', !str_contains($r['raw'], $storedUuid) && !str_contains($r['raw'], '"trips"'));
$r = request('GET', $IMAGES . '?folder=trips');
check('listing the trips folder shows nothing', $r['status'] === 200 && $r['body'] === []);
$r = request('GET', $IMAGES . '?uuid=' . $storedUuid);
check('a trip photo is not found through the images endpoint', $r['status'] === 404);
$r = request('DELETE', $IMAGES . '?uuid=' . $storedUuid, $ADMIN_SID);
check('the images endpoint cannot delete half of a photo', $r['status'] === 404 && is_file(UPLOADS . '/' . $storedUuid . '.jpg'), "status {$r['status']}");

// The DELETE through the images endpoint above was refused, so the photo is
// intact; upload a small second one by the owner for the role tests.
$PHOTO_OWNER = tuuid(211);
request('POST', API . '?resource=photo', $ADMIN_SID, ['multipart' => $photoFields($PHOTO_OWNER, $PLACE_2, [
    'photo' => ['file' => jpeg(300, 200), 'name' => 'b.jpg', 'type' => 'image/jpeg'],
])]);

// ------------------------------------------------------------------
echo "\nInvite links and travellers\n";
// ------------------------------------------------------------------

$r = request('POST', API . '?resource=invite&action=reset&uuid=' . $TRIP_A, $ADMIN_SID, []);
$token = $r['body']['token'] ?? '';
check('the owner gets an invite token once', $r['status'] === 200 && preg_match('/^[0-9a-f]{32}$/', $token) === 1, "status {$r['status']}");
$stored = $pdo->query("SELECT token_hash FROM trips WHERE uuid = '$TRIP_A'")->fetchColumn();
check('only the token\'s hash is stored', $stored === hash('sha256', $token));

$r = request('GET', API . '?resource=invite&t=' . $token);
check('anyone with the link sees what they are joining', $r['status'] === 200
    && ($r['body']['invite']['name'] ?? '') === 'Slovenia' && ($r['body']['invite']['place_count'] ?? 0) === 3, "status {$r['status']}");
check('the preview carries no places or photos', !isset($r['body']['places']) && !str_contains($r['raw'], 'Ljubljana'));
$r = request('GET', API . '?resource=invite&t=' . str_repeat('0', 32));
check('a wrong token is 404', $r['status'] === 404);

$r = request('POST', API . '?resource=join', $GUEST_SID, ['token' => $token]);
check('a signed-in person joins with the token', $r['status'] === 200 && ($r['body']['trip']['role'] ?? '') === 'traveller', "status {$r['status']} {$r['raw']}");
$r = request('POST', API . '?resource=join', $GUEST_SID, ['token' => $token]);
check('joining twice is the same answer', $r['status'] === 200 && ($r['body']['trip']['role'] ?? '') === 'traveller');
$r = request('POST', API . '?resource=join', $ADMIN_SID, ['token' => $token]);
check('the owner following their own link stays the owner', ($r['body']['trip']['role'] ?? '') === 'owner');
$r = request('POST', API . '?resource=join', null, ['token' => $token]);
check('joining needs an account', $r['status'] === 401);

$r = request('GET', API . '?resource=trip&uuid=' . $TRIP_A, $GUEST_SID);
check('the traveller can open the trip', $r['status'] === 200 && ($r['body']['trip']['role'] ?? '') === 'traveller');
$members = $r['body']['members'] ?? [];
check('members see who is on the trip', count($members) === 2 && in_array('owner', array_column($members, 'role'), true));
$r = request('GET', API . '?resource=photo&size=thumb&uuid=' . $PHOTO_1, $GUEST_SID);
check('the traveller can see the photos', $r['status'] === 200);

$PHOTO_GUEST = tuuid(212);
$r = request('POST', API . '?resource=photo', $GUEST_SID, ['multipart' => $photoFields($PHOTO_GUEST, $PLACE_2, [
    'loc_source' => 'device',
    'photo' => ['file' => jpeg(300, 200), 'name' => 'g.jpg', 'type' => 'image/jpeg'],
])]);
check('a traveller adds a photo', $r['status'] === 201, "status {$r['status']}");
$GUEST_PLACE = tuuid(107);
$r = request('POST', API . '?resource=place', $GUEST_SID, $placeBody($GUEST_PLACE, 'Vintgar', 46.3931, 14.0853));
check('a traveller adds a place', $r['status'] === 201);

$r = request('POST', API . '?resource=invite&action=reset&uuid=' . $TRIP_A, $GUEST_SID, []);
check('a traveller cannot make invite links', $r['status'] === 403 && ($r['body']['code'] ?? '') === 'forbidden', "status {$r['status']}");

// ------------------------------------------------------------------
echo "\nEditing\n";
// ------------------------------------------------------------------

$r = request('POST', API . '?resource=trip&action=update&uuid=' . $TRIP_A, $ADMIN_SID, ['name' => 'Slovenia, August', 'line' => 'green']);
check('the owner renames the trip and changes its line', ($r['body']['trip']['name'] ?? '') === 'Slovenia, August' && ($r['body']['trip']['line'] ?? '') === 'green');
$r = request('POST', API . '?resource=trip&action=update&uuid=' . $TRIP_A, $GUEST_SID, ['name' => 'Mine']);
check('a traveller cannot rename the trip', $r['status'] === 403);

$r = request('POST', API . '?resource=place&action=update&uuid=' . $GUEST_PLACE, $GUEST_SID, ['name' => 'Vintgar gorge']);
check('a traveller renames a place they added', $r['status'] === 200 && ($r['body']['place']['name'] ?? '') === 'Vintgar gorge');
$r = request('POST', API . '?resource=place&action=update&uuid=' . $PLACE_1, $GUEST_SID, ['name' => 'Lublana']);
check('a traveller cannot rename someone else\'s place', $r['status'] === 403);

$r = request('POST', API . '?resource=photo&action=update&uuid=' . $PHOTO_GUEST, $GUEST_SID, ['caption' => 'The lake', 'lat' => 46.3633, 'lon' => 14.0938]);
check('moving a pin by hand marks it manual', ($r['body']['photo']['loc_source'] ?? '') === 'manual' && ($r['body']['photo']['caption'] ?? '') === 'The lake');
$r = request('POST', API . '?resource=photo&action=update&uuid=' . $PHOTO_1, $GUEST_SID, ['caption' => 'mine now']);
check('a traveller cannot edit someone else\'s photo', $r['status'] === 403);

$r = request('POST', API . '?resource=trip&action=cover&uuid=' . $TRIP_A, $ADMIN_SID, ['photo' => $PHOTO_GUEST]);
check('the owner picks a cover photo from the trip', ($r['body']['trip']['cover_photo_uuid'] ?? '') === $PHOTO_GUEST);
$r = request('POST', API . '?resource=trip&action=cover&uuid=' . $TRIP_A, $ADMIN_SID, ['photo' => tuuid(996)]);
check('a cover must be a photo in this trip', $r['status'] === 422);

$r = request('GET', API . '?resource=trip&uuid=' . $TRIP_A, $ADMIN_SID);
$order = array_column($r['body']['places'] ?? [], 'uuid');
$reversed = array_reverse($order);
$r = request('POST', API . '?resource=trip&action=reorder&uuid=' . $TRIP_A, $ADMIN_SID, ['places' => $reversed]);
check('the owner reorders the line', $r['status'] === 200 && array_column($r['body']['places'] ?? [], 'uuid') === $reversed, "status {$r['status']}");
$r = request('POST', API . '?resource=trip&action=reorder&uuid=' . $TRIP_A, $ADMIN_SID, ['places' => array_slice($order, 1)]);
check('a reorder that is not every place exactly once is stale', $r['status'] === 409 && ($r['body']['code'] ?? '') === 'stale_order');
$r = request('POST', API . '?resource=trip&action=reorder&uuid=' . $TRIP_A, $GUEST_SID, ['places' => $order]);
check('a traveller cannot reorder', $r['status'] === 403);

// ------------------------------------------------------------------
echo "\nDeleting\n";
// ------------------------------------------------------------------

$filesOf = function (string $photoUuid) use ($pdo): array {
    $stmt = $pdo->prepare("SELECT i.uuid FROM trips_photos p JOIN images i ON i.id IN (p.image_id, p.thumb_image_id) WHERE p.uuid = ?");
    $stmt->execute([$photoUuid]);
    return $stmt->fetchAll(PDO::FETCH_COLUMN);
};

$r = request('POST', API . '?resource=photo&action=delete&uuid=' . $PHOTO_1, $GUEST_SID, []);
check('a traveller cannot delete the owner\'s photo', $r['status'] === 403);

$guestFiles = $filesOf($PHOTO_GUEST);
$r = request('POST', API . '?resource=photo&action=delete&uuid=' . $PHOTO_GUEST, $GUEST_SID, []);
check('a traveller deletes their own photo', $r['status'] === 200, "status {$r['status']}");
check('both of its files are gone', count($guestFiles) === 2 && !is_file(UPLOADS . "/{$guestFiles[0]}.jpg") && !is_file(UPLOADS . "/{$guestFiles[1]}.jpg"));
$left = (int) $pdo->query("SELECT COUNT(*) FROM images WHERE uuid IN ('" . implode("','", $guestFiles) . "')")->fetchColumn();
check('both of its image rows are gone', $left === 0);
$r = request('GET', API . '?resource=trip&uuid=' . $TRIP_A, $ADMIN_SID);
check('a deleted cover photo is no cover', array_key_exists('cover_photo_uuid', $r['body']['trip'] ?? []) && $r['body']['trip']['cover_photo_uuid'] === null);

$r = request('POST', API . '?resource=photo', $GUEST_SID, ['multipart' => $photoFields($PHOTO_GUEST, $PLACE_2, [
    'photo' => ['file' => jpeg(300, 200), 'name' => 'g.jpg', 'type' => 'image/jpeg'],
])]);
check('a queued retry of a deleted photo is 410 gone', $r['status'] === 410 && ($r['body']['code'] ?? '') === 'gone', "status {$r['status']}");

$r = request('POST', API . '?resource=place&action=delete&uuid=' . $GUEST_PLACE, $GUEST_SID, []);
check('a traveller cannot delete a place, even their own', $r['status'] === 403);

$ownerFiles = $filesOf($PHOTO_OWNER);
$r = request('POST', API . '?resource=place&action=delete&uuid=' . $PLACE_2, $ADMIN_SID, []);
check('the owner deletes a place', $r['status'] === 200, "status {$r['status']}");
check('its photos\' files go with it', count($ownerFiles) === 2 && !is_file(UPLOADS . "/{$ownerFiles[0]}.jpg"));
$r = request('POST', API . '?resource=photo', $ADMIN_SID, ['multipart' => $photoFields(tuuid(213), $PLACE_2, [
    'photo' => ['file' => jpeg(300, 200), 'name' => 'b.jpg', 'type' => 'image/jpeg'],
])]);
check('a photo queued for a deleted place is 410 place_gone', $r['status'] === 410 && ($r['body']['code'] ?? '') === 'place_gone', "status {$r['status']}");
$r = request('POST', API . '?resource=photo', $ADMIN_SID, ['multipart' => $photoFields($PHOTO_1, $PLACE_2)]);
check('a photo deleted with its place is 410 gone', $r['status'] === 410 && ($r['body']['code'] ?? '') === 'gone');

// ------------------------------------------------------------------
echo "\nRemoving and leaving\n";
// ------------------------------------------------------------------

$r = request('POST', API . '?resource=member&action=remove&uuid=' . $TRIP_A, $ADMIN_SID, ['user_id' => $guestId, 'reset_link' => true]);
check('the owner removes a traveller', $r['status'] === 200, "status {$r['status']}");
$r = request('GET', API . '?resource=trip&uuid=' . $TRIP_A, $GUEST_SID);
check('a removed traveller gets 404', $r['status'] === 404);
$r = request('POST', API . '?resource=join', $GUEST_SID, ['token' => $token]);
check('the old link no longer lets them back in', $r['status'] === 404);
$r = request('GET', API . '?resource=place&uuid=' . $GUEST_PLACE, $ADMIN_SID);
$placeRow = $pdo->query("SELECT created_by FROM trips_places WHERE uuid = '$GUEST_PLACE'")->fetch(PDO::FETCH_ASSOC);
check('the place they added stays on the line', $placeRow !== false);

$r = request('POST', API . '?resource=invite&action=reset&uuid=' . $TRIP_A, $ADMIN_SID, []);
$token2 = $r['body']['token'] ?? '';
request('POST', API . '?resource=join', $GUEST_SID, ['token' => $token2]);
$r = request('POST', API . '?resource=member&action=leave&uuid=' . $TRIP_A, $GUEST_SID, []);
check('a traveller can leave', $r['status'] === 200);
$r = request('GET', API . '?resource=trip&uuid=' . $TRIP_A, $GUEST_SID);
check('after leaving it is gone for them', $r['status'] === 404);
$r = request('POST', API . '?resource=member&action=leave&uuid=' . $TRIP_A, $ADMIN_SID, []);
check('the owner cannot leave their own trip', $r['status'] === 403);

$r = request('POST', API . '?resource=invite&action=disable&uuid=' . $TRIP_A, $ADMIN_SID, []);
$r = request('GET', API . '?resource=invite&t=' . $token2);
check('a disabled link is 404', $r['status'] === 404);

// ------------------------------------------------------------------
echo "\nThe showcase\n";
// ------------------------------------------------------------------

$TRIP_G = tuuid(3);
request('POST', API . '?resource=trip', $GUEST_SID, ['uuid' => $TRIP_G, 'name' => 'Guest trip']);
$r = request('POST', API . '?resource=trip&action=showcase&uuid=' . $TRIP_G, $GUEST_SID, ['on' => true]);
check('only an admin can make a showcase', $r['status'] === 403);

$r = request('GET', API . '?resource=showcase');
check('with no showcase set, there is none', $r['status'] === 404);

// Re-join the guest so a traveller's photo sits on the showcase.
$r = request('POST', API . '?resource=invite&action=reset&uuid=' . $TRIP_A, $ADMIN_SID, []);
request('POST', API . '?resource=join', $GUEST_SID, ['token' => $r['body']['token'] ?? '']);
$PHOTO_SHOW = tuuid(214);
request('POST', API . '?resource=photo', $GUEST_SID, ['multipart' => $photoFields($PHOTO_SHOW, $PLACE_1, [
    'photo' => ['file' => jpeg(300, 200), 'name' => 'g.jpg', 'type' => 'image/jpeg'],
])]);

$r = request('POST', API . '?resource=trip&action=showcase&uuid=' . $TRIP_A, $ADMIN_SID, ['on' => true]);
check('an admin makes their trip the showcase', $r['status'] === 200 && ($r['body']['trip']['showcase'] ?? false) === true, "status {$r['status']}");
$r = request('GET', API . '?resource=showcase');
check('signed out, the showcase opens read-only', $r['status'] === 200 && ($r['body']['trip']['role'] ?? '') === 'viewer');
check('the showcase names nobody who added photos', !str_contains($r['raw'], 'Test Guest') && !str_contains($r['raw'], '"by_id":' . $guestId));
check('the showcase lists no members', !isset($r['body']['members']) || $r['body']['members'] === []);
$r = request('GET', API . '?resource=photo&size=thumb&uuid=' . $PHOTO_SHOW);
check('signed out, the showcase photos load', $r['status'] === 200);
$r = request('GET', API . '?resource=trip&uuid=' . $TRIP_A, $C_SID);
check('a stranger opening the showcase by uuid sees it read-only', $r['status'] === 200 && ($r['body']['trip']['role'] ?? '') === 'viewer');
$r = request('POST', API . '?resource=place', $C_SID, $placeBody(tuuid(108), 'Graffiti', 46.0, 14.0));
check('a showcase visitor cannot add to it', $r['status'] === 403 || $r['status'] === 404, "status {$r['status']}");

$TRIP_A2 = tuuid(4);
request('POST', API . '?resource=trip', $ADMIN_SID, ['uuid' => $TRIP_A2, 'name' => 'Second']);
request('POST', API . '?resource=trip&action=showcase&uuid=' . $TRIP_A2, $ADMIN_SID, ['on' => true]);
$r = request('GET', API . '?resource=showcase');
check('a new showcase replaces the old one', ($r['body']['trip']['uuid'] ?? '') === $TRIP_A2);
request('POST', API . '?resource=trip&action=showcase&uuid=' . $TRIP_A2, $ADMIN_SID, ['on' => false]);
$r = request('GET', API . '?resource=showcase');
check('turning it off leaves none', $r['status'] === 404);
request('POST', API . '?resource=trip&action=showcase&uuid=' . $TRIP_A, $ADMIN_SID, ['on' => true]);
$pdo->prepare('UPDATE users SET is_admin = 0 WHERE id = ?')->execute([$adminId]);
$r = request('GET', API . '?resource=showcase');
$pdo->prepare('UPDATE users SET is_admin = 1 WHERE id = ?')->execute([$adminId]);
check('a showcase whose owner is no longer an admin is not shown', $r['status'] === 404);

// ------------------------------------------------------------------
echo "\nDeleting a whole trip\n";
// ------------------------------------------------------------------

$r = request('POST', API . '?resource=trip&action=delete&uuid=' . $TRIP_A2, $GUEST_SID, []);
check('nobody else can delete a trip', $r['status'] === 404);
$r = request('POST', API . '?resource=trip&action=delete&uuid=' . $TRIP_A2, $ADMIN_SID, []);
check('the owner deletes a trip', $r['status'] === 200);
$r = request('POST', API . '?resource=trip', $ADMIN_SID, ['uuid' => $TRIP_A2, 'name' => 'Second']);
check('a queued retry of a deleted trip is 410 gone', $r['status'] === 410);

// ------------------------------------------------------------------
echo "\nYour data: export and account deletion\n";
// ------------------------------------------------------------------

$AUTH = 'http://' . HOST . ':' . PORT . '/app/controllers/auth-controller.php';
// C owns a trip a guest has photographed, and has added to the admin's trip.
$TRIP_C = tuuid(5);
$PLACE_C = tuuid(109);
request('POST', API . '?resource=trip', $C_SID, ['uuid' => $TRIP_C, 'name' => 'C trip']);
request('POST', API . '?resource=place', $C_SID, $placeBody($PLACE_C, 'Kranj', 46.2389, 14.3556, $TRIP_C));
$r = request('POST', API . '?resource=invite&action=reset&uuid=' . $TRIP_C, $C_SID, []);
request('POST', API . '?resource=join', $GUEST_SID, ['token' => $r['body']['token'] ?? '']);
$PHOTO_IN_C = tuuid(215);
request('POST', API . '?resource=photo', $GUEST_SID, ['multipart' => $photoFields($PHOTO_IN_C, $PLACE_C, [
    'photo' => ['file' => jpeg(300, 200), 'name' => 'g.jpg', 'type' => 'image/jpeg'],
])]);
$r = request('POST', API . '?resource=invite&action=reset&uuid=' . $TRIP_A, $ADMIN_SID, []);
request('POST', API . '?resource=join', $C_SID, ['token' => $r['body']['token'] ?? '']);
$C_PLACE_IN_A = tuuid(110);
request('POST', API . '?resource=place', $C_SID, $placeBody($C_PLACE_IN_A, 'Radovljica', 46.3444, 14.1744));
$PHOTO_C_IN_A = tuuid(216);
request('POST', API . '?resource=photo', $C_SID, ['multipart' => $photoFields($PHOTO_C_IN_A, $C_PLACE_IN_A, [
    'photo' => ['file' => jpeg(300, 200), 'name' => 'c.jpg', 'type' => 'image/jpeg'],
])]);
$filesInC = $filesOf($PHOTO_IN_C);

$r = request('GET', $AUTH . '?action=export', $C_SID);
$export = $r['body']['data'] ?? [];
check('the export holds the trips tables', isset($export['trips'], $export['trips_members'], $export['trips_places'], $export['trips_photos']), implode(',', array_keys($export)));
check('the export holds no token hash', !str_contains($r['raw'], 'token_hash'));

$r = request('POST', $AUTH . '?action=delete-account', $C_SID, ['confirm' => 'tripstest-c@test.local']);
check('the account deletion goes through', $r['status'] === 200, "status {$r['status']} {$r['raw']}");
$gone = (int) $pdo->query("SELECT COUNT(*) FROM trips WHERE uuid = '$TRIP_C'")->fetchColumn();
check('a trip they owned is gone', $gone === 0);
check('photos others put in it are gone from disk', count($filesInC) === 2 && !is_file(UPLOADS . "/{$filesInC[0]}.jpg") && !is_file(UPLOADS . "/{$filesInC[1]}.jpg"));
$orphanImages = (int) $pdo->query("SELECT COUNT(*) FROM images WHERE uuid IN ('" . implode("','", $filesInC) . "')")->fetchColumn();
check('and from the images table', $orphanImages === 0);
$stays = $pdo->query("SELECT uploaded_by FROM trips_photos WHERE uuid = '$PHOTO_C_IN_A'")->fetch(PDO::FETCH_ASSOC);
check('their photo in someone else\'s trip stays, unattributed', $stays !== false && $stays['uploaded_by'] === null);
$placeStays = $pdo->query("SELECT created_by FROM trips_places WHERE uuid = '$C_PLACE_IN_A'")->fetch(PDO::FETCH_ASSOC);
check('their place in someone else\'s trip stays, unattributed', $placeStays !== false && $placeStays['created_by'] === null);

// ------------------------------------------------------------------

echo "\n$passed passed, $failed failed\n";
exit($failed === 0 ? 0 : 1);
