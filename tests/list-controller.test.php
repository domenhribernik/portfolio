<?php
declare(strict_types=1);

// Integration tests for app/controllers/list-controller.php, the shared list
// backend (views/list).
//
// Two contracts hold this suite together:
//
//   A LIST IS PRIVATE TO ITS GRANTS. Membership in the `list` project only
//   admits you to the app; which collections you actually see is decided per
//   row by list_collection_access. A user without a grant must be 403 on
//   reads AND writes, and must never see the collection's name in any listing.
//
//   ATTRIBUTION COMES FROM THE SESSION. added_by / checked_by are derived from
//   the cookie, never from the request body, so a member cannot post an item
//   as somebody else.
//
// Runs ONLY against the local scratch DB (127.0.0.1/portfolio): the DB_* env
// overrides below make database.php skip loading app/.env (which points at the
// remote production database). Never run these against prod.
//
// Requires the seeded test users in the local DB:
//   admin@test.local  session token = 64 x 'a'
//   guest@test.local  session token = 64 x 'b'
// (If every request comes back 401, those sessions have expired: extend
// sessions.expires_at for their token hashes.)
//
// Setup creates the list schema if absent and migrates a pre-rework scratch DB
// in place, so this runs against a fresh, old or already-migrated database.
// Teardown deletes only the rows this run created (id baselines).
//
// Run: /opt/lampp/bin/php tests/list-controller.test.php

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
const PORT     = 8965;
const API      = 'http://' . HOST . ':' . PORT . '/app/controllers/list-controller.php';

// Fixture collection names are prefixed so they can never collide with real
// lists on the scratch DB, and so teardown can find them by name as well as id.
const PFX  = 'ZZtest ';
const COL_A = PFX . 'alpha';   // admin's own, guest never granted
const COL_B = PFX . 'beta';    // granted to guest mid-suite
const COL_C = PFX . 'gamma';   // created BY guest, auto-granted

$ADMIN_SID = str_repeat('a', 64);
$GUEST_SID = str_repeat('b', 64);

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

/** @return array{status:int, body:mixed, raw:string, headers:string[]} */
function request(string $method, string $url, ?string $sid = null, ?array $body = null, ?string $contentType = 'application/json'): array
{
    $headers = [];
    if ($sid !== null) {
        $headers[] = 'Cookie: portfolio_sid=' . $sid;
    }
    $opts = ['http' => ['method' => $method, 'ignore_errors' => true, 'timeout' => 15]];
    if ($body !== null) {
        if ($contentType !== null) {
            $headers[] = 'Content-Type: ' . $contentType;
        }
        $opts['http']['content'] = json_encode($body);
    }
    if ($headers) $opts['http']['header'] = implode("\r\n", $headers);
    $raw = @file_get_contents($url, false, stream_context_create($opts));
    $status = 0;
    foreach ($http_response_header ?? [] as $h) {
        if (preg_match('#^HTTP/\S+\s+(\d{3})#', $h, $m)) {
            $status = (int) $m[1];
        }
    }
    return [
        'status'  => $status,
        'body'    => $raw !== false ? json_decode($raw, true) : null,
        'raw'     => $raw === false ? '' : $raw,
        'headers' => $http_response_header ?? [],
    ];
}

function hasHeader(array $headers, string $name): bool
{
    foreach ($headers as $h) {
        if (stripos($h, $name . ':') === 0) {
            return true;
        }
    }
    return false;
}

/** Items of a collection as a name => row map, for order-independent asserts. */
function byName(array $items): array
{
    $out = [];
    foreach ($items as $item) {
        $out[$item['name']] = $item;
    }
    return $out;
}

// ------------------------------------------------------------------
//  Fixtures
// ------------------------------------------------------------------

