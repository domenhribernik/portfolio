<?php
declare(strict_types=1);

// Integration tests for app/controllers/wishlist-controller.php, the backend of
// the house wish list (views/wishlist).
//
// Three rules hold this suite together:
//
//   ANYONE CAN CLAIM, ONLY THE TOKEN CAN UNCLAIM. A guest needs no account to
//   say "I'll bring this", so the claim is proven by a random token the server
//   hands back once and stores only as a SHA-256. The raw bytes of every read
//   are searched for that hash; it must never leave the server.
//
//   ONLY EDITORS CHANGE THE LIST. Items are written by a site admin or a user
//   holding the `write` role on the `wishlist` project. Everyone else is 401 or
//   403, however the request is shaped.
//
//   A GUEST NEVER LOADS A THIRD-PARTY PICTURE. An item saved with a remote
//   image URL is stored as a local copy under assets/uploads/wishlist/, and the
//   fetcher that makes the copy refuses private addresses (SSRF). The one
//   exception is the stub shop on 127.0.0.1:8970, let through by the
//   WISHLIST_FETCH_ALLOW seam so the auto-fill path runs with no network.
//
// Runs ONLY against the local scratch DB (127.0.0.1/portfolio): the DB_* env
// overrides below make database.php skip loading app/.env (which points at the
// remote production database). Never run these against prod.
//
// Requires the seeded test users in the local DB:
//   admin@test.local  session token = 64 x 'a'
//   guest@test.local  session token = 64 x 'b'
//
// Needs GD (with WebP). The servers are booted with `-d extension=gd` when the
// interpreter running this file does not already have it loaded.
//
// Run: /opt/lampp/bin/php tests/wishlist-controller.test.php
//      C:\xampp\php\php.exe tests\wishlist-controller.test.php

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit('CLI only');
}

const DB_DSN    = 'mysql:host=127.0.0.1;port=3306;dbname=portfolio;charset=utf8mb4';
const DB_USER   = 'portfolio_dev';
const DB_PASS   = 'R2miswz1pNKOxdl4';
const PHP_BIN   = PHP_BINARY;
const DOC_ROOT  = __DIR__ . '/..';
const HOST      = '127.0.0.1';
const PORT      = 8969;
const STUB_PORT = 8970;
const API       = 'http://' . HOST . ':' . PORT . '/app/controllers/wishlist-controller.php';
const SHOP      = 'http://' . HOST . ':' . STUB_PORT;
const ORIGIN    = 'http://' . HOST . ':' . PORT;
const NO_GD_PORT = 8971;

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

/**
 * @param array|string|null $body  an array is sent as JSON, a string as-is
 * @return array{status:int, body:mixed, raw:string, headers:string[]}
 */
