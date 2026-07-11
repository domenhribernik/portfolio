<?php
// Backend for the unlisted views/download tool: rips a YouTube video to mp3
// or mp4 by shelling out to yt-dlp (there is no viable pure-PHP downloader;
// YouTube rotates its signature ciphering constantly). Same single-file shape
// as tarok.php/flowers.php: route by ?action=, no auth (the view is unlisted,
// anyone with the URL may use it), files stored in app/cache/download/ and
// pruned after 3 hours.
//
// Host requirements (the endpoint answers 503 ytdlp_missing without them):
//
// With shell access (e.g. this XAMPP box):
//   sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
//   sudo chmod a+rx /usr/local/bin/yt-dlp
//   mkdir -m 777 app/cache/download   # Apache's daemon user cannot mkdir under app/cache/
// YouTube breaks yt-dlp regularly; if downloads start failing, update it:
//   sudo /usr/local/bin/yt-dlp -U
//
// Shared/cPanel hosting with no shell (FTP only, exec() still works, as
// proven by music-controller.php running analyze_audio.py + ffmpeg there):
// download https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp
// and FTP-upload the plain file anywhere under your home directory (no
// chmod needed, it runs through python3 instead, see ytdlpCmdPrefix()
// below), then add to the prod app/.env: YTDLP_BIN=/absolute/path/to/yt-dlp
// To update later: re-upload the latest release over the old file.
//
// Optional overrides in app/.env: YTDLP_BIN, FFMPEG_BIN (absolute paths),
// PYTHON_BIN (bare command or absolute path, defaults to python3).

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

const MAX_BODY_BYTES        = 4096;
const MAX_AGE_SECONDS       = 3 * 60 * 60;          // media lives 3 hours
const MAX_CACHE_BYTES       = 2 * 1024 * 1024 * 1024;
const MAX_DURATION_SECONDS  = 7200;                 // 2 hour video cap
const MAX_FILESIZE          = '500M';
const MAX_CONCURRENT        = 3;                    // simultaneous rips
const INFO_TIMEOUT          = 60;                   // seconds, coreutils timeout
const PREPARE_TIMEOUT       = 600;

$cacheDir = __DIR__ . '/../cache/download';
if (!is_dir($cacheDir)) {
    // Only effective under php -S (tests); Apache's daemon user cannot
    // create directories under app/cache, the dir must pre-exist there.
    @mkdir($cacheDir, 0775, true);
}

// Optional app/.env overrides (YTDLP_BIN, FFMPEG_BIN), loaded the silent way
// database.php does. Missing vendor or .env is fine: the path probing below
// still finds a system-wide install.
require_once __DIR__ . '/../config/dev-mode.php';
$envBase   = $DEV_MODE ? dirname(__DIR__) : '/usr/home/meuhdy';
$envVendor = ($DEV_MODE ? dirname(__DIR__) . '/vendor' : '/usr/home/meuhdy/vendor') . '/autoload.php';
if (empty($_ENV['YTDLP_BIN']) && file_exists($envVendor) && file_exists($envBase . '/.env')) {
    try {
        require_once $envVendor;
        Dotenv\Dotenv::createImmutable($envBase)->safeLoad();
    } catch (Exception $e) {
        error_log('download.php dotenv error: ' . $e->getMessage());
    }
}

