<?php
declare(strict_types=1);

// Integration tests for app/controllers/music-controller.php (the public
// views/music player plus its editor and analysis subpages).
//
// SEC-05: reads stay public (the player and the analysis library are for
// everyone), but saveSync/deleteSync/runAnalysis must be behind
// Auth::requireProjectRole('music', 'editor'), the wildcard CORS header must
// be gone, and the analysis endpoint (which spawns a synchronous Python +
// ffmpeg process) must refuse to run concurrently (lock file -> 429).
//
// No Python/ffmpeg runs here: the analysis tests stop at the auth gate, the
// lock check, or upload validation, all of which fire before exec().
//
// Runs ONLY against the local scratch DB (127.0.0.1/portfolio): the DB_* env
// overrides below make database.php skip loading app/.env (which points at
// the remote production database). Never run these against prod.
//
// Requires the seeded test users in the local DB:
//   admin@test.local  session token = 64 x 'a'
//   guest@test.local  session token = 64 x 'b'
//
// Run: /opt/lampp/bin/php tests/music-controller.test.php

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
const PORT     = 8961;
const API      = 'http://' . HOST . ':' . PORT . '/app/controllers/music-controller.php';
const TRACK    = 'acoustic/__sec05-test-track__.mp3';

$ADMIN_SID = str_repeat('a', 64);
$GUEST_SID = str_repeat('b', 64);

