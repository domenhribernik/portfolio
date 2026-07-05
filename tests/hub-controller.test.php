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
// Run: /opt/lampp/bin/php tests/hub-controller.test.php

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

$mkRole = $pdo->prepare('INSERT INTO user_project_roles (user_id, project_id, role) VALUES (?, ?, ?)');
$mkRole->execute([$guestId, $pRole, 'member']);
$mkRole->execute([$guestId, $pDisabled, 'member']); // role on disabled project must NOT count

$mkTile = $pdo->prepare('INSERT INTO hub_apps (name, url, sort_order, project_id, active) VALUES (?, ?, ?, ?, ?)');
$mkTile->execute(['HT role-gated',       '/views/botaniq/', 910, $pRole,     1]);
$mkTile->execute(['HT no-role',          '/views/botaniq/', 920, $pNoRole,   1]);
$mkTile->execute(['HT everyone',         '/views/botaniq/', 930, null,       1]);
$mkTile->execute(['HT disabled-project', '/views/botaniq/', 940, $pDisabled, 1]);
$mkTile->execute(['HT inactive-tile',    '/views/botaniq/', 950, null,       0]);

// ------------------------------------------------------------------
//  Server lifecycle
// ------------------------------------------------------------------

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

// Guest (regular signed-in user)
$res = request('GET', API, $GUEST_SID);
check('guest GET succeeds', $res['status'] === 200, "got {$res['status']}");
$names = tileNames($res['body']);
check('guest sees tile of project they hold a role in', in_array('HT role-gated', $names, true));
check('guest sees tile with no project (everyone)', in_array('HT everyone', $names, true));
check('guest does not see tile of project without a role', !in_array('HT no-role', $names, true));
check('role on a disabled project does not count', !in_array('HT disabled-project', $names, true));
check('inactive tile is hidden from guest', !in_array('HT inactive-tile', $names, true));

$tile = array_values(array_filter($res['body'] ?? [], fn ($t) => $t['name'] === 'HT everyone'))[0] ?? null;
check(
    'launcher payload exposes only id/name/icon/gradient/url',
    $tile !== null && array_keys($tile) === ['id', 'name', 'icon', 'gradient', 'url'],
    $tile !== null ? implode(',', array_keys($tile)) : 'tile missing'
);

$res = request('GET', API . '?all=1', $GUEST_SID);
check('guest cannot list all tiles (admin only)', $res['status'] === 403, "got {$res['status']}");

$res = request('POST', API, $GUEST_SID, ['name' => 'HT hacked', 'url' => '/views/botaniq/']);
check('guest POST is rejected with 403', $res['status'] === 403, "got {$res['status']}");

// Admin
$res = request('GET', API, $ADMIN_SID);
$names = tileNames($res['body']);
check('admin GET succeeds', $res['status'] === 200, "got {$res['status']}");
check('admin sees role-gated tile without holding the role', in_array('HT no-role', $names, true));
check('admin sees tile of disabled project', in_array('HT disabled-project', $names, true));
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

// ------------------------------------------------------------------

echo "\n$passed passed, $failed failed\n";
exit($failed === 0 ? 0 : 1);
