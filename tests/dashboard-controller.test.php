<?php
declare(strict_types=1);

// Integration tests for dashboard-controller.php: tile visibility rules, the
// per-user shelf, and the folder/layout save (PUT ?layout=1).
//
// Runs ONLY against the local scratch DB (127.0.0.1/portfolio): the DB_* env
// overrides below make database.php skip loading app/.env, which points at
// the remote production database. Never run these against prod.
//
// Requires the seeded test users in the local DB:
//   admin@test.local  session token = 64 x 'a'
//   guest@test.local  session token = 64 x 'b'
//
// Setup migrates/creates the dashboard_* schema idempotently (RENAME from the
// old hub_* tables if present, then CREATE IF NOT EXISTS + column catch-up),
// so it works whether the scratch DB is fresh, still on hub_*, or migrated.
//
// Run: /opt/lampp/bin/php tests/dashboard-controller.test.php   (Linux)
//      C:\xampp\php\php.exe tests\dashboard-controller.test.php  (Windows)

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit('CLI only');
}

const DB_DSN   = 'mysql:host=127.0.0.1;port=3306;dbname=portfolio;charset=utf8mb4';
const DB_USER  = 'portfolio_dev';
const DB_PASS  = 'R2miswz1pNKOxdl4';
const PHP_BIN  = PHP_BINARY;
const DOC_ROOT = __DIR__ . '/..';
const HOST     = '127.0.0.1';
const PORT     = 8931;
const API      = 'http://' . HOST . ':' . PORT . '/app/controllers/dashboard-controller.php';

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

function shelfApps($body): array   { return is_array($body) && isset($body['apps']) ? $body['apps'] : []; }
function shelfFolders($body): array { return is_array($body) && isset($body['folders']) ? $body['folders'] : []; }
function appNames($body): array    { return array_map(fn ($t) => $t['name'], shelfApps($body)); }
function appByName($body, string $name)
{
    foreach (shelfApps($body) as $a) {
        if ($a['name'] === $name) return $a;
    }
    return null;
}

// ------------------------------------------------------------------
//  Schema migration/catch-up (robust across scratch-DB states)
// ------------------------------------------------------------------

$pdo = new PDO(DB_DSN, DB_USER, DB_PASS, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);

function tableExists(PDO $pdo, string $name): bool
{
    $stmt = $pdo->prepare('SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?');
    $stmt->execute([$name]);
    return $stmt->fetchColumn() !== false;
}

