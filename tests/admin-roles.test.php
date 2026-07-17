<?php
declare(strict_types=1);

// Integration tests for admin-controller.php roles: the "All users" bulk
// grant (user_id: "all") that gives every existing active user a role in a
// project without touching roles they already hold.
//
// Runs ONLY against the local scratch DB (127.0.0.1/portfolio): the DB_* env
// overrides below make database.php skip loading app/.env, which points at
// the remote production database. Never run these against prod.
//
// Requires the seeded test users in the local DB:
//   admin@test.local  session token = 64 x 'a'
//   guest@test.local  session token = 64 x 'b'
//
// Run: /opt/lampp/bin/php tests/admin-roles.test.php   (Linux)
//      C:\xampp\php\php.exe tests\admin-roles.test.php (Windows)

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
const PORT     = 8932;
const API      = 'http://' . HOST . ':' . PORT . '/app/controllers/admin-controller.php';

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

// ------------------------------------------------------------------
//  Fixtures (all keys/emails prefixed so teardown can never touch real rows)
// ------------------------------------------------------------------

$pdo = new PDO(DB_DSN, DB_USER, DB_PASS, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);

function teardown(PDO $pdo): void
{
    $pdo->exec("DELETE r FROM user_project_roles r
                JOIN projects p ON p.id = r.project_id
                WHERE p.project_key LIKE 'roletest\\_%'");
    $pdo->exec("DELETE FROM projects WHERE project_key LIKE 'roletest\\_%'");
    $pdo->exec("DELETE FROM users WHERE email LIKE 'roletest-%@test.local'");
}

teardown($pdo); // clean leftovers from a crashed previous run

$guestId = (int) $pdo->query("SELECT id FROM users WHERE email = 'guest@test.local'")->fetchColumn();
$adminId = (int) $pdo->query("SELECT id FROM users WHERE email = 'admin@test.local'")->fetchColumn();
if ($guestId === 0 || $adminId === 0) {
    fwrite(STDERR, "Missing admin/guest fixture users in local DB\n");
    exit(1);
}

$pdo->exec("INSERT INTO users (email, display_name, is_active) VALUES ('roletest-inactive@test.local', 'RT Inactive', 0)");
$inactiveId = (int) $pdo->lastInsertId();

$pdo->prepare('INSERT INTO projects (project_key, name, active) VALUES (?, ?, 1)')
    ->execute(['roletest_bulk', 'RT bulk project']);
$projectId = (int) $pdo->lastInsertId();

// Guest already holds a better role; the bulk grant must NOT downgrade it.
$pdo->prepare('INSERT INTO user_project_roles (user_id, project_id, role) VALUES (?, ?, ?)')
    ->execute([$guestId, $projectId, 'editor']);

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

echo "admin-controller all-users role grant\n";

$rolesUrl = API . '?resource=roles';

// Access control
$res = request('POST', $rolesUrl, null, ['user_id' => 'all', 'project_key' => 'roletest_bulk', 'role' => 'member']);
check('anonymous bulk grant is rejected with 401', $res['status'] === 401, "got {$res['status']}");

$res = request('POST', $rolesUrl, $GUEST_SID, ['user_id' => 'all', 'project_key' => 'roletest_bulk', 'role' => 'member']);
check('non-admin bulk grant is rejected with 403', $res['status'] === 403, "got {$res['status']}");

// Validation still applies to the bulk form
$res = request('POST', $rolesUrl, $ADMIN_SID, ['user_id' => 'all', 'project_key' => 'roletest_bulk', 'role' => 'Not A Role!']);
check('bulk grant rejects an invalid role name', $res['status'] === 400, "got {$res['status']}");

$res = request('POST', $rolesUrl, $ADMIN_SID, ['user_id' => 'all', 'project_key' => 'roletest_missing', 'role' => 'member']);
check('bulk grant on an unknown project is a 404', $res['status'] === 404, "got {$res['status']}");

// The grant itself
$expected = (int) $pdo->query(
    'SELECT COUNT(*) FROM users u
     WHERE u.is_active = 1
       AND NOT EXISTS (SELECT 1 FROM user_project_roles r
                       WHERE r.user_id = u.id AND r.project_id = ' . $projectId . ')'
)->fetchColumn();

$res = request('POST', $rolesUrl, $ADMIN_SID, ['user_id' => 'all', 'project_key' => 'roletest_bulk', 'role' => 'member']);
check('bulk grant succeeds', $res['status'] === 200, "got {$res['status']}");
check('response reports how many users were granted', ($res['body']['granted'] ?? null) === $expected,
    json_encode($res['body'] ?? null) . " expected $expected");

$role = fn (int $uid) => $pdo->query(
    "SELECT role FROM user_project_roles WHERE user_id = $uid AND project_id = $projectId"
)->fetchColumn();

check('every active user now holds a role in the project', $role($adminId) === 'member');
check('an existing role is never overwritten or downgraded', $role($guestId) === 'editor', json_encode($role($guestId)));
check('inactive users are skipped', $role($inactiveId) === false, json_encode($role($inactiveId)));

$res = request('POST', $rolesUrl, $ADMIN_SID, ['user_id' => 'all', 'project_key' => 'roletest_bulk', 'role' => 'member']);
check('a second identical bulk grant is a no-op', ($res['body']['granted'] ?? null) === 0,
    json_encode($res['body'] ?? null));

// ------------------------------------------------------------------

echo "\n$passed passed, $failed failed\n";
exit($failed === 0 ? 0 : 1);