function respond(array $data, int $status = 200): never
{
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

function fail(string $code, int $status): never
{
    respond(['error' => $code], $status);
}

// Resolve a binary: explicit env override first (getenv() because with
// variables_order=GPCS the process environment, which the tests inject, is
// invisible to $_ENV; $_ENV only carries app/.env via dotenv), then known
// absolute paths. An override that is set but not executable resolves to
// null rather than falling through, so a bad config fails loudly.
function resolveBin(string $envKey, array $fallbacks): ?string
{
    $bin = getenv($envKey);
    if ($bin === false || $bin === '') {
        $bin = isset($_ENV[$envKey]) && is_string($_ENV[$envKey]) ? $_ENV[$envKey] : '';
    }
    if ($bin !== '') {
        return is_executable($bin) ? $bin : null;
    }
    foreach ($fallbacks as $path) {
        if (is_executable($path)) {
            return $path;
        }
    }
    return null;
}

// yt-dlp's standalone release is itself a Python zipapp: it can run either
// directly (its own shebang, needs the executable bit) or as `python3
// <path>`. An explicit YTDLP_BIN override only needs to be readable, not
// executable, so it can be FTP-uploaded onto a shared host with no shell
// access and no way to chmod it; ytdlpInvocation() below picks the right
// form. The local absolute-path fallbacks stay executable-gated since a
// real local install always has correct permissions.
function resolveYtdlp(): ?string
{
    $bin = getenv('YTDLP_BIN');
    if ($bin === false || $bin === '') {
        $bin = isset($_ENV['YTDLP_BIN']) && is_string($_ENV['YTDLP_BIN']) ? $_ENV['YTDLP_BIN'] : '';
    }
    if ($bin !== '') {
        return is_file($bin) && is_readable($bin) ? $bin : null;
    }
    foreach (['/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp'] as $path) {
        if (is_executable($path)) {
            return $path;
        }
    }
    return null;
}

function resolveFfmpeg(): ?string
{
    return resolveBin('FFMPEG_BIN', ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg']);
}

// Same $_ENV-then-getenv precedent as PYTHON_BIN in music-controller.php.
// Always returns a usable value: python3 is assumed present, exactly as
// analyze_audio.py already assumes it in production.
function resolvePython(): string
{
    $py = getenv('PYTHON_BIN');
    if ($py === false || $py === '') {
        $py = isset($_ENV['PYTHON_BIN']) && is_string($_ENV['PYTHON_BIN']) ? $_ENV['PYTHON_BIN'] : '';
    }
    return $py !== '' ? $py : 'python3';
}

// Pull the 11-char video id out of a pasted YouTube URL. Only the rebuilt
// canonical URL ever reaches the shell, so no user-controlled bytes hit the
// command line (escapeshellarg and the -- separator stay as belt and braces).
function extractVideoId($url): ?string
{
    if (!is_string($url) || strlen($url) > 300) {
        return null;
    }
    $url = trim($url);
    if ($url === '') {
        return null;
    }
    if (!preg_match('~^https?://~i', $url)) {
        $url = 'https://' . $url;   // tolerate a pasted URL without scheme
    }
    $parts = parse_url($url);
    if ($parts === false || empty($parts['host']) || !in_array(strtolower($parts['scheme'] ?? ''), ['http', 'https'], true)) {
        return null;
    }
    $host = strtolower($parts['host']);
    $path = $parts['path'] ?? '';
    $allowed = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be'];
    if (!in_array($host, $allowed, true)) {
        return null;
    }

    $candidate = null;
    if ($host === 'youtu.be' || $host === 'www.youtu.be') {
        $segments = explode('/', ltrim($path, '/'));
        $candidate = $segments[0] ?? '';
    } elseif ($path === '/watch') {
        parse_str($parts['query'] ?? '', $query);
        $candidate = $query['v'] ?? null;
    } elseif (preg_match('~^/(shorts|live|embed)/([^/?#]+)~', $path, $m)) {
        $candidate = $m[2];
    }

    if (!is_string($candidate) || !preg_match('/^[A-Za-z0-9_-]{11}$/', $candidate)) {
        return null;
    }
    return $candidate;
}

function canonicalUrl(string $videoId): string
{
    return 'https://www.youtube.com/watch?v=' . $videoId;
}

// Deterministic job id: a repeat request for the same video and format is an
// instant cache hit, and concurrent duplicates serialize on the same lock.
function jobId(string $videoId, string $format): string
{
    return substr(hash('sha256', $videoId . ':' . $format), 0, 16);
}

// Human filename for the browser download, built from the server-derived
// title (never a client-supplied one).
function downloadFilename(string $title, string $videoId, string $format): string
{
    $name = preg_replace('/[\x00-\x1f\x7f<>:"\/\\\\|?*]+/', ' ', $title);
    $name = trim(preg_replace('/\s+/u', ' ', $name) ?? '');
    $name = mb_substr($name, 0, 120);
    if ($name === '') {
        $name = 'youtube-' . $videoId;
    }
    return $name . '.' . $format;
}

// The shared command prefix. env -u LD_LIBRARY_PATH is the mandatory XAMPP
// gotcha (its bundled libstdc++ breaks system ffmpeg with CXXABI errors).
// coreutils timeout is the only real guard against a hung download:
// max_execution_time counts PHP's own CPU time, not time blocked in exec(),
// so PHP alone can never kill a stuck yt-dlp. If the resolved yt-dlp path
// is not itself executable (an FTP-uploaded file with no chmod available),
// run it through python3 instead, same as analyze_audio.py already runs.
function ytdlpCmdPrefix(string $bin, int $timeoutSeconds): string
{
    $invoke = is_executable($bin)
        ? escapeshellcmd($bin)
        : escapeshellcmd(resolvePython()) . ' ' . escapeshellarg($bin);
    return 'env -u LD_LIBRARY_PATH timeout -k 15 ' . $timeoutSeconds . ' ' . $invoke;
}

// Flags shared by every invocation. --no-mtime matters: yt-dlp otherwise
// stamps the file with the video's upload date, which would make fresh
// downloads instantly prunable. --no-cache-dir because the daemon user's
// HOME is not writable.
const YTDLP_COMMON_FLAGS = ' --no-playlist --no-warnings --no-progress --no-mtime --no-cache-dir --socket-timeout 15 --retries 3';

function timedOut(int $exitCode): bool
{
    return $exitCode === 124 || $exitCode === 137;   // timeout's TERM / KILL exits
}

// Delete expired files, then trim oldest-first if the cache still exceeds
// the size cap. Lock files are skipped in the size pass so an active job's
// lock is never yanked out from under it (the age pass still clears stale ones).
function pruneCache(string $cacheDir): int
{
    $deleted = 0;
    $cutoff = time() - MAX_AGE_SECONDS;
    $survivors = [];
    foreach (glob($cacheDir . '/*') as $file) {
        if (!is_file($file)) {
            continue;
        }
        $mtime = filemtime($file);
        if ($mtime < $cutoff) {
            if (@unlink($file)) {
                $deleted++;
            }
            continue;
        }
        $survivors[] = [$file, $mtime, filesize($file)];
    }

    $total = 0;
    foreach ($survivors as [, , $size]) {
        $total += $size;
    }
    if ($total > MAX_CACHE_BYTES) {
        usort($survivors, fn($a, $b) => $a[1] <=> $b[1]);
        foreach ($survivors as [$file, , $size]) {
            if ($total <= MAX_CACHE_BYTES) {
                break;
            }
            if (substr($file, -5) === '.lock') {
                continue;
            }
            if (@unlink($file)) {
                $deleted++;
                $total -= $size;
            }
        }
    }
    return $deleted;
}

function readJsonBody(): array
{
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        fail('method_not_allowed', 405);
    }
    $raw = file_get_contents('php://input');
    if ($raw === false || strlen($raw) > MAX_BODY_BYTES) {
        fail('payload_too_large', 413);
    }
    $body = json_decode($raw, true);
    if (json_last_error() !== JSON_ERROR_NONE || !is_array($body)) {
        fail('invalid_json', 400);
    }
    return $body;
}

// Run yt-dlp -J for a video and return the decoded metadata array.
function fetchInfo(string $bin, string $videoId): array
{
    $cmd = ytdlpCmdPrefix($bin, INFO_TIMEOUT)
        . ' -J --skip-download' . YTDLP_COMMON_FLAGS
        . ' -- ' . escapeshellarg(canonicalUrl($videoId)) . ' 2>&1';
    exec($cmd, $lines, $exitCode);

    if (timedOut($exitCode)) {
        fail('info_timeout', 504);
    }
    $meta = null;
    foreach ($lines as $line) {
        if (isset($line[0]) && $line[0] === '{') {
            $meta = json_decode($line, true);
            if (is_array($meta)) {
                break;
            }
        }
    }
    if ($exitCode !== 0 || !is_array($meta)) {
        error_log("download.php info failed (exit $exitCode): " . substr(implode("\n", $lines), 0, 500));
        fail('info_failed', 502);
    }
    return $meta;
}

$action = isset($_GET['action']) && is_string($_GET['action']) ? $_GET['action'] : '';

// Deployment smoke test, safe to expose (booleans only, no paths): open
// ?action=health in a browser to see whether this host can rip at all.
// A 400 unknown_action here means an older download.php is still deployed.
if ($action === 'health') {
    respond([
        'ytdlp'  => resolveYtdlp() !== null,
        'ffmpeg' => resolveFfmpeg() !== null,
    ]);
}

if ($action === 'info') {
    $body = readJsonBody();
    $videoId = extractVideoId($body['url'] ?? null);
    if ($videoId === null) {
        fail('invalid_url', 400);
    }
    $bin = resolveYtdlp();
    if ($bin === null) {
        fail('ytdlp_missing', 503);
    }

    $meta = fetchInfo($bin, $videoId);
    if (!empty($meta['is_live'])) {
        fail('live_stream', 422);
    }
    respond([
        'videoId'         => $videoId,
        'title'           => isset($meta['title']) && is_string($meta['title']) ? $meta['title'] : 'youtube-' . $videoId,
        'channel'         => $meta['channel'] ?? $meta['uploader'] ?? '',
        'durationSeconds' => (int) ($meta['duration'] ?? 0),
        'thumbnail'       => isset($meta['thumbnail']) && is_string($meta['thumbnail']) ? $meta['thumbnail'] : null,
    ]);
}

if ($action === 'prepare') {
    $body = readJsonBody();
    $videoId = extractVideoId($body['url'] ?? null);
    if ($videoId === null) {
        fail('invalid_url', 400);
    }
    $format = $body['format'] ?? '';
    if ($format !== 'mp3' && $format !== 'mp4') {
        fail('invalid_format', 400);
    }
    $bin = resolveYtdlp();
    if ($bin === null) {
        fail('ytdlp_missing', 503);
    }

    $id      = jobId($videoId, $format);
    $media   = $cacheDir . '/' . $id . '.' . $format;
    $sidecar = $cacheDir . '/' . $id . '.json';

    $cacheHit = function () use ($media, $sidecar): ?array {
        if (!is_file($media) || !is_file($sidecar)) {
            return null;
        }
        $job = json_decode((string) file_get_contents($sidecar), true);
        if (!is_array($job)) {
            return null;
        }
        // Reset the 3 hour clock for both files, the pair ages together.
        @touch($media);
        @touch($sidecar);
        return $job;
    };

    if (($job = $cacheHit()) !== null) {
        respond(['id' => $id, 'format' => $format, 'filename' => $job['filename'], 'size' => $job['size']]);
    }
    if (count(glob($cacheDir . '/*.part')) >= MAX_CONCURRENT) {
        fail('busy', 429);
    }
    pruneCache($cacheDir);

    $lockPath = $cacheDir . '/' . $id . '.lock';
    $lock = fopen($lockPath, 'c');
    if ($lock === false || !flock($lock, LOCK_EX)) {
        fail('busy', 429);
    }
    // Another request may have finished this exact job while we waited.
    if (($job = $cacheHit()) !== null) {
        flock($lock, LOCK_UN);
        fclose($lock);
        @unlink($lockPath);
        respond(['id' => $id, 'format' => $format, 'filename' => $job['filename'], 'size' => $job['size']]);
    }

    set_time_limit(0);   // the real cap is the coreutils timeout on the child

    $metaPath = $cacheDir . '/' . $id . '.meta';
    $ffmpeg = resolveFfmpeg();
    $formatFlags = $format === 'mp3'
        ? ' -f bestaudio -x --audio-format mp3 --audio-quality 0'
        : ' -f ' . escapeshellarg('bv*[vcodec^=avc1][height<=1080]+ba[ext=m4a]/b[ext=mp4][height<=1080]/b[height<=1080]/b')
            . ' --merge-output-format mp4 --remux-video mp4';

    $cmd = ytdlpCmdPrefix($bin, PREPARE_TIMEOUT)
        . YTDLP_COMMON_FLAGS
        . ' --match-filters ' . escapeshellarg('duration<=' . MAX_DURATION_SECONDS . ' & !is_live')
        . ' --max-filesize ' . MAX_FILESIZE
        . ($ffmpeg !== null ? ' --ffmpeg-location ' . escapeshellarg($ffmpeg) : '')
        . $formatFlags
        . ' --print-to-file ' . escapeshellarg('after_move:%(.{title,channel,duration})j') . ' ' . escapeshellarg($metaPath)
        . ' -o ' . escapeshellarg($cacheDir . '/' . $id . '.%(ext)s')
        . ' -- ' . escapeshellarg(canonicalUrl($videoId)) . ' 2>&1';
    exec($cmd, $lines, $exitCode);

    $failCleanup = function () use ($cacheDir, $id, $lock, $lockPath): void {
        foreach (glob($cacheDir . '/' . $id . '.*') as $leftover) {
            if ($leftover !== $lockPath) {
                @unlink($leftover);
            }
        }
        flock($lock, LOCK_UN);
        fclose($lock);
        @unlink($lockPath);
    };

    // The output file existing and being non-empty is the source of truth;
    // a filter skip (too long, too large, live) exits 0 with no file.
    if (timedOut($exitCode)) {
        $failCleanup();
        fail('download_timeout', 504);
    }
    if (!is_file($media) || filesize($media) === 0) {
        if ($exitCode === 0) {
            $failCleanup();
            fail('video_rejected', 422);
        }
        error_log("download.php prepare failed (exit $exitCode): " . substr(implode("\n", $lines), 0, 500));
        $failCleanup();
        fail('download_failed', 502);
    }

    $meta = is_file($metaPath) ? json_decode((string) file_get_contents($metaPath), true) : null;
    @unlink($metaPath);
    $title = is_array($meta) && isset($meta['title']) && is_string($meta['title']) ? $meta['title'] : '';
    $job = [
        'v'         => 1,
        'videoId'   => $videoId,
        'format'    => $format,
        'file'      => $id . '.' . $format,
        'title'     => $title,
        'filename'  => downloadFilename($title, $videoId, $format),
        'size'      => filesize($media),
        'createdAt' => gmdate('c'),
    ];
    file_put_contents($sidecar, json_encode($job, JSON_UNESCAPED_UNICODE), LOCK_EX);

    flock($lock, LOCK_UN);
    fclose($lock);
    @unlink($lockPath);

    respond(['id' => $id, 'format' => $format, 'filename' => $job['filename'], 'size' => $job['size']]);
}

if ($action === 'file') {
    $id = isset($_GET['id']) && is_string($_GET['id']) ? $_GET['id'] : '';
    if (!preg_match('/^[a-f0-9]{16}$/', $id)) {
        fail('invalid_id', 400);
    }
    $sidecar = $cacheDir . '/' . $id . '.json';
    $job = is_file($sidecar) ? json_decode((string) file_get_contents($sidecar), true) : null;
    $media = is_array($job) && isset($job['file']) ? $cacheDir . '/' . basename((string) $job['file']) : null;
    if ($media === null || !is_file($media)) {
        fail('not_found', 404);
    }

    // An active download should not age out mid-session.
    @touch($media);
    @touch($sidecar);

    $filename = isset($job['filename']) && is_string($job['filename']) && $job['filename'] !== ''
        ? $job['filename']
        : 'youtube-' . $id . '.' . ($job['format'] ?? 'mp4');
    // One underscore per character, not per byte; the byte-wise pass only
    // runs if the title somehow is not valid UTF-8.
    $ascii = preg_replace('/[^\x20-\x7e]/u', '_', $filename)
        ?? preg_replace('/[^\x20-\x7e]/', '_', $filename);
    $ascii = str_replace(['"', '\\'], '_', $ascii);

    header('Content-Type: ' . (($job['format'] ?? '') === 'mp3' ? 'audio/mpeg' : 'video/mp4'));
    header('Content-Length: ' . filesize($media));
    header('Content-Disposition: attachment; filename="' . $ascii . '"; filename*=UTF-8\'\'' . rawurlencode($filename));
    header('X-Content-Type-Options: nosniff');

    // Kill php.ini's output_buffering=4096 so readfile() streams the file in
    // chunks instead of accumulating it (the classic large-readfile OOM).
    while (ob_get_level() > 0) {
        ob_end_clean();
    }
    readfile($media);
    exit;
}

if ($action === 'cleanup') {
    respond(['deleted' => pruneCache($cacheDir)]);
}

fail('unknown_action', 400);
