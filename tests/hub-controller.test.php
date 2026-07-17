<?php
declare(strict_types=1);

// Integration tests for hub-controller.php tile visibility rules.
//
// Runs ONLY against the local scratch DB (127.0.0.1/portfolio): the DB_* env
// overrides below make database.php skip loading app/.env, which points at
// the remote production database. Never run these against prod.
//
// Requires the seeded test users in the local DB:
//   admin@test.local  session token = 64 x 'a'
//   guest@test.local  session token = 64 x 'b'
//
// Run: /opt/lampp/bin/php tests/hub-controller.test.php   (Linux)
//      C:\xampp\php\php.exe tests\hub-controller.test.php  (Windows)

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit('CLI only');
}

const DB_DSN   = 'mysql:host=127.0.0.1;port=3306;dbname=portfolio;charset=utf8mb4';
const DB_USER  = 'portfolio_dev';
const DB_PASS  = 'R2miswz1pNKOxdl4';
const PHP_BIN  = PHP_BINARY; // the interpreter running this script also serves the endpoints
const DOC_ROOT = __DIR__ . '/..';
const HOST     = '127.0.0.1';
const PORT     = 8931;
const API      = 'http://' . HOST . ':' . PORT . '/app/controllers/hub-controller.php';

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

// ------------------------------------------------------------------
//  HTTP helper
// ------------------------------------------------------------------

/** @return array{status:int, body:mixed} */
function request(string $method, string $url, ?string $sid = null, ?array $body = null): array
{
    $headers = [];
    if ($sid !== null) {
        $headers[] = 'Cookie: portfolio_sid=' . $sid;
    }
    $opts = ['http' => ['method' => $method, 'ignore_errors' => true, 'timeout' => 10]];
    if ($body !== null) {
        $headers[] = 'Content-Type: application/json';
        $opts['http']['content'] = json_encode($body);
    }
    $opts['http']['header'] = implode("\r\n", $headers);
    $raw = file_get_contents($url, false, stream_context_create($opts));
    $status = 0;
    foreach ($http_response_header ?? [] as $h) {
        if (preg_match('#^HTTP/\S+\s+(\d{3})#', $h, $m)) {
            $status = (int) $m[1];
        }
    }
    return ['status' => $status, 'body' => $raw !== false ? json_decode($raw, true) : null];
}

/** @param array<int, array<string, mixed>> $tiles */
function tileNames(?array $tiles): array
{
    return array_map(fn ($t) => $t['name'], $tiles ?? []);
}

// ------------------------------------------------------------------
//  Fixtures (all names prefixed so teardown can never touch real rows)
// ------------------------------------------------------------------

$pdo = new PDO(DB_DSN, DB_USER, DB_PASS, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);

