<?php
declare(strict_types=1);

// Integration tests for trails-controller.php: the flight sync merge, share
// links, and isolation between accounts.
//
// The behaviour that matters most is that sync MERGES and is idempotent. The
// client re-uploads whatever it holds whenever it reconnects, so a replace, a
// failed upsert, or a duplicate insert would either lose a flight someone
// recorded on another device or double it. Flights are not recoverable: the
// aircraft has landed.
//
// Second in importance is the share token. Only its SHA-256 is stored, and
// revoking or deleting must take the public link down immediately, because
// the link exposes somebody's movements to anyone holding it.
//
// Runs ONLY against the local scratch DB (127.0.0.1/portfolio): the DB_* env
// overrides below make database.php skip loading app/.env, which points at
// the remote production database. Never run these against prod.
//
// Requires the seeded test users in the local DB:
//   admin@test.local  session token = 64 x 'a'
//   guest@test.local  session token = 64 x 'b'
//
// Run: /opt/lampp/bin/php tests/trails-controller.test.php

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
const PORT     = 8941;
const API      = 'http://' . HOST . ':' . PORT . '/app/controllers/trails-controller.php';

$ADMIN_SID = str_repeat('a', 64);
$GUEST_SID = str_repeat('b', 64);

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

/** @return array{status:int, body:mixed, headers:array} */
function request(string $method, string $url, ?string $sid = null, ?array $body = null): array
{
    $headers = [];
    if ($sid !== null) {
        $headers[] = 'Cookie: portfolio_sid=' . $sid;
    }
    $opts = ['http' => ['method' => $method, 'ignore_errors' => true, 'timeout' => 15]];
    if ($body !== null) {
        $headers[] = 'Content-Type: application/json';
        $opts['http']['content'] = json_encode($body);
    }
    $opts['http']['header'] = implode("\r\n", $headers);
    $raw = file_get_contents($url, false, stream_context_create($opts));
    $status = 0;
    $seen = $http_response_header ?? [];
    foreach ($seen as $h) {
        if (preg_match('#^HTTP/\S+\s+(\d{3})#', $h, $m)) {
            $status = (int) $m[1];
        }
    }
    return ['status' => $status, 'body' => $raw !== false ? json_decode($raw, true) : null, 'headers' => $seen];
}

function hasHeader(array $headers, string $needle): bool
{
    foreach ($headers as $h) {
        if (stripos($h, $needle) !== false) {
            return true;
        }
    }
    return false;
}

/** A serialized flight in the shape logic.js sends. */
function wireFlight(string $uuid, int $startedAt, array $over = []): array
{
    $n = $over['n'] ?? 3;
    $t = [];
    $lat = [];
    $lon = [];
    $alt = [];
    $spd = [];
    for ($i = 0; $i < $n; $i++) {
        $t[] = $i * 30;
        $lat[] = round(46.05 + $i * 0.1, 5);
        $lon[] = 14.51;
        $alt[] = 1000 * $i;
        $spd[] = 230.0;
    }
    return array_merge([
        'v' => 1,
        'uuid' => $uuid,
        'name' => $over['name'] ?? 'Test flight',
        'startedAt' => $startedAt,
        'endedAt' => $startedAt + ($n - 1) * 30_000,
        'updatedAt' => $over['updatedAt'] ?? $startedAt + 60_000,
        'stats' => ['distanceKm' => 22.2, 'durationMs' => ($n - 1) * 30_000, 'pointCount' => $n],
        'points' => ['base' => $startedAt, 't' => $t, 'lat' => $lat, 'lon' => $lon,
                     'alt' => $alt, 'spd' => $spd, 'gap' => []],
    ], array_diff_key($over, array_flip(['n', 'name', 'updatedAt'])));
}

// ------------------------------------------------------------------
//  Fixtures
// ------------------------------------------------------------------

$pdo = new PDO(DB_DSN, DB_USER, DB_PASS, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);

