<?php
declare(strict_types=1);

// Integration tests for app/controllers/iliana-photos-controller.php (the
// private two-person views/iliana photo gallery backend).
//
// SEC-02: reads stay public (the page's own client-side gate is cosmetic,
// tracked as LOW-01), but every write (create, edit, delete, upload) must be
// behind Auth::requireProjectRole('iliana', 'editor'), added_by must be
// derived from the session user (never trusted from the body), and the
// wildcard CORS header must be gone.
//
// Runs ONLY against the local scratch DB (127.0.0.1/portfolio): the DB_* env
// overrides below make database.php skip loading app/.env (which points at the
// remote production database). Never run these against prod.
//
// Requires the seeded test users in the local DB:
//   admin@test.local  session token = 64 x 'a'
//   guest@test.local  session token = 64 x 'b'
//
// Uploads go through the real ImageService (GD required); the suite tracks
// the ids and files it creates and removes them afterwards.
//
// Run: /opt/lampp/bin/php tests/iliana-photos-controller.test.php

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
const PORT     = 8958;
const API      = 'http://' . HOST . ':' . PORT . '/app/controllers/iliana-photos-controller.php';

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

/** @return array{status:int, body:mixed, headers:string[]} */
function request(string $method, string $url, ?string $sid = null, ?string $contentType = null, ?string $content = null): array
{
    $headers = [];
    if ($sid !== null) {
        $headers[] = 'Cookie: portfolio_sid=' . $sid;
    }
    if ($contentType !== null) {
        $headers[] = 'Content-Type: ' . $contentType;
    }
    $opts = ['http' => ['method' => $method, 'ignore_errors' => true, 'timeout' => 30]];
    if ($content !== null) {
        $opts['http']['content'] = $content;
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

/** Builds a multipart/form-data payload. @return array{0:string,1:string} [contentType, body] */
function multipart(array $fields, ?string $imageBytes): array
{
    $boundary = '----test' . bin2hex(random_bytes(8));
    $body = '';
    foreach ($fields as $k => $v) {
        $body .= "--$boundary\r\nContent-Disposition: form-data; name=\"$k\"\r\n\r\n$v\r\n";
    }
    if ($imageBytes !== null) {
        $body .= "--$boundary\r\nContent-Disposition: form-data; name=\"image\"; filename=\"test.jpg\"\r\n"
               . "Content-Type: image/jpeg\r\n\r\n$imageBytes\r\n";
    }
    $body .= "--$boundary--\r\n";
    return ['multipart/form-data; boundary=' . $boundary, $body];
}

function tinyJpeg(): string
{
    $im = imagecreatetruecolor(8, 8);
    imagefill($im, 0, 0, imagecolorallocate($im, 200, 60, 60));
    ob_start();
    imagejpeg($im);
    imagedestroy($im);
    return (string) ob_get_clean();
}

// ------------------------------------------------------------------
//  DB fixtures
// ------------------------------------------------------------------

$pdo = new PDO(DB_DSN, DB_USER, DB_PASS, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);

$pdo->exec("CREATE TABLE IF NOT EXISTS images (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    uuid          CHAR(36)     NOT NULL UNIQUE,
    folder        VARCHAR(100) NOT NULL DEFAULT 'general',
    original_name VARCHAR(255),
    mime_type     VARCHAR(50),
    width         INT,
    height        INT,
    file_size     INT,
    uploaded_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
)");

$pdo->exec("CREATE TABLE IF NOT EXISTS iliana_photos (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    image_id   INT NOT NULL,
    caption    VARCHAR(500) NOT NULL,
    photo_date DATE NOT NULL,
    added_by   VARCHAR(100) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_iliana_photos_image FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE,
    INDEX idx_photo_date (photo_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

// Existing local tables predate the added_by ENUM -> VARCHAR migration.
$col = $pdo->query("SHOW COLUMNS FROM iliana_photos LIKE 'added_by'")->fetch(PDO::FETCH_ASSOC);
if ($col && stripos((string) $col['Type'], 'enum') === 0) {
    $pdo->exec("ALTER TABLE iliana_photos MODIFY added_by VARCHAR(100) NOT NULL");
}

// Register the iliana project (same seed as app/models/iliana-photos-model.sql).
$pdo->exec("INSERT INTO projects (project_key, name) VALUES ('iliana', 'Iliana')
            ON DUPLICATE KEY UPDATE active = 1");
$projectId = (int) $pdo->query("SELECT id FROM projects WHERE project_key = 'iliana'")->fetchColumn();

$adminId = (int) $pdo->query("SELECT id FROM users WHERE email = 'admin@test.local'")->fetchColumn();
$guestId = (int) $pdo->query("SELECT id FROM users WHERE email = 'guest@test.local'")->fetchColumn();
if ($adminId === 0 || $guestId === 0) {
    fwrite(STDERR, "Missing admin/guest fixture users in local DB\n");
    exit(1);
}

// The name writes must attribute to: same derivation the controller uses.
$stmt = $pdo->prepare(
    "SELECT COALESCE(NULLIF(TRIM(display_name), ''), NULLIF(TRIM(username), ''), 'Member')
     FROM users WHERE id = ?"
);
$stmt->execute([$guestId]);
$guestName = (string) $stmt->fetchColumn();

// Clean slate: guest starts without a role in the project.
$pdo->prepare('DELETE FROM user_project_roles WHERE user_id = ? AND project_id = ?')
    ->execute([$guestId, $projectId]);

$PHOTO_BASELINE = (int) $pdo->query('SELECT COALESCE(MAX(id), 0) FROM iliana_photos')->fetchColumn();
$IMAGE_BASELINE = (int) $pdo->query('SELECT COALESCE(MAX(id), 0) FROM images')->fetchColumn();
$createdUuids = [];

register_shutdown_function(function () use ($pdo, $guestId, $projectId, $PHOTO_BASELINE, $IMAGE_BASELINE, &$createdUuids) {
    $pdo->prepare('DELETE FROM iliana_photos WHERE id > ?')->execute([$PHOTO_BASELINE]);
    $pdo->prepare("DELETE FROM images WHERE id > ? AND folder = 'iliana'")->execute([$IMAGE_BASELINE]);
    $pdo->prepare('DELETE FROM user_project_roles WHERE user_id = ? AND project_id = ?')
        ->execute([$guestId, $projectId]);
    foreach ($createdUuids as $uuid) {
        foreach (glob(DOC_ROOT . '/assets/uploads/iliana/' . $uuid . '.*') ?: [] as $f) {
            @unlink($f);
        }
    }
});

function photoCount(PDO $pdo): int
{
    global $PHOTO_BASELINE;
    $stmt = $pdo->prepare('SELECT COUNT(*) FROM iliana_photos WHERE id > ?');
    $stmt->execute([$PHOTO_BASELINE]);
    return (int) $stmt->fetchColumn();
}

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
//  Tests
// ------------------------------------------------------------------

echo "iliana photos controller\n";

$jpeg = tinyJpeg();
$createFields = [
    'caption'    => "Test memory",
    'photo_date' => '2026-01-15',
    'added_by'   => 'Domen', // spoof attempt: must never be trusted
];

// Reads stay public.
$res = request('GET', API);
check('anonymous GET list is 200', $res['status'] === 200, "got {$res['status']}");
check('GET returns an array', is_array($res['body']));
check('no wildcard CORS header', !hasHeader($res['headers'], 'Access-Control-Allow-Origin'));

// Writes are gated.
$before = photoCount($pdo);
[$ct, $body] = multipart($createFields, $jpeg);
$res = request('POST', API, null, $ct, $body);
check('anonymous create is 401', $res['status'] === 401, "got {$res['status']}");
check('anonymous create persists nothing', photoCount($pdo) === $before);

[$ct, $body] = multipart($createFields, $jpeg);
$res = request('POST', API, $GUEST_SID, $ct, $body);
check('signed-in user without the role is 403', $res['status'] === 403, "got {$res['status']}");
check('role-less create persists nothing', photoCount($pdo) === $before);

$res = request('DELETE', API . '?id=999999');
check('anonymous delete is 401', $res['status'] === 401, "got {$res['status']}");

$res = request('DELETE', API . '?id=999999', $GUEST_SID);
check('role-less delete is 403', $res['status'] === 403, "got {$res['status']}");

// Grant guest the editor role: writes now work, attributed to the session user.
$pdo->prepare('INSERT INTO user_project_roles (user_id, project_id, role) VALUES (?, ?, ?)')
    ->execute([$guestId, $projectId, 'editor']);

[$ct, $body] = multipart($createFields, $jpeg);
$res = request('POST', API, $GUEST_SID, $ct, $body);
check('editor create is 200', $res['status'] === 200, "got {$res['status']} " . json_encode($res['body']));
$photoId = (int) ($res['body']['id'] ?? 0);
$uuid    = (string) ($res['body']['uuid'] ?? '');
if ($uuid !== '') $createdUuids[] = $uuid;
check('create persists one row', photoCount($pdo) === $before + 1);
check('added_by comes from the session, not the body',
    ($res['body']['added_by'] ?? '') === $guestName,
    "got " . var_export($res['body']['added_by'] ?? null, true) . ", want $guestName");
$storedFile = $uuid !== '' ? DOC_ROOT . '/assets/uploads/iliana/' . $uuid . '.jpg' : '';
check('uploaded file exists on disk', $storedFile !== '' && file_exists($storedFile));

// Editing: caption changes, attribution is preserved (not re-derived, not spoofable).
[$ct, $body] = multipart([
    'caption'    => 'Edited caption',
    'photo_date' => '2026-01-16',
    'added_by'   => 'Iliana', // spoof attempt again
], null);
$res = request('POST', API . '?id=' . $photoId, $GUEST_SID, $ct, $body);
check('editor update is 200', $res['status'] === 200, "got {$res['status']} " . json_encode($res['body']));
check('update changes the caption', ($res['body']['caption'] ?? '') === 'Edited caption');
check('update preserves the original added_by', ($res['body']['added_by'] ?? '') === $guestName,
    "got " . var_export($res['body']['added_by'] ?? null, true));

// Site admins pass project gates implicitly.
[$ct, $body] = multipart(['caption' => 'Admin edit', 'photo_date' => '2026-01-17'], null);
$res = request('POST', API . '?id=' . $photoId, $ADMIN_SID, $ct, $body);
check('admin update is 200 (implicit project access)', $res['status'] === 200, "got {$res['status']}");
check('admin edit preserves the creator attribution', ($res['body']['added_by'] ?? '') === $guestName);

// Delete: removes the row and the file.
$res = request('DELETE', API . '?id=' . $photoId, $GUEST_SID);
check('editor delete is 200', $res['status'] === 200, "got {$res['status']}");
check('deleted row is gone', photoCount($pdo) === $before);
$res = request('GET', API . '?id=' . $photoId);
check('deleted photo GET is 404', $res['status'] === 404, "got {$res['status']}");
check('uploaded file removed from disk', $storedFile !== '' && !file_exists($storedFile));

echo "\n$passed passed, $failed failed\n";
exit($failed === 0 ? 0 : 1);