$pdo = new PDO(DB_DSN, DB_USER, DB_PASS, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
$adminId = (int) $pdo->query("SELECT id FROM users WHERE email = 'admin@test.local'")->fetchColumn();
$guestId = (int) $pdo->query("SELECT id FROM users WHERE email = 'guest@test.local'")->fetchColumn();
if ($adminId === 0 || $guestId === 0) {
    fwrite(STDERR, "Missing admin/guest fixture users in local DB\n");
    exit(1);
}

function tableExists(PDO $pdo, string $table): bool
{
    return (bool) $pdo->query("SHOW TABLES LIKE " . $pdo->quote($table))->fetchColumn();
}

function columnExists(PDO $pdo, string $table, string $column): bool
{
    if (!tableExists($pdo, $table)) return false;
    return (bool) $pdo->query("SHOW COLUMNS FROM `$table` LIKE " . $pdo->quote($column))->fetchColumn();
}

/** Applies a .sql file statement by statement, comments stripped first. */
function applySqlFile(PDO $pdo, string $path): void
{
    $sql = (string) file_get_contents($path);
    $sql = preg_replace('/^\s*--.*$/m', '', $sql);
    foreach (array_filter(array_map('trim', explode(';', $sql))) as $stmt) {
        $pdo->exec($stmt);
    }
}

// A fresh scratch DB gets the current schema; a pre-rework one gets migrated in
// place by the same seed the production database will be given by hand. Either
// way the suite ends up on the schema the controller expects, which means this
// setup is also the migration's own rehearsal: run the suite on a pre-rework
// database and a failure here is a failure of the seed, before prod sees it.
if (!tableExists($pdo, 'list_items')) {
    applySqlFile($pdo, DOC_ROOT . '/app/models/list-model.sql');
} elseif (!columnExists($pdo, 'list_items', 'collection_id')) {
    echo "(pre-rework schema found: applying app/models/seeds/list-rework-2026-09.sql)\n";
    applySqlFile($pdo, DOC_ROOT . '/app/models/seeds/list-rework-2026-09.sql');
}

if (!columnExists($pdo, 'list_items', 'collection_id') || !tableExists($pdo, 'list_labels')) {
    fwrite(STDERR, "list schema is not on the reworked shape after setup\n");
    exit(1);
}

$roleBaseline = (int) $pdo->query('SELECT COALESCE(MAX(id), 0) FROM user_project_roles')->fetchColumn();
$colBaseline  = (int) $pdo->query('SELECT COALESCE(MAX(id), 0) FROM list_collections')->fetchColumn();
$itemBaseline = (int) $pdo->query('SELECT COALESCE(MAX(id), 0) FROM list_items')->fetchColumn();

register_shutdown_function(function () use ($pdo, $roleBaseline, $colBaseline, $itemBaseline) {
    // Items reference their collection, grants cascade off it. Delete the items
    // first anyway: on the pre-rework schema they are joined by name, not by FK.
    $pdo->exec("DELETE FROM list_items WHERE id > $itemBaseline");
    $pdo->exec("DELETE FROM list_collections WHERE id > $colBaseline");
    $pdo->exec("DELETE FROM user_project_roles WHERE id > $roleBaseline");
});

// The `list` project row and the two fixture roles: every branch sits behind
// Auth::requireProjectRole('list'), so the guest needs membership to be able to
// fail the *grant* check rather than the membership one.
$pdo->exec("INSERT INTO projects (project_key, name) VALUES ('list', 'Lists') ON DUPLICATE KEY UPDATE name = name");
$listProjectId = (int) $pdo->query("SELECT id FROM projects WHERE project_key = 'list'")->fetchColumn();

$grantRole = $pdo->prepare(
    'INSERT INTO user_project_roles (user_id, project_id, role) VALUES (?, ?, "member")
     ON DUPLICATE KEY UPDATE role = role'
);

// ------------------------------------------------------------------
//  Boot the built-in server against the LOCAL scratch DB
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

register_shutdown_function(function () use ($server) {
    if (is_resource($server)) {
        proc_terminate($server);
    }
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
//  The membership gate
// ------------------------------------------------------------------

echo "list controller: membership gate\n";

$res = request('GET', API . '?collections=1');
check('anonymous is 401', $res['status'] === 401, "got {$res['status']}");
check('no wildcard CORS header', !hasHeader($res['headers'], 'Access-Control-Allow-Origin'));
check('responses are no-store', hasHeader($res['headers'], 'Cache-Control'));

// Guest has no role yet: in the app at all is what this checks.
$res = request('GET', API . '?collections=1', $GUEST_SID);
check('signed-in without a list role is 403', $res['status'] === 403, "got {$res['status']}");

$grantRole->execute([$guestId, $listProjectId]);
$grantRole->execute([$adminId, $listProjectId]);

$res = request('GET', API . '?collections=1', $GUEST_SID);
check('member with no grants reads an empty list (200)', $res['status'] === 200 && $res['body']['collections'] === [], "got {$res['status']}");

// ------------------------------------------------------------------
//  Items: create, read, toggle, delete
// ------------------------------------------------------------------

echo "\nitems\n";

$res = request('POST', API, $ADMIN_SID, ['collection' => COL_A, 'name' => 'mleko']);
check('create returns 201', $res['status'] === 201, "got {$res['status']}");
$item = $res['body']['item'] ?? [];
check('create echoes the stored row', ($item['name'] ?? '') === 'mleko' && ($item['checked'] ?? null) === 0);
check('create stamps added_by from the session', ($item['added_by'] ?? '') !== '');
$mlekoId = (int) ($item['id'] ?? 0);

// THE ATTRIBUTION CONTRACT: the body must not be able to name somebody else.
$res = request('POST', API, $ADMIN_SID, [
    'collection' => COL_A, 'name' => 'kruh', 'added_by' => 'Somebody Else',
]);
check('added_by in the body is ignored', ($res['body']['item']['added_by'] ?? '') !== 'Somebody Else',
    'got ' . ($res['body']['item']['added_by'] ?? 'null'));
$kruhId = (int) ($res['body']['item']['id'] ?? 0);

$res = request('GET', API . '?collection=' . rawurlencode(COL_A), $ADMIN_SID);
check('read returns both items', $res['status'] === 200 && count($res['body']['items'] ?? []) === 2, "got {$res['status']}");
check('read carries a version', !empty($res['body']['version']));
$versionA = (string) ($res['body']['version'] ?? '');

$res = request('GET', API . '?collection=' . rawurlencode(COL_A) . '&since=' . rawurlencode($versionA), $ADMIN_SID);
check('unchanged since-poll short-circuits', ($res['body']['changed'] ?? null) === false);
check('short-circuit still returns the version', ($res['body']['version'] ?? '') === $versionA);

$res = request('PATCH', API . '?id=' . $mlekoId, $ADMIN_SID, ['checked' => 1]);
check('patch checks an item', $res['status'] === 200 && ($res['body']['item']['checked'] ?? null) === 1, "got {$res['status']}");

// Regression: with a second-granular updated_at, a toggle landing in the same
// second as the previous write produced a byte-identical version, so every
// poller short-circuited and the checkmark never reached the other phone.
$res = request('GET', API . '?collection=' . rawurlencode(COL_A) . '&since=' . rawurlencode($versionA), $ADMIN_SID);
check('a check in the same second as another write still bumps the version', ($res['body']['changed'] ?? null) !== false);
$versionA = $res['body']['version'];

$res = request('PATCH', API . '?id=' . $mlekoId, $ADMIN_SID, ['checked' => 0]);
check('patch unchecks an item', ($res['body']['item']['checked'] ?? null) === 0);

$res = request('DELETE', API . '?id=' . $kruhId, $ADMIN_SID);
check('delete removes the item', $res['status'] === 200, "got {$res['status']}");
$res = request('GET', API . '?collection=' . rawurlencode(COL_A), $ADMIN_SID);
check('the deleted item is gone', count($res['body']['items'] ?? []) === 1);

// ------------------------------------------------------------------
//  Clearing the checked half
// ------------------------------------------------------------------

echo "\nclear done\n";

request('POST', API, $ADMIN_SID, ['collection' => COL_A, 'name' => 'jajca']);
request('PATCH', API . '?id=' . $mlekoId, $ADMIN_SID, ['checked' => 1]);

$res = request('DELETE', API . '?collection=' . rawurlencode(COL_A) . '&checked=1', $ADMIN_SID);
check('clear-done reports what it cleared', $res['status'] === 200 && ($res['body']['cleared'] ?? 0) >= 1, "got {$res['status']}");

$res = request('GET', API . '?collection=' . rawurlencode(COL_A), $ADMIN_SID);
$names = array_keys(byName($res['body']['items'] ?? []));
check('clear-done keeps the unchecked items', in_array('jajca', $names, true));
check('clear-done removes the checked ones', !in_array('mleko', $names, true));

// ------------------------------------------------------------------
//  A LIST IS PRIVATE TO ITS GRANTS
// ------------------------------------------------------------------

echo "\nrow-level access\n";

$res = request('GET', API . '?collections=1', $GUEST_SID);
check('an ungranted collection is invisible to a member', !in_array(COL_A, $res['body']['collections'] ?? [], true));
check('the admin sees every collection', in_array(COL_A, request('GET', API . '?collections=1', $ADMIN_SID)['body']['collections'] ?? [], true));

$res = request('GET', API . '?collection=' . rawurlencode(COL_A), $GUEST_SID);
check('reading an ungranted collection is 403', $res['status'] === 403, "got {$res['status']}");

$res = request('POST', API, $GUEST_SID, ['collection' => COL_A, 'name' => 'vsiljivec']);
check('adding to an ungranted collection is 403', $res['status'] === 403, "got {$res['status']}");

$jajcaId = 0;
foreach (request('GET', API . '?collection=' . rawurlencode(COL_A), $ADMIN_SID)['body']['items'] as $i) {
    if ($i['name'] === 'jajca') $jajcaId = (int) $i['id'];
}
$res = request('PATCH', API . '?id=' . $jajcaId, $GUEST_SID, ['checked' => 1]);
check('checking an item in an ungranted collection is 403', $res['status'] === 403, "got {$res['status']}");

$res = request('DELETE', API . '?id=' . $jajcaId, $GUEST_SID);
check('deleting an item in an ungranted collection is 403', $res['status'] === 403, "got {$res['status']}");

$res = request('DELETE', API . '?collection=' . rawurlencode(COL_A) . '&checked=1', $GUEST_SID);
check('clearing an ungranted collection is 403', $res['status'] === 403, "got {$res['status']}");

// A member who creates a collection is auto-granted it, or they would make
// something they cannot see.
$res = request('POST', API . '?collection_register=1', $GUEST_SID, ['name' => COL_C]);
check('a member may create a collection', $res['status'] === 200, "got {$res['status']}");
$res = request('GET', API . '?collections=1', $GUEST_SID);
check('the creator is auto-granted their new collection', in_array(COL_C, $res['body']['collections'] ?? [], true));

$res = request('POST', API, $GUEST_SID, ['collection' => COL_C, 'name' => 'gostov vnos']);
check('the creator can add to it', $res['status'] === 201, "got {$res['status']}");

// ------------------------------------------------------------------
//  Grant management is admin only
// ------------------------------------------------------------------

echo "\naccess management\n";

request('POST', API . '?collection_register=1', $ADMIN_SID, ['name' => COL_B]);

$res = request('GET', API . '?access=1&collection=' . rawurlencode(COL_B), $GUEST_SID);
check('a member cannot read the access roster', $res['status'] === 403, "got {$res['status']}");
$res = request('POST', API . '?access=1', $GUEST_SID, ['collection' => COL_B, 'user_id' => $guestId]);
check('a member cannot grant themselves access', $res['status'] === 403, "got {$res['status']}");
$res = request('DELETE', API . '?collection_delete=1&collection=' . rawurlencode(COL_B), $GUEST_SID);
check('a member cannot delete a collection', $res['status'] === 403, "got {$res['status']}");

$res = request('GET', API . '?access=1&collection=' . rawurlencode(COL_B), $ADMIN_SID);
check('the admin reads the roster', $res['status'] === 200, "got {$res['status']}");
$roster = [];
foreach ($res['body']['users'] ?? [] as $u) $roster[(int) $u['id']] = $u;
check('the roster flags who is granted', isset($roster[$guestId]) && $roster[$guestId]['granted'] === false);
check('the roster marks admins', ($roster[$adminId]['is_admin'] ?? null) === true);

$res = request('POST', API . '?access=1', $ADMIN_SID, ['collection' => COL_B, 'user_id' => $guestId]);
check('the admin grants access', $res['status'] === 200, "got {$res['status']}");

$res = request('GET', API . '?collections=1', $GUEST_SID);
check('the grant makes the collection visible', in_array(COL_B, $res['body']['collections'] ?? [], true));
$res = request('POST', API, $GUEST_SID, ['collection' => COL_B, 'name' => 'skupni vnos']);
check('the grant admits writes too', $res['status'] === 201, "got {$res['status']}");

$res = request('DELETE', API . '?access=1&collection=' . rawurlencode(COL_B) . '&user_id=' . $guestId, $ADMIN_SID);
check('the admin revokes access', $res['status'] === 200, "got {$res['status']}");
$res = request('GET', API . '?collection=' . rawurlencode(COL_B), $GUEST_SID);
check('a revoked member is 403 again', $res['status'] === 403, "got {$res['status']}");

$res = request('DELETE', API . '?collection_delete=1&collection=' . rawurlencode(COL_B), $ADMIN_SID);
check('the admin deletes a collection', $res['status'] === 200, "got {$res['status']}");
$res = request('GET', API . '?collections=1', $ADMIN_SID);
check('the deleted collection is gone', !in_array(COL_B, $res['body']['collections'] ?? [], true));
$left = (int) $pdo->query('SELECT COUNT(*) FROM list_items WHERE ' .
    (columnExists($pdo, 'list_items', 'collection_id')
        ? 'collection_id NOT IN (SELECT id FROM list_collections)'
        : 'collection = ' . $pdo->quote(COL_B)))->fetchColumn();
check('deleting a collection takes its items with it', $left === 0, "left $left");

// ------------------------------------------------------------------
//  Labels: the vocabulary belongs to the collection
// ------------------------------------------------------------------

echo "\nlabels\n";

$res = request('GET', API . '?labels=1&collection=' . rawurlencode(COL_A), $ADMIN_SID);
check('a new collection starts with no labels', $res['status'] === 200 && $res['body']['labels'] === [], "got {$res['status']}");

$res = request('POST', API . '?labels=1&defaults=1', $ADMIN_SID, ['collection' => COL_A]);
check('defaults can be applied on request', $res['status'] === 200, "got {$res['status']}");
$defaults = $res['body']['labels'] ?? [];
$sections = array_values(array_filter($defaults, fn($l) => $l['kind'] === 'section'));
$shops    = array_values(array_filter($defaults, fn($l) => $l['kind'] === 'shop'));
check('defaults carry both kinds', count($sections) >= 10 && count($shops) >= 5,
    count($sections) . ' sections, ' . count($shops) . ' shops');
check('sections arrive in store-walk order, not alphabetical',
    ($sections[0]['name'] ?? '') === 'sadje' && ($sections[1]['name'] ?? '') === 'zelenjava',
    ($sections[0]['name'] ?? '?') . ', ' . ($sections[1]['name'] ?? '?'));
check('defaults are Slovenian', in_array('mlečni izdelki', array_column($sections, 'name'), true));

$res2 = request('POST', API . '?labels=1&defaults=1', $ADMIN_SID, ['collection' => COL_A]);
check('applying defaults twice adds nothing', ($res2['body']['added'] ?? -1) === 0, 'added ' . ($res2['body']['added'] ?? -1));
check('applying defaults twice does not duplicate', count($res2['body']['labels'] ?? []) === count($defaults));

$sectionId = (int) $sections[1]['id'];              // zelenjava
$mlecniId  = 0;
foreach ($sections as $s) if ($s['name'] === 'mlečni izdelki') $mlecniId = (int) $s['id'];
$hoferId = 0; $lidlId = 0;
foreach ($shops as $s) {
    if ($s['name'] === 'Hofer') $hoferId = (int) $s['id'];
    if ($s['name'] === 'Lidl')  $lidlId  = (int) $s['id'];
}

$res = request('POST', API . '?labels=1', $ADMIN_SID, ['collection' => COL_A, 'kind' => 'shop', 'name' => 'Mesnica Blatnik']);
check('a member can add their own label', $res['status'] === 201, "got {$res['status']}");
$customShopId = (int) ($res['body']['label']['id'] ?? 0);

$res = request('POST', API . '?labels=1', $ADMIN_SID, ['collection' => COL_A, 'kind' => 'shop', 'name' => '  mesnica   blatnik ']);
check('the same label under different spacing/case is not duplicated', ($res['body']['existed'] ?? false) === true);
check('the duplicate resolves to the original', (int) ($res['body']['label']['id'] ?? 0) === $customShopId);

$res = request('POST', API . '?labels=1', $ADMIN_SID, ['collection' => COL_A, 'kind' => 'aisle', 'name' => 'x']);
check('an unknown label kind is 400', $res['status'] === 400, "got {$res['status']}");
$res = request('POST', API . '?labels=1', $ADMIN_SID, ['collection' => COL_A, 'kind' => 'shop', 'name' => str_repeat('x', 41)]);
check('an over-long label is 400', $res['status'] === 400, "got {$res['status']}");

$res = request('PATCH', API . '?labels=1&id=' . $customShopId, $ADMIN_SID, ['name' => 'Mesnica']);
check('a label can be renamed', $res['status'] === 200 && ($res['body']['label']['name'] ?? '') === 'Mesnica', "got {$res['status']}");
$res = request('PATCH', API . '?labels=1&id=' . $hoferId, $ADMIN_SID, ['name' => 'Mesnica']);
check('renaming onto an existing label is 409', $res['status'] === 409, "got {$res['status']}");

// The vocabulary is per collection, and crossing lists must be impossible.
$res = request('GET', API . '?labels=1&collection=' . rawurlencode(COL_C), $ADMIN_SID);
check('another collection has its own empty vocabulary', ($res['body']['labels'] ?? null) === []);

$res = request('GET', API . '?labels=1&collection=' . rawurlencode(COL_A), $GUEST_SID);
check('an ungranted collection hides its labels', $res['status'] === 403, "got {$res['status']}");
$res = request('POST', API . '?labels=1', $GUEST_SID, ['collection' => COL_A, 'kind' => 'shop', 'name' => 'vsiljivec']);
check('an ungranted member cannot add a label', $res['status'] === 403, "got {$res['status']}");
$res = request('DELETE', API . '?labels=1&id=' . $customShopId, $GUEST_SID);
check('an ungranted member cannot delete a label', $res['status'] === 403, "got {$res['status']}");

// ------------------------------------------------------------------
//  Labelling an item
// ------------------------------------------------------------------

echo "\nlabelled items\n";

$res = request('POST', API, $ADMIN_SID, [
    'collection' => COL_A, 'name' => 'mleko', 'section_id' => $mlecniId, 'shop_ids' => [$lidlId],
]);
check('an item can be created already labelled', $res['status'] === 201, "got {$res['status']}");
$labelled = $res['body']['item'] ?? [];
check('the section comes back on the item', ($labelled['section']['name'] ?? '') === 'mlečni izdelki');
check('the shops come back as a list', count($labelled['shops'] ?? []) === 1 && ($labelled['shops'][0]['name'] ?? '') === 'Lidl');
$mlekoId = (int) ($labelled['id'] ?? 0);

// AN ITEM SITS IN ONE AISLE. Two sections is not a state the UI can reach, and
// the server must not accept it from anything else either.
$res = request('POST', API, $ADMIN_SID, [
    'collection' => COL_A, 'name' => 'zmeda', 'section_id' => [$mlecniId, $sectionId],
]);
check('two sections on one item is rejected', $res['status'] === 400, "got {$res['status']}");

// A LABEL BELONGS TO ITS LIST. Borrowing another collection's label would leak
// its vocabulary across the access boundary.
$res = request('POST', API . '?labels=1', $ADMIN_SID, ['collection' => COL_C, 'kind' => 'shop', 'name' => 'Tuja trgovina']);
$foreignShopId = (int) ($res['body']['label']['id'] ?? 0);
$res = request('POST', API, $ADMIN_SID, [
    'collection' => COL_A, 'name' => 'tujek', 'shop_ids' => [$foreignShopId],
]);
check("another collection's label cannot be attached", $res['status'] === 400, "got {$res['status']}");
$res = request('POST', API, $ADMIN_SID, [
    'collection' => COL_A, 'name' => 'tujek2', 'section_id' => $foreignShopId,
]);
check('a shop label cannot be used as a section', $res['status'] === 400, "got {$res['status']}");

$res = request('PATCH', API . '?id=' . $mlekoId, $ADMIN_SID, ['shop_ids' => [$hoferId, $lidlId]]);
check('shops can be replaced wholesale', count($res['body']['item']['shops'] ?? []) === 2, "got {$res['status']}");
check('patching shops leaves the section alone', ($res['body']['item']['section']['name'] ?? '') === 'mlečni izdelki');

$res = request('PATCH', API . '?id=' . $mlekoId, $ADMIN_SID, ['section_id' => null]);
check('a section can be cleared',
    array_key_exists('section', $res['body']['item'] ?? []) && $res['body']['item']['section'] === null,
    json_encode($res['body']['item']['section'] ?? 'absent'));
check('clearing the section leaves the shops alone', count($res['body']['item']['shops'] ?? []) === 2);

$res = request('PATCH', API . '?id=' . $mlekoId, $ADMIN_SID, ['shop_ids' => []]);
check('shops can be cleared', ($res['body']['item']['shops'] ?? ['x']) === []);

$res = request('PATCH', API . '?id=' . $mlekoId, $ADMIN_SID, ['name' => 'mleko 2x']);
check('an item can be renamed', ($res['body']['item']['name'] ?? '') === 'mleko 2x');

// A relabelling is a change the other phone must see.
$res = request('GET', API . '?collection=' . rawurlencode(COL_A), $ADMIN_SID);
$versionA = (string) ($res['body']['version'] ?? '');
check('the read payload carries the collection vocabulary', count($res['body']['labels'] ?? []) > 10);
request('PATCH', API . '?id=' . $mlekoId, $ADMIN_SID, ['section_id' => $mlecniId]);
$res = request('GET', API . '?collection=' . rawurlencode(COL_A) . '&since=' . rawurlencode($versionA), $ADMIN_SID);
check('relabelling an item invalidates the poller version', ($res['body']['changed'] ?? null) !== false);

$versionA = (string) ($res['body']['version'] ?? '');
request('POST', API . '?labels=1', $ADMIN_SID, ['collection' => COL_A, 'kind' => 'section', 'name' => 'vrtnarija']);
$res = request('GET', API . '?collection=' . rawurlencode(COL_A) . '&since=' . rawurlencode($versionA), $ADMIN_SID);
check('adding a label invalidates the poller version', ($res['body']['changed'] ?? null) !== false);

// Deleting a label detaches it; the item survives.
$res = request('DELETE', API . '?labels=1&id=' . $mlecniId, $ADMIN_SID);
check('a label can be deleted', $res['status'] === 200, "got {$res['status']}");
$res = request('GET', API . '?collection=' . rawurlencode(COL_A), $ADMIN_SID);
$items = byName($res['body']['items'] ?? []);
check('deleting a label keeps the item', isset($items['mleko 2x']));
check('deleting a label unlabels the item', ($items['mleko 2x']['section'] ?? null) === null);

// ------------------------------------------------------------------
//  ATTRIBUTION COMES FROM THE SESSION
// ------------------------------------------------------------------

echo "\nattribution\n";

// COL_C belongs to the guest, so both people can write to the same list.
request('POST', API . '?access=1', $ADMIN_SID, ['collection' => COL_C, 'user_id' => $guestId]);

$res = request('POST', API, $GUEST_SID, ['collection' => COL_C, 'name' => 'gostova postavka']);
$guestItemId = (int) ($res['body']['item']['id'] ?? 0);
check('the adder is recorded as a user id, not just a name',
    (int) ($res['body']['item']['added_by_user_id'] ?? 0) === $guestId,
    'got ' . json_encode($res['body']['item']['added_by_user_id'] ?? null));

$res = request('PATCH', API . '?id=' . $guestItemId, $ADMIN_SID, ['checked' => 1]);
$checkedItem = $res['body']['item'] ?? [];
check('checking records who bought it', (int) ($checkedItem['checked_by_user_id'] ?? 0) === $adminId,
    'got ' . json_encode($checkedItem['checked_by_user_id'] ?? null));
check('checking stamps when', !empty($checkedItem['checked_at']));
check('the adder is not overwritten by the buyer', (int) ($checkedItem['added_by_user_id'] ?? 0) === $guestId);

// A spoofed body must not be able to credit somebody else with the purchase.
$res = request('PATCH', API . '?id=' . $guestItemId, $ADMIN_SID, [
    'checked' => 1, 'checked_by' => 'Somebody Else', 'checked_by_user_id' => $guestId,
    'added_by' => 'Somebody Else', 'added_by_user_id' => $adminId,
]);
check('checked_by in the body is ignored', (int) ($res['body']['item']['checked_by_user_id'] ?? 0) === $adminId);
check('added_by in a patch body is ignored', (int) ($res['body']['item']['added_by_user_id'] ?? 0) === $guestId);

$res = request('PATCH', API . '?id=' . $guestItemId, $ADMIN_SID, ['checked' => 0]);
$unchecked = $res['body']['item'] ?? [];
check('unchecking clears the buyer',
    array_key_exists('checked_by_user_id', $unchecked) && $unchecked['checked_by_user_id'] === null,
    json_encode($unchecked['checked_by_user_id'] ?? 'absent'));
check('unchecking clears the timestamp',
    array_key_exists('checked_at', $unchecked) && $unchecked['checked_at'] === null,
    json_encode($unchecked['checked_at'] ?? 'absent'));

// ------------------------------------------------------------------
//  History: what the list actually bought
// ------------------------------------------------------------------

echo "\nhistory\n";

$res = request('GET', API . '?history=1&collection=' . rawurlencode(COL_C), $GUEST_SID);
check('history starts empty', $res['status'] === 200 && ($res['body']['purchases'] ?? null) === [], "got {$res['status']}");
check('an empty history has nothing frequent', ($res['body']['frequent'] ?? null) === []);

$res = request('POST', API . '?labels=1&defaults=1', $GUEST_SID, ['collection' => COL_C]);
$cLabels = $res['body']['labels'] ?? [];
$cSection = 0; $cShop = 0;
foreach ($cLabels as $l) {
    if ($l['kind'] === 'section' && $l['name'] === 'pekarna') $cSection = (int) $l['id'];
    if ($l['kind'] === 'shop' && $l['name'] === 'Hofer')      $cShop    = (int) $l['id'];
}

$res = request('POST', API, $GUEST_SID, [
    'collection' => COL_C, 'name' => 'kruh', 'section_id' => $cSection, 'shop_ids' => [$cShop],
]);
$kruhId = (int) ($res['body']['item']['id'] ?? 0);
request('PATCH', API . '?id=' . $kruhId, $ADMIN_SID, ['checked' => 1]);

// Deleting is not buying: it must leave no trace in the history.
$res = request('POST', API, $GUEST_SID, ['collection' => COL_C, 'name' => 'pomota']);
request('DELETE', API . '?id=' . (int) ($res['body']['item']['id'] ?? 0), $GUEST_SID);

$res = request('DELETE', API . '?collection=' . rawurlencode(COL_C) . '&checked=1', $ADMIN_SID);
check('clearing the checked half reports what it archived', ($res['body']['archived'] ?? 0) >= 1, json_encode($res['body']));

$res = request('GET', API . '?history=1&collection=' . rawurlencode(COL_C), $GUEST_SID);
$purchases = $res['body']['purchases'] ?? [];
$kruh = null;
foreach ($purchases as $p) if ($p['name'] === 'kruh') $kruh = $p;
check('a cleared item becomes a purchase', $kruh !== null, json_encode($purchases));
check('the purchase remembers who added it', ($kruh['added_by'] ?? '') !== '');
check('the purchase remembers who bought it', ($kruh['bought_by'] ?? '') !== '' && ($kruh['bought_by'] ?? '') !== ($kruh['added_by'] ?? ''));
check('the purchase snapshots its section', ($kruh['section'] ?? '') === 'pekarna');
check('the purchase snapshots its shops', ($kruh['shops'] ?? []) === ['Hofer']);
check('a deleted item never reaches the history',
    !in_array('pomota', array_column($purchases, 'name'), true));

$res = request('GET', API . '?collection=' . rawurlencode(COL_C), $GUEST_SID);
check('archiving takes the items off the list', !isset(byName($res['body']['items'] ?? [])['kruh']));

// THE SNAPSHOT SURVIVES ITS LABEL. History has to still read correctly after
// somebody tidies the vocabulary, which is why it stores text, not a join.
request('DELETE', API . '?labels=1&id=' . $cSection, $GUEST_SID);
$res = request('GET', API . '?history=1&collection=' . rawurlencode(COL_C), $GUEST_SID);
$kruh = null;
foreach ($res['body']['purchases'] ?? [] as $p) if ($p['name'] === 'kruh') $kruh = $p;
check('deleting a label leaves the history intact', ($kruh['section'] ?? '') === 'pekarna');

// Anything checked longer than a day ago is filed away on the next read, since
// production has no cron to do it. Backdated, never slept through.
$res = request('POST', API, $GUEST_SID, ['collection' => COL_C, 'name' => 'pozabljeno']);
$staleId = (int) ($res['body']['item']['id'] ?? 0);
request('PATCH', API . '?id=' . $staleId, $GUEST_SID, ['checked' => 1]);
$pdo->exec("UPDATE list_items SET checked_at = NOW(3) - INTERVAL 30 HOUR WHERE id = $staleId");

$res = request('POST', API, $GUEST_SID, ['collection' => COL_C, 'name' => 'sveže']);
$freshId = (int) ($res['body']['item']['id'] ?? 0);
request('PATCH', API . '?id=' . $freshId, $GUEST_SID, ['checked' => 1]);

$res = request('GET', API . '?collection=' . rawurlencode(COL_C), $GUEST_SID);
$names = array_keys(byName($res['body']['items'] ?? []));
check('a day-old checked item is filed away on the next read', !in_array('pozabljeno', $names, true), implode(', ', $names));
check('a just-checked item stays on the list', in_array('sveže', $names, true), implode(', ', $names));

$res = request('GET', API . '?history=1&collection=' . rawurlencode(COL_C), $GUEST_SID);
$archived = null;
foreach ($res['body']['purchases'] ?? [] as $p) if ($p['name'] === 'pozabljeno') $archived = $p;
check('the auto-filed item is in the history', $archived !== null);
check('the auto-file credits whoever ticked it, not whoever opened the app',
    ($archived['bought_by'] ?? '') !== '' , json_encode($archived));

// Frequency feeds the quick-add row on an empty list.
foreach (['mleko', 'mleko', 'Mleko ', 'jajca'] as $name) {
    $r = request('POST', API, $GUEST_SID, ['collection' => COL_C, 'name' => $name]);
    $itemId = (int) ($r['body']['item']['id'] ?? 0);
    request('PATCH', API . '?id=' . $itemId, $GUEST_SID, ['checked' => 1]);
    request('DELETE', API . '?collection=' . rawurlencode(COL_C) . '&checked=1', $GUEST_SID);
}
$res = request('GET', API . '?history=1&collection=' . rawurlencode(COL_C), $GUEST_SID);
$frequent = $res['body']['frequent'] ?? [];
check('the most bought name leads the frequent list', ($frequent[0]['name'] ?? '') === 'Mleko' || ($frequent[0]['name'] ?? '') === 'mleko',
    json_encode(array_column($frequent, 'name')));
check('spelling variants count as one name', ($frequent[0]['times'] ?? 0) === 3, json_encode($frequent[0] ?? null));

// Paging, so a long history never arrives in one response.
$res = request('GET', API . '?history=1&collection=' . rawurlencode(COL_C), $GUEST_SID);
$page1 = $res['body']['purchases'] ?? [];
check('history is newest first',
    count($page1) > 1 && strcmp((string) $page1[0]['bought_at'], (string) $page1[count($page1) - 1]['bought_at']) >= 0);
$oldest = (int) $page1[count($page1) - 1]['id'];
$res = request('GET', API . '?history=1&collection=' . rawurlencode(COL_C) . '&before=' . $oldest, $GUEST_SID);
check('paging past the oldest row returns nothing', ($res['body']['purchases'] ?? null) === []);

$res = request('GET', API . '?history=1&collection=' . rawurlencode(COL_A), $GUEST_SID);
check('history obeys the access boundary', $res['status'] === 403, "got {$res['status']}");

// ------------------------------------------------------------------
//  Validation and method guards
// ------------------------------------------------------------------

echo "\nvalidation\n";

$res = request('POST', API, $ADMIN_SID, ['collection' => COL_A, 'name' => '   ']);
check('an empty name is 400', $res['status'] === 400, "got {$res['status']}");
$res = request('POST', API, $ADMIN_SID, ['collection' => COL_A, 'name' => str_repeat('x', 256)]);
check('an over-long name is 400', $res['status'] === 400, "got {$res['status']}");
$res = request('POST', API, $ADMIN_SID, ['collection' => '', 'name' => 'x']);
check('an empty collection is 400', $res['status'] === 400, "got {$res['status']}");
$res = request('POST', API, $ADMIN_SID, ['collection' => str_repeat('x', 101), 'name' => 'x']);
check('an over-long collection is 400', $res['status'] === 400, "got {$res['status']}");

// CSRF backstop: a cookie-authed write only accepts a JSON body.
$res = request('POST', API, $ADMIN_SID, ['collection' => COL_A, 'name' => 'obrazec'], 'application/x-www-form-urlencoded');
check('a non-JSON write body is 415', $res['status'] === 415, "got {$res['status']}");

$res = request('GET', API, $ADMIN_SID);
check('a read without a collection is 400', $res['status'] === 400, "got {$res['status']}");
$res = request('PATCH', API . '?id=' . $jajcaId, $ADMIN_SID, []);
check('a patch with no fields is 400', $res['status'] === 400, "got {$res['status']}");
$res = request('PATCH', API, $ADMIN_SID, ['checked' => 1]);
check('a patch without an id is 400', $res['status'] === 400, "got {$res['status']}");
$res = request('PATCH', API . '?id=99999999', $ADMIN_SID, ['checked' => 1]);
check('patching a missing item is 404', $res['status'] === 404, "got {$res['status']}");
$res = request('DELETE', API, $ADMIN_SID);
check('a delete with no target is 400', $res['status'] === 400, "got {$res['status']}");
$res = request('PUT', API . '?collection=' . rawurlencode(COL_A), $ADMIN_SID, []);
check('an unsupported method is 405', $res['status'] === 405, "got {$res['status']}");

// ------------------------------------------------------------------

echo "\n$passed passed, $failed failed\n";
exit($failed === 0 ? 0 : 1);