$pdo->exec('CREATE TABLE IF NOT EXISTS trails_flights (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    uuid CHAR(36) NOT NULL,
    name VARCHAR(120) NOT NULL DEFAULT \'\',
    started_at DATETIME NOT NULL,
    ended_at DATETIME DEFAULT NULL,
    stats JSON NOT NULL,
    points MEDIUMTEXT NOT NULL,
    point_count INT NOT NULL DEFAULT 0,
    updated_at BIGINT NOT NULL,
    deleted_at DATETIME DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_trails_flights_user_uuid (user_id, uuid),
    INDEX idx_trails_flights_user (user_id),
    CONSTRAINT fk_trails_flights_user FOREIGN KEY (user_id)
        REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci');

$pdo->exec('CREATE TABLE IF NOT EXISTS trails_shares (
    id INT AUTO_INCREMENT PRIMARY KEY,
    flight_id INT NOT NULL,
    token_hash CHAR(64) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_trails_shares_token (token_hash),
    UNIQUE KEY uq_trails_shares_flight (flight_id),
    CONSTRAINT fk_trails_shares_flight FOREIGN KEY (flight_id)
        REFERENCES trails_flights(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci');

$adminId = (int) $pdo->query("SELECT id FROM users WHERE email = 'admin@test.local'")->fetchColumn();
$guestId = (int) $pdo->query("SELECT id FROM users WHERE email = 'guest@test.local'")->fetchColumn();
if ($adminId === 0 || $guestId === 0) {
    fwrite(STDERR, "Missing seeded test users in local DB\n");
    exit(1);
}

function teardown(PDO $pdo, int $adminId, int $guestId): void
{
    // trails_shares cascades from trails_flights.
    $stmt = $pdo->prepare('DELETE FROM trails_flights WHERE user_id IN (?, ?)');
    $stmt->execute([$adminId, $guestId]);
}

teardown($pdo, $adminId, $guestId); // clean leftovers from a crashed run

$server = proc_open(
    [PHP_BIN, '-d', 'variables_order=EGPCS', '-S', HOST . ':' . PORT, '-t', DOC_ROOT],
    [1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']],
    $pipes,
    DOC_ROOT,
    [
        'DB_HOST'   => '127.0.0.1',
        'DB_PORT'   => '3306',
        'DB_NAME'   => 'portfolio',
        'DB_USER_W' => DB_USER,
        'DB_PASS_W' => DB_PASS,
        'DB_USER_R' => DB_USER,
        'DB_PASS_R' => DB_PASS,
        'PATH'      => getenv('PATH') ?: '/usr/bin:/bin',
    ]
);

register_shutdown_function(function () use ($server, $pdo, $adminId, $guestId) {
    if (is_resource($server)) {
        proc_terminate($server);
    }
    teardown($pdo, $adminId, $guestId);
});

for ($i = 0; $i < 50; $i++) {
    $probe = @fsockopen(HOST, PORT, $errno, $errstr, 0.2);
    if ($probe) { fclose($probe); break; }
    usleep(100000);
}

$T0 = 1_754_000_000_000;
$UUID_A = '6f1e7b0c-6b2a-4f1e-9c3d-2a5b8e4d7c10';
$UUID_B = '7a2f8c1d-7c3b-4a2f-8d4e-3b6c9f5e8d21';
$UUID_G = '8b3a9d2e-8d4c-4b3a-9e5f-4c7d0a6f9e32';

// ------------------------------------------------------------------
//  Transport contract
// ------------------------------------------------------------------

echo "\nTransport contract\n";

$r = request('OPTIONS', API . '?resource=session');
check('OPTIONS preflight answers 204', $r['status'] === 204, "status {$r['status']}");

$r = request('GET', API . '?resource=session');
check('session probe is public', $r['status'] === 200, "status {$r['status']}");
// `?? ` would fire on the very null being asserted, so ask the array directly.
check('session says nobody is signed in',
    is_array($r['body']) && array_key_exists('viewer', $r['body']) && $r['body']['viewer'] === null);
check('responses are no-store', hasHeader($r['headers'], 'Cache-Control: no-store'));
check(
    'no wildcard CORS on a cookie-authed endpoint',
    !hasHeader($r['headers'], 'Access-Control-Allow-Origin: *'),
    'wildcard CORS is invalid with credentials'
);

// ------------------------------------------------------------------
//  Gating
// ------------------------------------------------------------------

echo "\nGating\n";

$r = request('GET', API . '?resource=flights');
check('listing flights signed out is 401', $r['status'] === 401, "status {$r['status']}");

$r = request('POST', API . '?resource=sync', null, ['flights' => [wireFlight($UUID_A, $T0)]]);
check('syncing signed out is 401', $r['status'] === 401, "status {$r['status']}");

$r = request('GET', API . '?resource=flights', $ADMIN_SID);
check('listing flights signed in is 200', $r['status'] === 200, "status {$r['status']}");
check('a fresh account has no flights', ($r['body']['flights'] ?? null) === []);

// ------------------------------------------------------------------
//  The sync merge
// ------------------------------------------------------------------

echo "\nSync merge\n";

$r = request('POST', API . '?resource=sync', $ADMIN_SID, ['flights' => [wireFlight($UUID_A, $T0)]]);
check('sync accepts a flight', $r['status'] === 200, "status {$r['status']}");
check('sync reports what it accepted', ($r['body']['accepted'] ?? []) === [$UUID_A]);

$r = request('GET', API . '?resource=flights', $ADMIN_SID);
check('the flight comes back in the list', count($r['body']['flights'] ?? []) === 1);
check('the list carries the client uuid', ($r['body']['flights'][0]['uuid'] ?? '') === $UUID_A);
check('the list omits the track', !isset($r['body']['flights'][0]['points']));

// Re-uploading the identical flight must not duplicate it.
request('POST', API . '?resource=sync', $ADMIN_SID, ['flights' => [wireFlight($UUID_A, $T0)]]);
request('POST', API . '?resource=sync', $ADMIN_SID, ['flights' => [wireFlight($UUID_A, $T0)]]);
$r = request('GET', API . '?resource=flights', $ADMIN_SID);
check('re-uploading the same flight is idempotent', count($r['body']['flights'] ?? []) === 1,
    'got ' . count($r['body']['flights'] ?? []));

// A newer copy wins; an older copy must not clobber the newer one.
request('POST', API . '?resource=sync', $ADMIN_SID,
    ['flights' => [wireFlight($UUID_A, $T0, ['name' => 'Renamed later', 'updatedAt' => $T0 + 900_000])]]);
$r = request('GET', API . '?resource=flight&uuid=' . $UUID_A, $ADMIN_SID);
check('a newer copy replaces the stored one', ($r['body']['flight']['name'] ?? '') === 'Renamed later');

request('POST', API . '?resource=sync', $ADMIN_SID,
    ['flights' => [wireFlight($UUID_A, $T0, ['name' => 'Stale device', 'updatedAt' => $T0 + 1000])]]);
$r = request('GET', API . '?resource=flight&uuid=' . $UUID_A, $ADMIN_SID);
check('an older copy does not clobber a newer one', ($r['body']['flight']['name'] ?? '') === 'Renamed later',
    'got ' . ($r['body']['flight']['name'] ?? 'nothing'));

// The track survives the round trip.
$r = request('GET', API . '?resource=flight&uuid=' . $UUID_A, $ADMIN_SID);
$pts = $r['body']['flight']['points'] ?? null;
check('the track comes back whole', is_array($pts) && count($pts['t'] ?? []) === 3);
check('coordinates survive the round trip', abs(($pts['lat'][1] ?? 0) - 46.15) < 1e-6);

// ------------------------------------------------------------------
//  Junk is dropped, never fatal
// ------------------------------------------------------------------

echo "\nJunk handling\n";

$r = request('POST', API . '?resource=sync', $ADMIN_SID, ['flights' => [
    ['v' => 1, 'uuid' => 'not-a-uuid', 'points' => []],
    ['v' => 99, 'uuid' => $UUID_B],
    'a string where a flight should be',
    wireFlight($UUID_B, $T0 + 5_000_000),
]]);
check('a batch with junk still succeeds', $r['status'] === 200, "status {$r['status']}");
check('only the good flight is accepted', ($r['body']['accepted'] ?? []) === [$UUID_B],
    'got ' . json_encode($r['body']['accepted'] ?? null));

$r = request('GET', API . '?resource=flights', $ADMIN_SID);
check('junk did not create rows', count($r['body']['flights'] ?? []) === 2);

$r = request('POST', API . '?resource=sync', $ADMIN_SID, ['flights' => 'nonsense']);
check('a malformed envelope is 400', $r['status'] === 400, "status {$r['status']}");

$many = [];
for ($i = 0; $i < 40; $i++) {
    $many[] = wireFlight(sprintf('%08x-0000-4000-8000-000000000000', $i), $T0 + $i * 1000);
}
$r = request('POST', API . '?resource=sync', $ADMIN_SID, ['flights' => $many]);
check('too many flights in one request is 400', $r['status'] === 400, "status {$r['status']}");

$r = request('POST', API . '?resource=sync', $ADMIN_SID,
    ['flights' => [wireFlight($UUID_B, $T0 + 5_000_000, ['n' => 4000, 'updatedAt' => $T0 + 9_000_000])]]);
check('an over-long track is rejected without killing the request', $r['status'] === 200);
check('the over-long track is not accepted', ($r['body']['accepted'] ?? []) === [],
    'got ' . json_encode($r['body']['accepted'] ?? null));

// ------------------------------------------------------------------
//  Rename and soft delete
// ------------------------------------------------------------------

echo "\nRename and delete\n";

$r = request('POST', API . '?resource=flight&uuid=' . $UUID_A . '&action=rename', $ADMIN_SID, ['name' => 'Ljubljana to Amsterdam']);
check('renaming a flight works', $r['status'] === 200, "status {$r['status']}");
$r = request('GET', API . '?resource=flight&uuid=' . $UUID_A, $ADMIN_SID);
check('the new name is stored', ($r['body']['flight']['name'] ?? '') === 'Ljubljana to Amsterdam');

$r = request('POST', API . '?resource=flight&uuid=' . $UUID_B . '&action=delete', $ADMIN_SID);
check('deleting a flight works', $r['status'] === 200, "status {$r['status']}");
$r = request('GET', API . '?resource=flights', $ADMIN_SID);
check('a deleted flight leaves the list', count($r['body']['flights'] ?? []) === 1);
$r = request('GET', API . '?resource=flight&uuid=' . $UUID_B, $ADMIN_SID);
check('a deleted flight is gone individually too', $r['status'] === 404, "status {$r['status']}");

$deletedRow = $pdo->query('SELECT deleted_at FROM trails_flights WHERE uuid = ' . $pdo->quote($UUID_B))->fetchColumn();
check('delete is soft, so the tombstone can sync', $deletedRow !== false && $deletedRow !== null);

// A deletion arriving through sync tombstones too.
request('POST', API . '?resource=sync', $ADMIN_SID, ['flights' => [], 'deleted' => [$UUID_A]]);
$r = request('GET', API . '?resource=flights', $ADMIN_SID);
check('sync can carry a deletion', count($r['body']['flights'] ?? []) === 0);

// ------------------------------------------------------------------
//  Isolation between accounts
// ------------------------------------------------------------------

echo "\nIsolation\n";

request('POST', API . '?resource=sync', $GUEST_SID, ['flights' => [wireFlight($UUID_G, $T0)]]);

$r = request('GET', API . '?resource=flights', $GUEST_SID);
check('the guest sees only their own flight', count($r['body']['flights'] ?? []) === 1);
check('and it is theirs', ($r['body']['flights'][0]['uuid'] ?? '') === $UUID_G);

$r = request('GET', API . '?resource=flight&uuid=' . $UUID_G, $ADMIN_SID);
check("another account's flight is 404, not 403", $r['status'] === 404, "status {$r['status']}");

$r = request('POST', API . '?resource=flight&uuid=' . $UUID_G . '&action=rename', $ADMIN_SID, ['name' => 'stolen']);
check("another account's flight cannot be renamed", $r['status'] === 404, "status {$r['status']}");

$r = request('POST', API . '?resource=flight&uuid=' . $UUID_G . '&action=delete', $ADMIN_SID);
check("another account's flight cannot be deleted", $r['status'] === 404, "status {$r['status']}");

$stillThere = $pdo->query('SELECT deleted_at FROM trails_flights WHERE uuid = ' . $pdo->quote($UUID_G))->fetchColumn();
check('the guest flight really is untouched', $stillThere === null);

// The same uuid on two accounts is two different flights, not a collision.
$r = request('POST', API . '?resource=sync', $ADMIN_SID, ['flights' => [wireFlight($UUID_G, $T0, ['name' => 'Mine'])]]);
check('the same uuid under another account is accepted', ($r['body']['accepted'] ?? []) === [$UUID_G]);
$r = request('GET', API . '?resource=flight&uuid=' . $UUID_G, $GUEST_SID);
check("and does not overwrite the other account's flight", ($r['body']['flight']['name'] ?? '') === 'Test flight',
    'got ' . ($r['body']['flight']['name'] ?? 'nothing'));

// ------------------------------------------------------------------
//  Share links
// ------------------------------------------------------------------

echo "\nSharing\n";

$r = request('POST', API . '?resource=share&uuid=' . $UUID_G . '&action=create', $GUEST_SID);
check('creating a share link works', $r['status'] === 200, "status {$r['status']}");
$token = $r['body']['token'] ?? '';
check('a token comes back once', is_string($token) && strlen($token) === 32, "token '$token'");

$stored = $pdo->query('SELECT token_hash FROM trails_shares')->fetchColumn();
check('only the hash of the token is stored', $stored === hash('sha256', $token));
check('the raw token is nowhere in the table', $stored !== $token);

$r = request('GET', API . '?resource=shared&t=' . $token);
check('a shared flight opens with no account at all', $r['status'] === 200, "status {$r['status']}");
check('the shared payload carries the track', count($r['body']['flight']['points']['t'] ?? []) === 3);
check('the shared payload is still no-store', hasHeader($r['headers'], 'Cache-Control: no-store'));

$r = request('GET', API . '?resource=shared&t=' . str_repeat('0', 32));
check('an unknown token is 404', $r['status'] === 404, "status {$r['status']}");

$r = request('POST', API . '?resource=share&uuid=' . $UUID_G . '&action=create', $ADMIN_SID);
$adminToken = $r['body']['token'] ?? '';
check("sharing acts on the caller's own flight, not someone else's",
    is_string($adminToken) && $adminToken !== $token);

// Revoking must take the link down at once.
request('POST', API . '?resource=share&uuid=' . $UUID_G . '&action=revoke', $GUEST_SID);
$r = request('GET', API . '?resource=shared&t=' . $token);
check('a revoked link stops working immediately', $r['status'] === 404, "status {$r['status']}");

// Deleting a shared flight must also take its link down.
$r = request('POST', API . '?resource=share&uuid=' . $UUID_G . '&action=create', $GUEST_SID);
$token2 = $r['body']['token'] ?? '';
check('the flight can be shared again', is_string($token2) && strlen($token2) === 32);
request('POST', API . '?resource=flight&uuid=' . $UUID_G . '&action=delete', $GUEST_SID);
$r = request('GET', API . '?resource=shared&t=' . $token2);
check('deleting a flight kills its public link', $r['status'] === 404, "status {$r['status']}");

// ------------------------------------------------------------------

echo "\n$passed passed, $failed failed\n";
exit($failed === 0 ? 0 : 1);