function teardown(PDO $pdo): void
{
    $pdo->exec("DELETE FROM users WHERE email = 'hubtest-seed@test.local'"); // cascades hub_user_apps
    $pdo->exec("DELETE s FROM hub_user_apps s
                JOIN hub_apps h ON h.id = s.app_id
                WHERE h.name LIKE 'HT %'");
    $pdo->exec("DELETE FROM hub_apps WHERE name LIKE 'HT %'");
    $pdo->exec("DELETE r FROM user_project_roles r
                JOIN projects p ON p.id = r.project_id
                WHERE p.project_key LIKE 'hubtest\\_%'");
    $pdo->exec("DELETE FROM projects WHERE project_key LIKE 'hubtest\\_%'");
}

teardown($pdo); // clean leftovers from a crashed previous run

$guestId = (int) $pdo->query("SELECT id FROM users WHERE email = 'guest@test.local'")->fetchColumn();
if ($guestId === 0) {
    fwrite(STDERR, "Missing guest@test.local fixture user in local DB\n");
    exit(1);
}

$mkProject = $pdo->prepare('INSERT INTO projects (project_key, name, active) VALUES (?, ?, ?)');
$mkProject->execute(['hubtest_role', 'HT role project', 1]);
$pRole = (int) $pdo->lastInsertId();
$mkProject->execute(['hubtest_norole', 'HT norole project', 1]);
$pNoRole = (int) $pdo->lastInsertId();
$mkProject->execute(['hubtest_disabled', 'HT disabled project', 0]);
$pDisabled = (int) $pdo->lastInsertId();

$adminId = (int) $pdo->query("SELECT id FROM users WHERE email = 'admin@test.local'")->fetchColumn();
if ($adminId === 0) {
    fwrite(STDERR, "Missing admin@test.local fixture user in local DB\n");
    exit(1);
}

$mkRole = $pdo->prepare('INSERT INTO user_project_roles (user_id, project_id, role) VALUES (?, ?, ?)');
$mkRole->execute([$guestId, $pRole, 'member']);
$mkRole->execute([$guestId, $pDisabled, 'member']); // role on disabled project must NOT count

$mkTile = $pdo->prepare('INSERT INTO hub_apps (name, url, sort_order, project_id, active) VALUES (?, ?, ?, ?, ?)');
$tile = function (string $name, int $sort, ?int $projectId, int $active) use ($pdo, $mkTile): int {
    $mkTile->execute([$name, '/views/botaniq/', $sort, $projectId, $active]);
    return (int) $pdo->lastInsertId();
};
$tRoleGated = $tile('HT role-gated',       910, $pRole,     1);
$tNoRole    = $tile('HT no-role',          920, $pNoRole,   1);
$tEveryone  = $tile('HT everyone',         930, null,       1);
$tDisabled  = $tile('HT disabled-project', 940, $pDisabled, 1);
$tInactive  = $tile('HT inactive-tile',    950, null,       0);

$pickTile = $pdo->prepare('INSERT INTO hub_user_apps (user_id, app_id) VALUES (?, ?)');
$pickTile->execute([$guestId, $tRoleGated]); // guest picked this one; 'HT everyone' stays unpicked
// Picked but not permitted: these rows must lie dormant, never render.
$pickTile->execute([$guestId, $tNoRole]);
$pickTile->execute([$guestId, $tDisabled]);
$pickTile->execute([$guestId, $tInactive]);

// ------------------------------------------------------------------
//  Server lifecycle
// ------------------------------------------------------------------

$nullDev = PHP_OS_FAMILY === 'Windows' ? 'NUL' : '/dev/null';
$serverEnv = [
    'DB_HOST'   => '127.0.0.1',
    'DB_PORT'   => '3306',
    'DB_NAME'   => 'portfolio',
    'DB_USER_W' => DB_USER,
    'DB_PASS_W' => DB_PASS,
    'DB_USER_R' => DB_USER,
    'DB_PASS_R' => DB_PASS,
    'PATH'      => getenv('PATH') ?: '/usr/bin:/bin',
];
if (PHP_OS_FAMILY === 'Windows') {
    // Winsock needs SystemRoot in the child environment or the built-in server cannot bind.
    $serverEnv['SystemRoot'] = getenv('SystemRoot') ?: 'C:\\Windows';
}

$server = proc_open(
    [PHP_BIN, '-d', 'variables_order=EGPCS', '-S', HOST . ':' . PORT, '-t', DOC_ROOT],
    [1 => ['file', $nullDev, 'w'], 2 => ['file', $nullDev, 'w']],
    $pipes,
    DOC_ROOT,
    $serverEnv
);

register_shutdown_function(function () use ($server, $pdo) {
    if (is_resource($server)) {
        proc_terminate($server);
    }
    teardown($pdo);
});

$ready = false;
for ($i = 0; $i < 50; $i++) {
    $sock = @fsockopen(HOST, PORT, $errno, $errstr, 0.2);
    if ($sock) {
        fclose($sock);
        $ready = true;
        break;
    }
    usleep(100_000);
}
if (!$ready) {
    fwrite(STDERR, "Built-in PHP server did not start on port " . PORT . "\n");
    exit(1);
}

// ------------------------------------------------------------------
//  Tests
// ------------------------------------------------------------------

echo "hub-controller visibility rules\n";

// Anonymous
$res = request('GET', API);
check('anonymous GET is rejected with 401', $res['status'] === 401, "got {$res['status']}");

$res = request('POST', API, null, ['name' => 'HT hacked', 'url' => '/views/botaniq/']);
check('anonymous POST is rejected with 401', $res['status'] === 401, "got {$res['status']}");

// Guest (regular signed-in user): the shelf is personal, picked AND permitted.
$res = request('GET', API, $GUEST_SID);
check('guest GET succeeds', $res['status'] === 200, "got {$res['status']}");
$names = tileNames($res['body']);
check('picked tile of a project the guest holds a role in is on the shelf', in_array('HT role-gated', $names, true));
check('permitted but unpicked tile stays off the shelf', !in_array('HT everyone', $names, true));
check('picked tile of a project without a role lies dormant', !in_array('HT no-role', $names, true));
check('picked tile of a disabled project lies dormant', !in_array('HT disabled-project', $names, true));
check('picked inactive tile is hidden from guest', !in_array('HT inactive-tile', $names, true));

$tile = array_values(array_filter($res['body'] ?? [], fn ($t) => $t['name'] === 'HT role-gated'))[0] ?? null;
check(
    'launcher payload exposes only id/name/icon/gradient/url',
    $tile !== null && array_keys($tile) === ['id', 'name', 'icon', 'gradient', 'url'],
    $tile !== null ? implode(',', array_keys($tile)) : 'tile missing'
);

// Shelf management: adding a permitted tile
$res = request('POST', API . '?shelf=1', $GUEST_SID, ['app_id' => $tEveryone]);
check('guest adds a permitted tile to their shelf', $res['status'] === 201, "got {$res['status']}");
$res = request('GET', API, $GUEST_SID);
check('added tile now renders on the shelf', in_array('HT everyone', tileNames($res['body']), true));

$res = request('POST', API . '?shelf=1', $GUEST_SID, ['app_id' => $tNoRole]);
check('adding a tile without the project role is refused with 403', $res['status'] === 403, "got {$res['status']}");
$res = request('POST', API . '?shelf=1', $GUEST_SID, ['app_id' => 99999999]);
check('adding an unknown tile is a 404', $res['status'] === 404, "got {$res['status']}");
$res = request('POST', API . '?shelf=1', $GUEST_SID, ['app_id' => $tInactive]);
check('adding an inactive tile is a 404', $res['status'] === 404, "got {$res['status']}");
$res = request('POST', API . '?shelf=1', $GUEST_SID, ['app_id' => $tEveryone]);
check('re-adding an already picked tile is idempotent', $res['status'] === 201, "got {$res['status']}");

// Shelf management: removing
$res = request('DELETE', API . '?shelf=1&app_id=' . $tEveryone, $GUEST_SID);
check('guest removes a tile from their shelf', $res['status'] === 200, "got {$res['status']}");
$res = request('GET', API, $GUEST_SID);
check('removed tile is gone from the shelf', !in_array('HT everyone', tileNames($res['body']), true));
$res = request('DELETE', API . '?shelf=1&app_id=' . $tEveryone, $GUEST_SID);
check('removing a tile not on the shelf is a 404', $res['status'] === 404, "got {$res['status']}");

// Picker list (?manage=1): everything the caller MAY show, with on_shelf flags.
// State here: guest has 'HT role-gated' picked, 'HT everyone' unpicked again.
$res = request('GET', API . '?manage=1');
check('anonymous manage list is rejected with 401', $res['status'] === 401, "got {$res['status']}");

$res = request('GET', API . '?manage=1', $GUEST_SID);
check('guest manage list succeeds', $res['status'] === 200, "got {$res['status']}");
$byName = [];
foreach ($res['body'] ?? [] as $r) {
    $byName[$r['name']] = $r;
}
check('manage list offers permitted tiles, picked or not', isset($byName['HT role-gated'], $byName['HT everyone']));
check('manage list marks picked tiles on_shelf', ($byName['HT role-gated']['on_shelf'] ?? null) === true);
check('manage list marks unpicked tiles not on_shelf', ($byName['HT everyone']['on_shelf'] ?? null) === false);
check('manage list hides tiles without permission', !isset($byName['HT no-role']) && !isset($byName['HT disabled-project']));
check('manage list hides inactive tiles', !isset($byName['HT inactive-tile']));

$res = request('GET', API . '?manage=1', $ADMIN_SID);
$byName = [];
foreach ($res['body'] ?? [] as $r) {
    $byName[$r['name']] = $r;
}
check('admin manage list offers every active tile', isset($byName['HT no-role'], $byName['HT disabled-project']));
check('admin manage list still hides inactive tiles', !isset($byName['HT inactive-tile']));

$res = request('GET', API . '?all=1', $GUEST_SID);
check('guest cannot list all tiles (admin only)', $res['status'] === 403, "got {$res['status']}");

$res = request('POST', API, $GUEST_SID, ['name' => 'HT hacked', 'url' => '/views/botaniq/']);
check('guest POST is rejected with 403', $res['status'] === 403, "got {$res['status']}");

// Admin: the shelf is personal for admins too; only the permission branch is bypassed.
$res = request('GET', API, $ADMIN_SID);
$names = tileNames($res['body']);
check('admin GET succeeds', $res['status'] === 200, "got {$res['status']}");
check('admin shelf starts without unpicked tiles', !in_array('HT role-gated', $names, true) && !in_array('HT no-role', $names, true));

$pickTile->execute([$adminId, $tNoRole]);
$pickTile->execute([$adminId, $tDisabled]);
$pickTile->execute([$adminId, $tInactive]);
$res = request('GET', API, $ADMIN_SID);
$names = tileNames($res['body']);
check('admin sees picked role-gated tile without holding the role', in_array('HT no-role', $names, true));
check('admin sees picked tile of a disabled project', in_array('HT disabled-project', $names, true));
check('inactive tile is hidden even from admin in launcher list', !in_array('HT inactive-tile', $names, true));

$res = request('GET', API . '?all=1', $ADMIN_SID);
$names = tileNames($res['body']);
check('admin dashboard list succeeds', $res['status'] === 200, "got {$res['status']}");
check('dashboard list includes inactive tiles', in_array('HT inactive-tile', $names, true));
$tile = array_values(array_filter($res['body'] ?? [], fn ($t) => $t['name'] === 'HT role-gated'))[0] ?? null;
check(
    'dashboard list carries project info',
    $tile !== null && ($tile['project_key'] ?? null) === 'hubtest_role',
    $tile !== null ? json_encode($tile['project_key'] ?? null) : 'tile missing'
);

// is_default flag lifecycle through the admin tile CRUD
$res = request('POST', API, $ADMIN_SID, ['name' => 'HT default-tile', 'url' => '/views/botaniq/', 'is_default' => true]);
check('admin creates a tile marked default', $res['status'] === 201, "got {$res['status']}");
$res = request('GET', API . '?all=1', $ADMIN_SID);
$tile = array_values(array_filter($res['body'] ?? [], fn ($t) => $t['name'] === 'HT default-tile'))[0] ?? null;
check('dashboard list carries is_default', $tile !== null && ($tile['is_default'] ?? null) === 1,
    $tile !== null ? json_encode($tile['is_default'] ?? null) : 'tile missing');

$res = request('PUT', API . '?id=' . ($tile['id'] ?? 0), $ADMIN_SID, ['is_default' => false]);
check('admin clears the default flag', $res['status'] === 200, "got {$res['status']}");
$res = request('GET', API . '?all=1', $ADMIN_SID);
$tile = array_values(array_filter($res['body'] ?? [], fn ($t) => $t['name'] === 'HT default-tile'))[0] ?? null;
check('cleared flag round-trips as 0', $tile !== null && ($tile['is_default'] ?? null) === 0,
    $tile !== null ? json_encode($tile['is_default'] ?? null) : 'tile missing');

// ------------------------------------------------------------------
//  Default-shelf seeding (in-process: the same function auth-controller.php
//  calls after creating a user; the Google login flow itself cannot be
//  exercised without a real ID token)
// ------------------------------------------------------------------

require_once DOC_ROOT . '/app/services/hub-shelf-service.php';

$pdo->prepare('UPDATE hub_apps SET is_default = 1 WHERE id IN (?, ?)')
    ->execute([$tRoleGated, $tInactive]); // a gated default and an inactive default

$pdo->exec("INSERT INTO users (email, display_name) VALUES ('hubtest-seed@test.local', 'HT Seed')");
$seedUserId = (int) $pdo->lastInsertId();

seedDefaultHubApps($pdo, $seedUserId);
$stmt = $pdo->prepare(
    'SELECT s.app_id FROM hub_user_apps s JOIN hub_apps h ON h.id = s.app_id
     WHERE s.user_id = ? AND h.name LIKE ?'
);
$stmt->execute([$seedUserId, 'HT %']);
$seeded = array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN));
sort($seeded);
check('new user is seeded with every default tile, even gated or inactive ones',
    $seeded === [min($tRoleGated, $tInactive), max($tRoleGated, $tInactive)],
    json_encode($seeded));
check('non-default tiles are not seeded', !in_array($tEveryone, $seeded, true));

seedDefaultHubApps($pdo, $seedUserId);
$stmt->execute([$seedUserId, 'HT %']);
check('seeding is idempotent', count($stmt->fetchAll()) === 2);

// ------------------------------------------------------------------

echo "\n$passed passed, $failed failed\n";
exit($failed === 0 ? 0 : 1);