$lockFile = __DIR__ . '/music-analysis.test.lock';

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
function request(string $method, string $url, ?string $sid = null, ?array $json = null): array
{
    $headers = [];
    if ($sid !== null) {
        $headers[] = 'Cookie: portfolio_sid=' . $sid;
    }
    $opts = ['http' => ['method' => $method, 'ignore_errors' => true, 'timeout' => 15]];
    if ($json !== null) {
        $headers[] = 'Content-Type: application/json';
        $opts['http']['content'] = json_encode($json);
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

/** Empty multipart POST: enough to hit auth, lock, and "no file" validation. */
function postMultipart(string $url, ?string $sid = null): array
{
    $boundary = '----test' . bin2hex(random_bytes(8));
    $headers = ['Content-Type: multipart/form-data; boundary=' . $boundary];
    if ($sid !== null) {
        $headers[] = 'Cookie: portfolio_sid=' . $sid;
    }
    $opts = ['http' => [
        'method'        => 'POST',
        'ignore_errors' => true,
        'timeout'       => 15,
        'header'        => implode("\r\n", $headers),
        'content'       => "--$boundary--\r\n",
    ]];
    $raw = @file_get_contents($url, false, stream_context_create($opts));
    $status = 0;
    foreach ($http_response_header ?? [] as $h) {
        if (preg_match('#^HTTP/\S+\s+(\d{3})#', $h, $m)) {
            $status = (int) $m[1];
        }
    }
    return ['status' => $status, 'body' => $raw !== false ? json_decode($raw, true) : null];
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

function syncBody(): array
{
    return [
        'track_key' => TRACK,
        'lyrics'    => "Test line one\nTest line two",
        'chords'    => [['time' => 1.5, 'chord' => 'Am'], ['time' => 4.0, 'chord' => 'F']],
        'words'     => [],
    ];
}

// ------------------------------------------------------------------
//  DB fixtures
// ------------------------------------------------------------------

$pdo = new PDO(DB_DSN, DB_USER, DB_PASS, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);

$pdo->exec("CREATE TABLE IF NOT EXISTS music_sync (
    id INT AUTO_INCREMENT PRIMARY KEY,
    track_key VARCHAR(255) NOT NULL UNIQUE,
    lyrics TEXT NOT NULL,
    chords JSON NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

$pdo->exec("CREATE TABLE IF NOT EXISTS music_analyses (
    id INT AUTO_INCREMENT PRIMARY KEY,
    filename VARCHAR(255) NOT NULL,
    result JSON NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

$pdo->exec("INSERT INTO projects (project_key, name) VALUES ('music', 'Music')
            ON DUPLICATE KEY UPDATE active = 1");
$projectId = (int) $pdo->query("SELECT id FROM projects WHERE project_key = 'music'")->fetchColumn();

$adminId = (int) $pdo->query("SELECT id FROM users WHERE email = 'admin@test.local'")->fetchColumn();
$guestId = (int) $pdo->query("SELECT id FROM users WHERE email = 'guest@test.local'")->fetchColumn();
if ($adminId === 0 || $guestId === 0) {
    fwrite(STDERR, "Missing admin/guest fixture users in local DB\n");
    exit(1);
}

// Clean slate: guest starts without a role, no leftover test track.
$pdo->prepare('DELETE FROM user_project_roles WHERE user_id = ? AND project_id = ?')
    ->execute([$guestId, $projectId]);
$pdo->prepare('DELETE FROM music_sync WHERE track_key = ?')->execute([TRACK]);

register_shutdown_function(function () use ($pdo, $guestId, $projectId, $lockFile) {
    $pdo->prepare('DELETE FROM music_sync WHERE track_key = ?')->execute([TRACK]);
    $pdo->prepare('DELETE FROM user_project_roles WHERE user_id = ? AND project_id = ?')
        ->execute([$guestId, $projectId]);
    @unlink($lockFile);
});

@unlink($lockFile);

function trackRowCount(PDO $pdo): int
{
    $stmt = $pdo->prepare('SELECT COUNT(*) FROM music_sync WHERE track_key = ?');
    $stmt->execute([TRACK]);
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

    'MUSIC_ANALYSIS_LOCK' => $lockFile,
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

echo "music controller\n";

$trackParam = '&track=' . rawurlencode(TRACK);

// Reads stay public: the player works for everyone.
$res = request('GET', API . '?resource=sync');
check('anonymous sync list is 200', $res['status'] === 200, "got {$res['status']}");
check('sync list returns an array', is_array($res['body']));
check('no wildcard CORS header', !hasHeader($res['headers'], 'Access-Control-Allow-Origin'));

$res = request('GET', API . '?resource=sync' . $trackParam);
check('anonymous sync GET for missing track is 404', $res['status'] === 404, "got {$res['status']}");

$res = request('GET', API . '?resource=analysis');
check('anonymous analysis list is 200', $res['status'] === 200, "got {$res['status']}");

// Writes are gated.
$res = request('POST', API . '?resource=sync', null, syncBody());
check('anonymous saveSync is 401', $res['status'] === 401, "got {$res['status']}");
check('anonymous saveSync persists nothing', trackRowCount($pdo) === 0);

$res = request('POST', API . '?resource=sync', $GUEST_SID, syncBody());
check('role-less saveSync is 403', $res['status'] === 403, "got {$res['status']}");
check('role-less saveSync persists nothing', trackRowCount($pdo) === 0);

$res = request('DELETE', API . '?resource=sync' . $trackParam);
check('anonymous deleteSync is 401', $res['status'] === 401, "got {$res['status']}");

$res = request('DELETE', API . '?resource=sync' . $trackParam, $GUEST_SID);
check('role-less deleteSync is 403', $res['status'] === 403, "got {$res['status']}");

$res = postMultipart(API . '?resource=analysis');
check('anonymous analysis POST is 401', $res['status'] === 401, "got {$res['status']}");

$res = postMultipart(API . '?resource=analysis', $GUEST_SID);
check('role-less analysis POST is 403', $res['status'] === 403, "got {$res['status']}");

// Grant guest the editor role: the editor workflow works again.
$pdo->prepare('INSERT INTO user_project_roles (user_id, project_id, role) VALUES (?, ?, ?)')
    ->execute([$guestId, $projectId, 'editor']);

$res = request('POST', API . '?resource=sync', $GUEST_SID, syncBody());
check('editor saveSync is 200', $res['status'] === 200, "got {$res['status']} " . json_encode($res['body']));
check('saveSync persists the row', trackRowCount($pdo) === 1);
check('saveSync echoes the chords', count($res['body']['chords'] ?? []) === 2, json_encode($res['body']));

$res = request('POST', API . '?resource=sync', $GUEST_SID, ['track_key' => 'nope/../../etc.mp3']);
check('editor saveSync still validates the track key (400)', $res['status'] === 400, "got {$res['status']}");

// Public reads serve the saved data.
$res = request('GET', API . '?resource=sync' . $trackParam);
check('anonymous can read the saved sync (200)', $res['status'] === 200, "got {$res['status']}");
check('saved lyrics round-trip', ($res['body']['lyrics'] ?? '') === "Test line one\nTest line two");

// Admins pass the project gate implicitly.
$res = request('POST', API . '?resource=sync', $ADMIN_SID, syncBody());
check('admin saveSync is 200 (implicit project access)', $res['status'] === 200, "got {$res['status']}");

// Analysis: auth passes, then the lock and validation fire before exec().
$res = postMultipart(API . '?resource=analysis', $GUEST_SID);
check('editor analysis without a file is 400 (validation, no exec)', $res['status'] === 400, "got {$res['status']} " . json_encode($res['body']));

file_put_contents($lockFile, (string) getmypid());
$res = postMultipart(API . '?resource=analysis', $GUEST_SID);
check('analysis while another runs is 429 (fresh lock)', $res['status'] === 429, "got {$res['status']} " . json_encode($res['body']));

touch($lockFile, time() - 4000);
$res = postMultipart(API . '?resource=analysis', $GUEST_SID);
check('a stale lock is ignored (back to 400)', $res['status'] === 400, "got {$res['status']}");
@unlink($lockFile);

// Editor cleanup path: delete works and the row is gone.
$res = request('DELETE', API . '?resource=sync' . $trackParam, $GUEST_SID);
check('editor deleteSync is 200', $res['status'] === 200, "got {$res['status']}");
check('deleted row is gone', trackRowCount($pdo) === 0);
$res = request('GET', API . '?resource=sync' . $trackParam);
check('deleted sync GET is 404', $res['status'] === 404, "got {$res['status']}");

echo "\n$passed passed, $failed failed\n";
exit($failed === 0 ? 0 : 1);