function ensureSchema(PDO $pdo): void
{
    if (!tableExists($pdo, 'dashboard_apps') && tableExists($pdo, 'hub_apps')) {
        try {
            $pdo->exec('RENAME TABLE hub_apps TO dashboard_apps, hub_user_apps TO dashboard_user_apps');
        } catch (PDOException $e) { /* partially migrated: fall through */ }
    }
    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS dashboard_apps (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(100) NOT NULL UNIQUE,
            icon VARCHAR(100) NOT NULL DEFAULT "fa-solid fa-cube",
            gradient VARCHAR(255) NOT NULL DEFAULT "linear-gradient(45deg, #d4451f 0%, #f2b705 100%)",
            url VARCHAR(255) NOT NULL,
            sort_order INT NOT NULL DEFAULT 0,
            project_id INT DEFAULT NULL,
            active TINYINT NOT NULL DEFAULT 1,
            is_default TINYINT NOT NULL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
    );
    $pdo->exec('ALTER TABLE dashboard_apps ADD COLUMN IF NOT EXISTS is_default TINYINT NOT NULL DEFAULT 0');
    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS dashboard_folders (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT NOT NULL,
            name VARCHAR(60) NOT NULL,
            position INT NOT NULL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_dashboard_folders_user (user_id, position),
            CONSTRAINT fk_dashboard_folders_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
    );
    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS dashboard_user_apps (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT NOT NULL,
            app_id INT NOT NULL,
            folder_id INT DEFAULT NULL,
            position INT NOT NULL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uq_dua_user_app (user_id, app_id),
            INDEX idx_dua_app (app_id),
            INDEX idx_dua_folder (folder_id),
            CONSTRAINT fk_dua_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            CONSTRAINT fk_dua_app FOREIGN KEY (app_id) REFERENCES dashboard_apps(id) ON DELETE CASCADE,
            CONSTRAINT fk_dua_folder FOREIGN KEY (folder_id) REFERENCES dashboard_folders(id) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
    );
    // Column + FK catch-up for a table carried over from hub_user_apps.
    $pdo->exec('ALTER TABLE dashboard_user_apps ADD COLUMN IF NOT EXISTS folder_id INT DEFAULT NULL');
    $pdo->exec('ALTER TABLE dashboard_user_apps ADD COLUMN IF NOT EXISTS position INT NOT NULL DEFAULT 0');
    try { $pdo->exec('ALTER TABLE dashboard_user_apps ADD INDEX idx_dua_folder (folder_id)'); }
    catch (PDOException $e) { /* index already present */ }
    try {
        $pdo->exec('ALTER TABLE dashboard_user_apps
                    ADD CONSTRAINT fk_dua_folder FOREIGN KEY (folder_id)
                        REFERENCES dashboard_folders(id) ON DELETE SET NULL');
    } catch (PDOException $e) { /* FK already present */ }
}

ensureSchema($pdo);

// ------------------------------------------------------------------
//  Fixtures (all names prefixed so teardown can never touch real rows)
// ------------------------------------------------------------------

function teardown(PDO $pdo): void
{
    $pdo->exec("DELETE FROM users WHERE email = 'dashtest-seed@test.local'"); // cascades user rows
    $pdo->exec("DELETE FROM dashboard_folders WHERE name LIKE 'DTF %'");
    $pdo->exec("DELETE s FROM dashboard_user_apps s
                JOIN dashboard_apps h ON h.id = s.app_id
                WHERE h.name LIKE 'DT %'");
    $pdo->exec("DELETE FROM dashboard_apps WHERE name LIKE 'DT %'");
    $pdo->exec("DELETE r FROM user_project_roles r
                JOIN projects p ON p.id = r.project_id
                WHERE p.project_key LIKE 'dashtest\\_%'");
    $pdo->exec("DELETE FROM projects WHERE project_key LIKE 'dashtest\\_%'");
}

teardown($pdo); // clean leftovers from a crashed previous run

$guestId = (int) $pdo->query("SELECT id FROM users WHERE email = 'guest@test.local'")->fetchColumn();
$adminId = (int) $pdo->query("SELECT id FROM users WHERE email = 'admin@test.local'")->fetchColumn();
if ($guestId === 0 || $adminId === 0) {
    fwrite(STDERR, "Missing admin/guest fixture users in local DB\n");
    exit(1);
}

$mkProject = $pdo->prepare('INSERT INTO projects (project_key, name, active) VALUES (?, ?, ?)');
$mkProject->execute(['dashtest_role', 'DT role project', 1]);
$pRole = (int) $pdo->lastInsertId();
$mkProject->execute(['dashtest_norole', 'DT norole project', 1]);
$pNoRole = (int) $pdo->lastInsertId();
$mkProject->execute(['dashtest_disabled', 'DT disabled project', 0]);
$pDisabled = (int) $pdo->lastInsertId();

$mkRole = $pdo->prepare('INSERT INTO user_project_roles (user_id, project_id, role) VALUES (?, ?, ?)');
$mkRole->execute([$guestId, $pRole, 'member']);
$mkRole->execute([$guestId, $pDisabled, 'member']); // role on disabled project must NOT count

$mkTile = $pdo->prepare('INSERT INTO dashboard_apps (name, url, sort_order, project_id, active) VALUES (?, ?, ?, ?, ?)');
$tile = function (string $name, int $sort, ?int $projectId, int $active) use ($pdo, $mkTile): int {
    $mkTile->execute([$name, '/views/botaniq/', $sort, $projectId, $active]);
    return (int) $pdo->lastInsertId();
};
$tRoleGated = $tile('DT role-gated',       910, $pRole,     1);
$tNoRole    = $tile('DT no-role',          920, $pNoRole,   1);
$tEveryone  = $tile('DT everyone',         930, null,       1);
$tDisabled  = $tile('DT disabled-project', 940, $pDisabled, 1);
$tInactive  = $tile('DT inactive-tile',    950, null,       0);
$tExtra     = $tile('DT extra',            960, null,       1);

$pickTile = $pdo->prepare('INSERT INTO dashboard_user_apps (user_id, app_id) VALUES (?, ?)');
$pickTile->execute([$guestId, $tRoleGated]);
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
//  Visibility rules (carried over)
// ------------------------------------------------------------------

echo "dashboard-controller visibility + layout rules\n";

$res = request('GET', API);
check('anonymous GET is rejected with 401', $res['status'] === 401, "got {$res['status']}");
$res = request('POST', API, null, ['name' => 'DT hacked', 'url' => '/views/botaniq/']);
check('anonymous POST is rejected with 401', $res['status'] === 401, "got {$res['status']}");

$res = request('GET', API, $GUEST_SID);
check('guest GET succeeds', $res['status'] === 200, "got {$res['status']}");
$names = appNames($res['body']);
check('shelf payload has folders + apps arrays', is_array(shelfFolders($res['body'])) && is_array(shelfApps($res['body'])));
check('picked tile of a project the guest holds a role in is on the shelf', in_array('DT role-gated', $names, true));
check('permitted but unpicked tile stays off the shelf', !in_array('DT everyone', $names, true));
check('picked tile of a project without a role lies dormant', !in_array('DT no-role', $names, true));
check('picked tile of a disabled project lies dormant', !in_array('DT disabled-project', $names, true));
check('picked inactive tile is hidden from guest', !in_array('DT inactive-tile', $names, true));

$tileRow = appByName($res['body'], 'DT role-gated');
check(
    'shelf tile exposes id/name/icon/gradient/url/folder_id/position',
    $tileRow !== null && array_keys($tileRow) === ['id', 'name', 'icon', 'gradient', 'url', 'folder_id', 'position'],
    $tileRow !== null ? implode(',', array_keys($tileRow)) : 'tile missing'
);

// ------------------------------------------------------------------
//  Shelf add/remove (carried over) + end-of-root landing position
// ------------------------------------------------------------------

$res = request('POST', API . '?shelf=1', $GUEST_SID, ['app_id' => $tEveryone]);
check('guest adds a permitted tile to their shelf', $res['status'] === 201, "got {$res['status']}");
$res = request('GET', API, $GUEST_SID);
$added = appByName($res['body'], 'DT everyone');
check('added tile now renders on the shelf', $added !== null);
$maxOther = 0;
foreach (shelfApps($res['body']) as $a) {
    if ($a['name'] !== 'DT everyone' && $a['folder_id'] === null) $maxOther = max($maxOther, (int) $a['position']);
}
check('a freshly picked tile lands at the end of the root grid',
    $added !== null && (int) $added['position'] >= $maxOther, "pos={$added['position']} max=$maxOther");

$res = request('POST', API . '?shelf=1', $GUEST_SID, ['app_id' => $tNoRole]);
check('adding a tile without the project role is refused with 403', $res['status'] === 403, "got {$res['status']}");
$res = request('POST', API . '?shelf=1', $GUEST_SID, ['app_id' => 99999999]);
check('adding an unknown tile is a 404', $res['status'] === 404, "got {$res['status']}");
$res = request('DELETE', API . '?shelf=1&app_id=' . $tEveryone, $GUEST_SID);
check('guest removes a tile from their shelf', $res['status'] === 200, "got {$res['status']}");
$res = request('DELETE', API . '?shelf=1&app_id=' . $tEveryone, $GUEST_SID);
check('removing a tile not on the shelf is a 404', $res['status'] === 404, "got {$res['status']}");

// ------------------------------------------------------------------
//  Layout save (PUT ?layout=1)
// ------------------------------------------------------------------

$res = request('PUT', API . '?layout=1', null, ['folders' => [], 'apps' => []]);
check('anonymous layout PUT is rejected with 401', $res['status'] === 401, "got {$res['status']}");

// Re-add DT everyone so the guest has two visible root apps to arrange.
request('POST', API . '?shelf=1', $GUEST_SID, ['app_id' => $tEveryone]);
$res = request('GET', API, $GUEST_SID);
$gate = appByName($res['body'], 'DT role-gated');
$every = appByName($res['body'], 'DT everyone');

// Create a folder (temp id) and file DT everyone into it.
$body = [
    'folders' => [['id' => 'new-1', 'name' => 'DTF Games', 'position' => 1]],
    'apps' => [
        ['app_id' => $gate['id'],  'folder_id' => null,    'position' => 0],
        ['app_id' => $every['id'], 'folder_id' => 'new-1', 'position' => 0],
    ],
];
$res = request('PUT', API . '?layout=1', $GUEST_SID, $body);
check('layout PUT succeeds', $res['status'] === 200, "got {$res['status']}");
$created = is_array($res['body']) ? ($res['body']['created'] ?? null) : null;
$newFolderId = is_array($created) && isset($created['new-1']) ? (int) $created['new-1'] : 0;
check('response maps the temp folder id to a real id', $newFolderId > 0, json_encode($created));
$folderRow = null;
foreach (shelfFolders($res['body']) as $f) {
    if ((int) $f['id'] === $newFolderId) $folderRow = $f;
}
check('the new folder is in the returned shelf', $folderRow !== null && $folderRow['name'] === 'DTF Games');
$everyAfter = appByName($res['body'], 'DT everyone');
check('the filed app now carries the real folder id', $everyAfter !== null && (int) $everyAfter['folder_id'] === $newFolderId,
    json_encode($everyAfter));

// Rename + reposition the folder.
$res = request('PUT', API . '?layout=1', $GUEST_SID, [
    'folders' => [['id' => $newFolderId, 'name' => 'DTF Renamed', 'position' => 0]],
    'apps' => [
        ['app_id' => $every['id'], 'folder_id' => $newFolderId, 'position' => 0],
        ['app_id' => $gate['id'],  'folder_id' => null,         'position' => 1],
    ],
]);
$folderRow = null;
foreach (shelfFolders($res['body']) as $f) {
    if ((int) $f['id'] === $newFolderId) $folderRow = $f;
}
check('folder rename round-trips', $folderRow !== null && $folderRow['name'] === 'DTF Renamed');
check('folder reposition round-trips', $folderRow !== null && (int) $folderRow['position'] === 0);
$gateAfter = appByName($res['body'], 'DT role-gated');
check('root app reposition round-trips', $gateAfter !== null && (int) $gateAfter['position'] === 1);

// Cross-user folder reference is refused.
$pdo->prepare('INSERT INTO dashboard_folders (user_id, name, position) VALUES (?, ?, ?)')
    ->execute([$adminId, 'DTF Admin', 0]);
$adminFolderId = (int) $pdo->lastInsertId();
$res = request('PUT', API . '?layout=1', $GUEST_SID, [
    'folders' => [],
    'apps' => [['app_id' => $gate['id'], 'folder_id' => $adminFolderId, 'position' => 0]],
]);
check('filing into another user\'s folder is a 400', $res['status'] === 400, "got {$res['status']}");
$res = request('GET', API, $GUEST_SID);
$foreignVisible = false;
foreach (shelfFolders($res['body']) as $f) {
    if ((int) $f['id'] === $adminFolderId) $foreignVisible = true;
}
check('another user\'s folder never appears in the shelf', !$foreignVisible);

// A layout PUT that names an app not on the shelf is ignored (no error).
$res = request('PUT', API . '?layout=1', $GUEST_SID, [
    'folders' => [],
    'apps' => [['app_id' => $tExtra, 'folder_id' => null, 'position' => 0]], // tExtra not picked
]);
check('layout PUT ignoring a non-shelf app still succeeds', $res['status'] === 200, "got {$res['status']}");
check('the ignored app is not silently added to the shelf', appByName($res['body'], 'DT extra') === null);

// Validation.
$res = request('PUT', API . '?layout=1', $GUEST_SID, [
    'folders' => [['id' => 'new-x', 'name' => '   ', 'position' => 0]],
    'apps' => [],
]);
check('a blank folder name is a 400', $res['status'] === 400, "got {$res['status']}");
$res = request('PUT', API . '?layout=1', $GUEST_SID, [
    'folders' => array_fill(0, 101, ['id' => 'n', 'name' => 'X', 'position' => 0]),
    'apps' => [],
]);
check('an over-large folder array is a 400', $res['status'] === 400, "got {$res['status']}");

// Dissolve on empty vs. survival with a dormant member.
$pdo->prepare('INSERT INTO dashboard_folders (user_id, name, position) VALUES (?, ?, ?)')
    ->execute([$guestId, 'DTF Dormant', 5]);
$dormFolder = (int) $pdo->lastInsertId();
$pdo->prepare('INSERT INTO dashboard_folders (user_id, name, position) VALUES (?, ?, ?)')
    ->execute([$guestId, 'DTF Empty', 6]);
$emptyFolder = (int) $pdo->lastInsertId();
// Put the dormant (no-role) app into the dormant folder directly.
$pdo->prepare('UPDATE dashboard_user_apps SET folder_id = ? WHERE user_id = ? AND app_id = ?')
    ->execute([$dormFolder, $guestId, $tNoRole]);

// A PUT that declares neither folder: empty one dissolves, dormant one survives.
$res = request('PUT', API . '?layout=1', $GUEST_SID, [
    'folders' => [],
    'apps' => [['app_id' => $gate['id'], 'folder_id' => null, 'position' => 0]],
]);
$exists = function (int $fid) use ($pdo): bool {
    $s = $pdo->prepare('SELECT 1 FROM dashboard_folders WHERE id = ?');
    $s->execute([$fid]);
    return $s->fetchColumn() !== false;
};
check('an empty folder omitted from the payload dissolves', !$exists($emptyFolder));
check('a folder holding a dormant member survives the dissolve', $exists($dormFolder));

// ------------------------------------------------------------------
//  Admin CRUD (carried over, trimmed)
// ------------------------------------------------------------------

$res = request('GET', API . '?all=1', $GUEST_SID);
check('guest cannot list all tiles (admin only)', $res['status'] === 403, "got {$res['status']}");
$res = request('POST', API, $GUEST_SID, ['name' => 'DT hacked', 'url' => '/views/botaniq/']);
check('guest POST is rejected with 403', $res['status'] === 403, "got {$res['status']}");

$res = request('GET', API . '?all=1', $ADMIN_SID);
$allNames = array_map(fn ($t) => $t['name'], $res['body'] ?? []);
check('admin dashboard list succeeds', $res['status'] === 200, "got {$res['status']}");
check('dashboard list includes inactive tiles', in_array('DT inactive-tile', $allNames, true));

$res = request('POST', API, $ADMIN_SID, ['name' => 'DT default-tile', 'url' => '/views/botaniq/', 'is_default' => true]);
check('admin creates a tile marked default', $res['status'] === 201, "got {$res['status']}");
$res = request('GET', API . '?all=1', $ADMIN_SID);
$dt = array_values(array_filter($res['body'] ?? [], fn ($t) => $t['name'] === 'DT default-tile'))[0] ?? null;
check('dashboard list carries is_default', $dt !== null && ($dt['is_default'] ?? null) === 1);

// ------------------------------------------------------------------
//  Default-shelf seeding (in-process)
// ------------------------------------------------------------------

require_once DOC_ROOT . '/app/services/dashboard-shelf-service.php';

// Clear any default flags left by the admin-CRUD test above, then mark exactly
// two: a gated default and an inactive default.
$pdo->exec("UPDATE dashboard_apps SET is_default = 0 WHERE name LIKE 'DT %'");
$pdo->prepare('UPDATE dashboard_apps SET is_default = 1 WHERE id IN (?, ?)')
    ->execute([$tRoleGated, $tInactive]);

$pdo->exec("INSERT INTO users (email, display_name) VALUES ('dashtest-seed@test.local', 'DT Seed')");
$seedUserId = (int) $pdo->lastInsertId();

seedDefaultDashboardApps($pdo, $seedUserId);
$stmt = $pdo->prepare(
    'SELECT s.app_id FROM dashboard_user_apps s JOIN dashboard_apps h ON h.id = s.app_id
     WHERE s.user_id = ? AND h.name LIKE ?'
);
$stmt->execute([$seedUserId, 'DT %']);
$seeded = array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN));
sort($seeded);
check('new user is seeded with every default tile, even gated or inactive ones',
    $seeded === [min($tRoleGated, $tInactive), max($tRoleGated, $tInactive)], json_encode($seeded));
check('non-default tiles are not seeded', !in_array($tEveryone, $seeded, true));

seedDefaultDashboardApps($pdo, $seedUserId);
$stmt->execute([$seedUserId, 'DT %']);
check('seeding is idempotent', count($stmt->fetchAll()) === 2);

// ------------------------------------------------------------------

echo "\n$passed passed, $failed failed\n";
exit($failed === 0 ? 0 : 1);