function request(
    string $method,
    string $url,
    ?string $sid = null,
    array|string|null $body = null,
    ?string $contentType = 'application/json',
    array $extraHeaders = []
): array {
    $headers = $extraHeaders;
    if ($sid !== null) {
        $headers[] = 'Cookie: portfolio_sid=' . $sid;
    }
    $opts = ['http' => ['method' => $method, 'ignore_errors' => true, 'timeout' => 20]];
    if ($body !== null) {
        if ($contentType !== null) {
            $headers[] = 'Content-Type: ' . $contentType;
        }
        $opts['http']['content'] = is_string($body) ? $body : json_encode($body);
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

function tableExists(PDO $pdo, string $table): bool
{
    return (bool) $pdo->query("SHOW TABLES LIKE " . $pdo->quote($table))->fetchColumn();
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

/** True when a response's item is present and explicitly has no picture. */
function noImage(array $res): bool
{
    $item = $res['body']['item'] ?? null;
    return is_array($item) && array_key_exists('image', $item) && $item['image'] === null;
}

/** The item with this id in a GET payload, or null. */
function findItem(array $res, int $id): ?array
{
    foreach ($res['body']['items'] ?? [] as $item) {
        if ((int) $item['id'] === $id) {
            return $item;
        }
    }
    return null;
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

if (!tableExists($pdo, 'images')) {
    applySqlFile($pdo, DOC_ROOT . '/app/models/images-model.sql');
}
if (!tableExists($pdo, 'wishlist_items')) {
    applySqlFile($pdo, DOC_ROOT . '/app/models/wishlist-model.sql');
}

$itemBaseline  = (int) $pdo->query('SELECT COALESCE(MAX(id), 0) FROM wishlist_items')->fetchColumn();
$imageBaseline = (int) $pdo->query('SELECT COALESCE(MAX(id), 0) FROM images')->fetchColumn();
$roleBaseline  = (int) $pdo->query('SELECT COALESCE(MAX(id), 0) FROM user_project_roles')->fetchColumn();

register_shutdown_function(function () use ($pdo, $itemBaseline, $imageBaseline, $roleBaseline) {
    // Claims cascade off their items. Image files go before their rows.
    $pdo->exec("DELETE FROM wishlist_items WHERE id > $itemBaseline");
    $rows = $pdo->query("SELECT uuid, folder, mime_type FROM images WHERE id > $imageBaseline")->fetchAll(PDO::FETCH_ASSOC);
    foreach ($rows as $row) {
        $ext = $row['mime_type'] === 'image/png' ? 'png' : 'jpg';
        @unlink(DOC_ROOT . "/assets/uploads/{$row['folder']}/{$row['uuid']}.$ext");
    }
    $pdo->exec("DELETE FROM images WHERE id > $imageBaseline");
    $pdo->exec("DELETE FROM user_project_roles WHERE id > $roleBaseline");
});

$pdo->exec("INSERT INTO projects (project_key, name) VALUES ('wishlist', 'Wish list') ON DUPLICATE KEY UPDATE active = 1");
$projectId = (int) $pdo->query("SELECT id FROM projects WHERE project_key = 'wishlist'")->fetchColumn();
// The guest starts with no wishlist role at all; it is granted and changed mid-suite.
$pdo->prepare('DELETE FROM user_project_roles WHERE user_id = ? AND project_id = ?')->execute([$guestId, $projectId]);

/** A list item written straight to the DB, for the read-side tests. */
function seedItem(PDO $pdo, string $name, int $quantity = 1): int
{
    $stmt = $pdo->prepare('INSERT INTO wishlist_items (name, url, note, quantity, position) VALUES (?, ?, ?, ?, 0)');
    $stmt->execute([$name, 'https://www.amazon.de/dp/B000TEST00', 'Any sort would do', $quantity]);
    return (int) $pdo->lastInsertId();
}

// ------------------------------------------------------------------
//  Boot the built-in servers against the LOCAL scratch DB
// ------------------------------------------------------------------

$nullDev = PHP_OS_FAMILY === 'Windows' ? 'NUL' : '/dev/null';
$serverEnv = [
    'DB_HOST'             => '127.0.0.1',
    'DB_PORT'             => '3306',
    'DB_NAME'             => 'portfolio',
    'DB_USER_W'           => DB_USER,
    'DB_PASS_W'           => DB_PASS,
    'DB_USER_R'           => DB_USER,
    'DB_PASS_R'           => DB_PASS,
    'WISHLIST_FETCH_ALLOW' => HOST . ':' . STUB_PORT,
    'PATH'                => getenv('PATH') ?: '/usr/bin:/bin',
];
if (PHP_OS_FAMILY === 'Windows') {
    $serverEnv['SystemRoot'] = getenv('SystemRoot') ?: 'C:\\Windows';
}
// The stub's flaky picture keeps a marker in the temp dir; without these the
// servers fall back to a system temp dir they may not be able to write.
$serverEnv['TEMP'] = $serverEnv['TMP'] = $serverEnv['TMPDIR'] = sys_get_temp_dir();
$gd =extension_loaded('gd') ? [] : ['-d', 'extension=gd'];

$server = proc_open(
    array_merge([PHP_BIN], $gd, ['-d', 'variables_order=EGPCS', '-S', HOST . ':' . PORT, '-t', DOC_ROOT]),
    [1 => ['file', $nullDev, 'w'], 2 => ['file', $nullDev, 'w']],
    $pipes,
    DOC_ROOT,
    $serverEnv
);
$stub = proc_open(
    [PHP_BIN, '-S', HOST . ':' . STUB_PORT, __DIR__ . '/fixtures/wishlist-shop-stub.php'],
    [1 => ['file', $nullDev, 'w'], 2 => ['file', $nullDev, 'w']],
    $stubPipes,
    __DIR__,
    $serverEnv
);

// The same app on a PHP without GD, the way a stock XAMPP ships (extension=gd
// is commented out in its php.ini). Only bootable where the interpreter
// really lacks GD; elsewhere those checks are skipped with a note.
$noGd = null;
if (!extension_loaded('gd')) {
    $noGd = proc_open(
        [PHP_BIN, '-d', 'variables_order=EGPCS', '-S', HOST . ':' . NO_GD_PORT, '-t', DOC_ROOT],
        [1 => ['file', $nullDev, 'w'], 2 => ['file', $nullDev, 'w']],
        $noGdPipes,
        DOC_ROOT,
        $serverEnv
    );
}

register_shutdown_function(function () use ($server, $stub, $noGd) {
    foreach ([$server, $stub, $noGd] as $proc) {
        if (is_resource($proc)) {
            proc_terminate($proc);
        }
    }
});

foreach ($noGd ? [PORT, STUB_PORT, NO_GD_PORT] : [PORT, STUB_PORT] as $port) {
    $ready = false;
    for ($i = 0; $i < 50; $i++) {
        $sock = @fsockopen(HOST, $port, $errno, $errstr, 0.2);
        if ($sock) {
            fclose($sock);
            $ready = true;
            break;
        }
        usleep(100_000);
    }
    if (!$ready) {
        fwrite(STDERR, "Built-in PHP server did not start on port $port\n");
        exit(1);
    }
}

// ------------------------------------------------------------------
//  Reading the list
// ------------------------------------------------------------------

echo "wishlist controller: reading\n";

$toasterId = seedItem($pdo, 'ZZtest toaster');

$res = request('GET', API);
check('a signed-out guest can read the list', $res['status'] === 200, "got {$res['status']}");
check('the seeded item is in it', findItem($res, $toasterId) !== null);
check('a signed-out guest cannot edit', ($res['body']['can_edit'] ?? null) === false);
check('no wildcard CORS header', !hasHeader($res['headers'], 'Access-Control-Allow-Origin'));
check('responses are no-store', hasHeader($res['headers'], 'Cache-Control'));

$setGuestRole = function (?string $role) use ($pdo, $guestId, $projectId): void {
    $pdo->prepare('DELETE FROM user_project_roles WHERE user_id = ? AND project_id = ?')->execute([$guestId, $projectId]);
    if ($role !== null) {
        $pdo->prepare('INSERT INTO user_project_roles (user_id, project_id, role) VALUES (?, ?, ?)')
            ->execute([$guestId, $projectId, $role]);
    }
};

$res = request('GET', API, $ADMIN_SID);
check('a site admin can edit', ($res['body']['can_edit'] ?? null) === true);

$res = request('GET', API, $GUEST_SID);
check('a signed-in user without a role reads but cannot edit',
    $res['status'] === 200 && ($res['body']['can_edit'] ?? null) === false);

$setGuestRole('viewer');
$res = request('GET', API, $GUEST_SID);
check('some other wishlist role cannot edit', ($res['body']['can_edit'] ?? null) === false);

$setGuestRole('write');
$res = request('GET', API, $GUEST_SID);
check('the write role can edit', ($res['body']['can_edit'] ?? null) === true);
$setGuestRole(null);

// ------------------------------------------------------------------
//  Claiming: anyone, no account
// ------------------------------------------------------------------

echo "wishlist controller: claiming\n";

$claim = fn (int $itemId, array $extra = []) => request(
    'POST', API . '?resource=claim', null, ['item_id' => $itemId] + $extra, 'application/json', ['Origin: ' . ORIGIN]
);

$res = $claim($toasterId);
check('a signed-out guest can claim an item', $res['status'] === 201, "got {$res['status']} {$res['raw']}");
$toasterClaim = $res['body']['claim'] ?? [];
$token = (string) ($toasterClaim['token'] ?? '');
check('the claim comes back with an id and a 64-hex token',
    (int) ($toasterClaim['id'] ?? 0) > 0 && preg_match('/^[0-9a-f]{64}$/', $token) === 1);
check('the response carries the item, now showing the claim',
    in_array((int) ($toasterClaim['id'] ?? 0), $res['body']['item']['claims'] ?? [], true));

$stored = $pdo->query('SELECT token_hash FROM wishlist_claims WHERE id = ' . (int) ($toasterClaim['id'] ?? 0))->fetchColumn();
check('only the hash of the token is stored', $stored === hash('sha256', $token));

$res = request('GET', API);
$item = findItem($res, $toasterId);
check('a read lists the claim by id', ($item['claims'] ?? null) === [(int) ($toasterClaim['id'] ?? 0)]);
check('the token hash never leaves the server', !str_contains($res['raw'], (string) $stored));
check('nor does the token itself', $token !== '' && !str_contains($res['raw'], $token));

$res = $claim($toasterId);
check('a fully taken item refuses another claim with 409', $res['status'] === 409, "got {$res['status']}");

$jarsId = seedItem($pdo, 'ZZtest jars', 2);
$first  = $claim($jarsId);
$second = $claim($jarsId);
$third  = $claim($jarsId);
check('an item wanted twice takes two claims', $first['status'] === 201 && $second['status'] === 201);
check('and refuses a third', $third['status'] === 409, "got {$third['status']}");

$res = $claim(999999999);
check('claiming an item that does not exist is 404', $res['status'] === 404, "got {$res['status']}");

// --- guards on an endpoint with no login in front of it

$res = request('POST', API . '?resource=claim', null, ['item_id' => $jarsId], 'application/json', ['Origin: https://evil.example']);
check('a claim from a foreign origin is 403', $res['status'] === 403, "got {$res['status']}");

$res = request('POST', API . '?resource=claim', null, 'item_id=' . $jarsId, 'application/x-www-form-urlencoded', ['Origin: ' . ORIGIN]);
check('a form-encoded claim is 415', $res['status'] === 415, "got {$res['status']}");

$spoonId = seedItem($pdo, 'ZZtest spoon');
$res = $claim($spoonId, ['website' => 'http://spam.example']);
$rows = (int) $pdo->query("SELECT COUNT(*) FROM wishlist_claims WHERE item_id = $spoonId")->fetchColumn();
check('a filled honeypot is answered calmly and stores nothing',
    $res['status'] >= 200 && $res['status'] < 300 && $rows === 0, "status {$res['status']}, rows $rows");

// ------------------------------------------------------------------
//  Undo: the token, or an editor
// ------------------------------------------------------------------

echo "wishlist controller: undo\n";

$unclaim = fn (int $claimId, ?string $tok, ?string $sid = null) => request(
    'DELETE', API . '?resource=claim&id=' . $claimId, $sid, $tok === null ? [] : ['token' => $tok],
    'application/json', ['Origin: ' . ORIGIN]
);
$claimCount = fn (int $itemId) => (int) $pdo->query("SELECT COUNT(*) FROM wishlist_claims WHERE item_id = $itemId")->fetchColumn();

$toasterClaimId = (int) ($toasterClaim['id'] ?? 0);
$res = $unclaim($toasterClaimId, str_repeat('0', 64));
check('a wrong token cannot undo a claim', $res['status'] === 403 && $claimCount($toasterId) === 1, "got {$res['status']}");

$res = $unclaim($toasterClaimId, null, $GUEST_SID);
check('a signed-in non-editor without the token cannot either', $res['status'] === 403, "got {$res['status']}");

$res = $unclaim($toasterClaimId, $token);
check('the token undoes its own claim', $res['status'] === 200 && $claimCount($toasterId) === 0, "got {$res['status']}");
check('the response carries the item, open again', ($res['body']['item']['claims'] ?? null) === []);

$res = $unclaim($toasterClaimId, $token);
check('undoing a claim twice is 404', $res['status'] === 404, "got {$res['status']}");

$jarClaimId = (int) ($first['body']['claim']['id'] ?? 0);
$res = $unclaim($jarClaimId, null, $ADMIN_SID);
check('an editor can reset any claim without its token', $res['status'] === 200 && $claimCount($jarsId) === 1, "got {$res['status']}");

// ------------------------------------------------------------------
//  Editing the list: admin or `write` only
// ------------------------------------------------------------------

echo "wishlist controller: editing\n";

$create = fn (array $body, ?string $sid) => request('POST', API, $sid, $body, 'application/json', ['Origin: ' . ORIGIN]);
$patch  = fn (int $id, array $body, ?string $sid) => request('PATCH', API . '?id=' . $id, $sid, $body, 'application/json', ['Origin: ' . ORIGIN]);
$remove = fn (int $id, ?string $sid) => request('DELETE', API . '?id=' . $id, $sid, null, null, ['Origin: ' . ORIGIN]);

$draft = ['name' => 'ZZtest mop', 'url' => 'https://www.amazon.de/dp/B005U94N9A', 'note' => 'Any convenient mop', 'quantity' => 1];

$res = $create($draft, null);
check('signed out cannot add an item', $res['status'] === 401, "got {$res['status']}");
$res = $create($draft, $GUEST_SID);
check('a user without the role cannot add an item', $res['status'] === 403, "got {$res['status']}");

$res = $create($draft, $ADMIN_SID);
$mopId = (int) ($res['body']['item']['id'] ?? 0);
check('an admin adds an item', $res['status'] === 201 && $mopId > 0, "got {$res['status']} {$res['raw']}");
check('it reads back as written', ($res['body']['item']['note'] ?? null) === 'Any convenient mop'
    && ($res['body']['item']['claims'] ?? null) === []);
$createdBy = (int) $pdo->query("SELECT created_by FROM wishlist_items WHERE id = $mopId")->fetchColumn();
check('the creator comes from the session', $createdBy === $adminId);

$setGuestRole('write');
$res = $create(['name' => 'ZZtest towels'] + $draft, $GUEST_SID);
check('the write role adds an item', $res['status'] === 201, "got {$res['status']}");
$setGuestRole(null);

$res = $create(['name' => '  '] + $draft, $ADMIN_SID);
check('a blank name is 422', $res['status'] === 422, "got {$res['status']}");
$res = $create(['url' => 'javascript:alert(1)'] + $draft, $ADMIN_SID);
check('a javascript: link is 422, since it becomes an href', $res['status'] === 422, "got {$res['status']}");
$res = $create(['quantity' => 0] + $draft, $ADMIN_SID);
check('a quantity of 0 is 422', $res['status'] === 422, "got {$res['status']}");
$res = $create(['note' => str_repeat('n', 2001)] + $draft, $ADMIN_SID);
check('an overlong note is 422', $res['status'] === 422, "got {$res['status']}");
$res = $create(['name' => 'ZZtest glass', 'url' => 'tkmaxx.de/glass'] + $draft, $ADMIN_SID);
check('a link pasted without a scheme is stored as https',
    ($res['body']['item']['url'] ?? null) === 'https://tkmaxx.de/glass', $res['raw']);

$keyed = ['name' => 'ZZtest strainer', 'source_key' => 'zztest:B07TYMDHCS'] + $draft;
$a = $create($keyed, $ADMIN_SID);
$b = $create($keyed, $ADMIN_SID);
check('an import keyed by source is created once', $a['status'] === 201 && $b['status'] === 200
    && ($a['body']['item']['id'] ?? 0) === ($b['body']['item']['id'] ?? -1), "got {$a['status']} then {$b['status']}");

$res = $patch($mopId, ['note' => 'Any mop that wrings itself'], $GUEST_SID);
check('a user without the role cannot edit a note', $res['status'] === 403, "got {$res['status']}");
$res = $patch($mopId, ['note' => 'Any mop that wrings itself', 'quantity' => 2], $ADMIN_SID);
check('an editor edits a note and the quantity', $res['status'] === 200
    && ($res['body']['item']['note'] ?? null) === 'Any mop that wrings itself'
    && ($res['body']['item']['quantity'] ?? null) === 2, $res['raw']);
check('fields left out of an edit stay as they were', ($res['body']['item']['name'] ?? null) === 'ZZtest mop');
$res = $patch($mopId, ['note' => ''], $ADMIN_SID);
check('clearing a note stores no note', $res['status'] === 200
    && array_key_exists('note', $res['body']['item'] ?? []) && $res['body']['item']['note'] === null);
$res = $patch($mopId, ['url' => 'data:text/html,hi'], $ADMIN_SID);
check('an edit is validated too', $res['status'] === 422, "got {$res['status']}");

$res = $remove($mopId, $GUEST_SID);
check('a user without the role cannot remove an item', $res['status'] === 403, "got {$res['status']}");
$res = $remove($mopId, $ADMIN_SID);
check('an editor removes an item', $res['status'] === 200, "got {$res['status']}");
check('a removed item is gone from the list', findItem(request('GET', API), $mopId) === null);
check('a removed item cannot be claimed', $claim($mopId)['status'] === 404);
$res = $patch($mopId, ['restore' => true], $ADMIN_SID);
check('Undo brings a removed item back', $res['status'] === 200 && findItem(request('GET', API), $mopId) !== null, "got {$res['status']}");

// ------------------------------------------------------------------
//  Auto-fill from a link, and the fetcher's guard
// ------------------------------------------------------------------

echo "wishlist controller: auto-fill\n";

$preview = fn (string $url, ?string $sid = null) => request(
    'POST', API . '?resource=preview', $sid ?? $ADMIN_SID, ['url' => $url], 'application/json', ['Origin: ' . ORIGIN]
);

$res = request('POST', API . '?resource=preview', null, ['url' => SHOP . '/og.html'], 'application/json', ['Origin: ' . ORIGIN]);
check('signed out cannot use auto-fill', $res['status'] === 401, "got {$res['status']}");
$res = $preview(SHOP . '/og.html', $GUEST_SID);
check('a user without the role cannot use auto-fill', $res['status'] === 403, "got {$res['status']}");

$res = $preview(SHOP . '/og.html');
check('a shop page is read for its og:title', ($res['body']['title'] ?? null) === 'Glass jar with lid - IKEA', $res['raw']);
check('and its og:image, resolved against the page', ($res['body']['image_url'] ?? null) === SHOP . '/jar.webp', $res['raw']);

$res = $preview(SHOP . '/amazon.html');
check('an Amazon page is read for #productTitle',
    ($res['body']['title'] ?? null) === 'WMF Profi Plus Kartoffelstampfer Edelstahl 28,5 cm, Cromargan', $res['raw']);
check('and #landingImage', ($res['body']['image_url'] ?? null) === SHOP . '/masher.jpg', $res['raw']);

foreach ([
    'a private address'           => 'http://10.0.0.1/',
    'localhost'                   => 'http://localhost:' . PORT . '/',
    'loopback off the allowlist'  => 'http://127.0.0.1:' . PORT . '/app/controllers/wishlist-controller.php',
    'an IPv6 loopback'            => 'http://[::1]/',
    'a non-web scheme'            => 'file:///etc/passwd',
    'a redirect to a private host' => SHOP . '/to-private',
] as $what => $url) {
    $res = $preview($url);
    check("auto-fill refuses $what", $res['status'] === 422, "got {$res['status']} {$res['raw']}");
}

$res = $preview(SHOP . '/missing.html');
check('a page that will not load is 502, and the editor fills it in by hand', $res['status'] === 502, "got {$res['status']}");

$res = $preview(SHOP . '/captcha.html');
check('a captcha wall is not mistaken for a product called "Amazon.de"',
    $res['status'] === 200 && array_key_exists('title', $res['body'] ?? []) && $res['body']['title'] === null, $res['raw']);

// Amazon walls off servers it suspects of being bots, but a product link
// still names the product: the slug before /dp/ is its title and the ASIN
// after it addresses a picture. Pure function, no network.
require_once DOC_ROOT . '/app/controllers/wishlist/fetch.php';
$fb = WishlistFetch::amazonFallback('https://www.amazon.de/Bosch-Stabmixer-ErgoMixx-Edelstahl-Mixfu%C3%9F/dp/B00A925G3A?ref_=x');
check('an Amazon link yields its title from the slug', ($fb['title'] ?? null) === 'Bosch Stabmixer ErgoMixx Edelstahl Mixfuß', json_encode($fb));
check('and a picture address from its ASIN', str_contains((string) ($fb['image_url'] ?? ''), '/images/P/B00A925G3A.'), json_encode($fb));
$fb = WishlistFetch::amazonFallback('https://www.amazon.de/dp/B0FR8TY1R9');
check('a bare /dp/ link has no slug to name it, but still a picture address',
    is_array($fb) && array_key_exists('title', $fb) && $fb['title'] === null
    && str_contains((string) ($fb['image_url'] ?? ''), 'B0FR8TY1R9'), json_encode($fb));
check('a share link from the app (/gp/product/) is read the same way',
    str_contains((string) (WishlistFetch::amazonFallback('https://amazon.de/gp/product/B00A925G3A')['image_url'] ?? ''), 'B00A925G3A'));
check('anything that is not Amazon gets no fallback', WishlistFetch::amazonFallback(SHOP . '/dp/B00A925G3A') === null);

// ------------------------------------------------------------------
//  Pictures: always a local copy
// ------------------------------------------------------------------

echo "wishlist controller: pictures\n";

$imagePath = fn (array $item) => (string) ($item['image']['url'] ?? '');
$isLocalJpeg = function (string $path): bool {
    if (!preg_match('#^assets/uploads/wishlist/[0-9a-f-]{36}\.jpg$#', $path)) return false;
    $bytes = @file_get_contents(DOC_ROOT . '/' . $path);
    return is_string($bytes) && str_starts_with($bytes, "\xFF\xD8");
};

$res = $create(['name' => 'ZZtest jar', 'image_url' => SHOP . '/jar.webp'] + $draft, $ADMIN_SID);
$jarItem = $res['body']['item'] ?? [];
check('a picture saved by URL is copied here as a JPEG, WebP included',
    $res['status'] === 201 && $isLocalJpeg($imagePath($jarItem)), $res['raw']);
check('with its dimensions', (int) ($jarItem['image']['width'] ?? 0) === 64 && (int) ($jarItem['image']['height'] ?? 0) === 48);

$res = $create(['name' => 'ZZtest broken', 'image_url' => SHOP . '/not-an-image'] + $draft, $ADMIN_SID);
check('a picture that will not load still saves the item, without one, and says so',
    $res['status'] === 201 && noImage($res) && !empty($res['body']['warning']), $res['raw']);

$res = $create(['name' => 'ZZtest pixel', 'image_url' => SHOP . '/pixel.gif'] + $draft, $ADMIN_SID);
check('a tracking pixel is not kept as a product picture',
    $res['status'] === 201 && noImage($res) && !empty($res['body']['warning']), $res['raw']);

$res = $create(['name' => 'ZZtest sneaky', 'image_url' => 'http://10.0.0.1/a.jpg'] + $draft, $ADMIN_SID);
check('a picture URL on a private address is never fetched', $res['status'] === 201
    && noImage($res) && !empty($res['body']['warning']), $res['raw']);

$res = $patch((int) ($jarItem['id'] ?? 0), ['image_url' => SHOP . '/masher.jpg'], $ADMIN_SID);
check('an edit can swap the picture', $res['status'] === 200 && $isLocalJpeg($imagePath($res['body']['item'] ?? []))
    && $imagePath($res['body']['item'] ?? []) !== $imagePath($jarItem), $res['raw']);
$res = $patch((int) ($jarItem['id'] ?? 0), ['image_id' => null], $ADMIN_SID);
check('and remove it', $res['status'] === 200 && noImage($res), $res['raw']);

/** A multipart body with one file field named "image". */
function multipart(string $bytes, string $mime): array
{
    $boundary = '----wishlist' . bin2hex(random_bytes(8));
    $body = "--$boundary\r\nContent-Disposition: form-data; name=\"image\"; filename=\"photo\"\r\n"
          . "Content-Type: $mime\r\n\r\n$bytes\r\n--$boundary--\r\n";
    return ['multipart/form-data; boundary=' . $boundary, $body];
}

$jpeg = (string) file_get_contents(SHOP . '/masher.jpg');
[$ctype, $mbody] = multipart($jpeg, 'image/jpeg');
$res = request('POST', API . '?resource=image', $GUEST_SID, $mbody, $ctype, ['Origin: ' . ORIGIN]);
check('a user without the role cannot upload a picture', $res['status'] === 403, "got {$res['status']}");
$res = request('POST', API . '?resource=image', $ADMIN_SID, $mbody, $ctype, ['Origin: ' . ORIGIN]);
$uploadedId = (int) ($res['body']['image_id'] ?? 0);
check('an editor uploads a photo from the phone', $res['status'] === 201 && $uploadedId > 0
    && $isLocalJpeg((string) ($res['body']['image']['url'] ?? '')), $res['raw']);
$res = $create(['name' => 'ZZtest uploaded', 'image_id' => $uploadedId] + $draft, $ADMIN_SID);
check('and saves an item with it', $res['status'] === 201 && $uploadedId > 0
    && (int) ($res['body']['item']['image']['id'] ?? 0) === $uploadedId, $res['raw']);
$res = $create(['name' => 'ZZtest borrowed', 'image_id' => 999999999] + $draft, $ADMIN_SID);
check('an image id that does not exist is 422', $res['status'] === 422, "got {$res['status']}");

$res = request('GET', API);
check('no guest read ever points at a remote picture', !str_contains($res['raw'], (string) STUB_PORT));

// A picture problem never costs the item, and a re-run of the import fills
// in the pictures that are still missing.
$keyedPic = ['name' => 'ZZtest backfill', 'source_key' => 'zztest:backfill', 'image_url' => SHOP . '/pixel.gif'] + $draft;
$first = $create($keyedPic, $ADMIN_SID);
$backfillId = (int) ($first['body']['item']['id'] ?? 0);
check('an import whose picture fails still saves the item', $first['status'] === 201 && noImage($first), $first['raw']);
$again = $create(['image_url' => SHOP . '/masher.jpg'] + $keyedPic, $ADMIN_SID);
check('running the import again fills in the missing picture',
    $again['status'] === 200 && (int) ($again['body']['item']['id'] ?? 0) === $backfillId
    && $isLocalJpeg($imagePath($again['body']['item'] ?? [])), $again['raw']);
$third = $create(['image_url' => SHOP . '/jar.webp'] + $keyedPic, $ADMIN_SID);
check('but never replaces a picture the item already has',
    $imagePath($third['body']['item'] ?? []) === $imagePath($again['body']['item'] ?? []), $third['raw']);

$res = $create(['name' => 'ZZtest blip', 'image_url' => SHOP . '/flaky.jpg'] + $draft, $ADMIN_SID);
check('a picture survives one network blip (the fetcher retries once)',
    $res['status'] === 201 && $isLocalJpeg($imagePath($res['body']['item'] ?? [])), $res['raw']);

if ($noGd) {
    $noGdApi = 'http://' . HOST . ':' . NO_GD_PORT . '/app/controllers/wishlist-controller.php';
    $res = request('POST', $noGdApi, $ADMIN_SID, ['name' => 'ZZtest no gd', 'image_url' => SHOP . '/masher.jpg'] + $draft,
        'application/json', ['Origin: http://' . HOST . ':' . NO_GD_PORT]);
    check('on a PHP without GD the item still saves, without its picture', $res['status'] === 201 && noImage($res), $res['raw']);
    check('and the warning names the missing GD extension', str_contains((string) ($res['body']['warning'] ?? ''), 'GD'), $res['raw']);
} else {
    echo "  --  skipped the no-GD checks: this PHP has GD built in\n";
}

// ------------------------------------------------------------------
//  Polling: two guests must not both go and buy the toaster
// ------------------------------------------------------------------

echo "wishlist controller: polling\n";

$version = (string) (request('GET', API)['body']['version'] ?? '');
check('a read carries a version', $version !== '');

$res = request('GET', API . '?since=' . urlencode($version));
check('nothing changed answers small', ($res['body']['changed'] ?? null) === false && !isset($res['body']['items']), $res['raw']);

$c = $claim($toasterId);
$res = request('GET', API . '?since=' . urlencode($version));
check('a claim is a change', isset($res['body']['items']) && ($res['body']['version'] ?? '') !== $version);
$version = (string) $res['body']['version'];

$unclaim((int) ($c['body']['claim']['id'] ?? 0), (string) ($c['body']['claim']['token'] ?? ''));
$c = $claim($toasterId);
$res = request('GET', API . '?since=' . urlencode($version));
check('an undo and a fresh claim inside one poll still read as a change', isset($res['body']['items']));
$version = (string) $res['body']['version'];

$patch($toasterId, ['note' => 'Two slots is plenty'], $ADMIN_SID);
$res = request('GET', API . '?since=' . urlencode($version));
check('an edited note is a change', isset($res['body']['items']));

// ------------------------------------------------------------------

echo "\n$passed passed, $failed failed\n";
exit($failed === 0 ? 0 : 1);
