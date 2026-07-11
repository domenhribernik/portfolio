<?php
declare(strict_types=1);

// Integration tests for app/proxys/download.php (the views/download YouTube
// ripper: yt-dlp media + JSON sidecars in app/cache/download/, pruned after
// 3 hours).
//
// No network, no yt-dlp, no ffmpeg, no database: the suite boots the PHP
// built-in server once per host flavor, injecting YTDLP_BIN / FFMPEG_BIN /
// DOWNLOAD_CACHE_MAX_MB into the process environment (the proxy reads them
// via getenv() for exactly this reason):
//   1. dead yt-dlp + dead ffmpeg -> rip actions 503, health tells the steps apart
//      (plus an unset-YTDLP_BIN boot and a disable_functions=exec boot)
//   2. /bin/false                -> URL validation vs. exec reachability
//   3. a generated shell stub    -> the full prepare/file/cleanup lifecycle
//   3b. stub + dead ffmpeg       -> fresh rips refuse fast, cache still serves
//   4. stub + 1 MB cache cap     -> DOWNLOAD_CACHE_MAX_MB trims oldest-first
// Everything it creates (stubs, counters, cache files) is removed on shutdown.
//
// Run: /opt/lampp/bin/php tests/download.test.php

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit('CLI only');
}

const PHP_BIN   = '/opt/lampp/bin/php';
const DOC_ROOT  = __DIR__ . '/..';
const HOST      = '127.0.0.1';
const CACHE_DIR = DOC_ROOT . '/app/cache/download';
const VIDEO_ID  = 'jNQXAC9IVRw';
const STUB_TITLE = 'Stub Video: Ünïcode Tape';

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
//  HTTP helpers
// ------------------------------------------------------------------

$API = '';

/** @return array{status:int, body:mixed} */
function request(string $query, ?string $content = null, string $method = 'GET'): array
{
    global $API;
    $opts = ['http' => [
        'method'        => $method,
        'ignore_errors' => true,
        'timeout'       => 30,
    ]];
    if ($content !== null) {
        $opts['http']['header']  = 'Content-Type: application/json';
        $opts['http']['content'] = $content;
    }
    $raw = file_get_contents($API . '?' . $query, false, stream_context_create($opts));
    $status = 0;
    foreach ($http_response_header ?? [] as $h) {
        if (preg_match('#^HTTP/\S+\s+(\d{3})#', $h, $m)) {
            $status = (int) $m[1];
        }
    }
    return ['status' => $status, 'body' => $raw !== false ? json_decode($raw, true) : null];
}

/** Raw variant for action=file: keeps the body bytes and response headers. */
/** @return array{status:int, headers:string[], raw:string} */
function rawRequest(string $query): array
{
    global $API;
    $opts = ['http' => ['method' => 'GET', 'ignore_errors' => true, 'timeout' => 30]];
    $raw = file_get_contents($API . '?' . $query, false, stream_context_create($opts));
    $status = 0;
    $headers = $http_response_header ?? [];
    foreach ($headers as $h) {
        if (preg_match('#^HTTP/\S+\s+(\d{3})#', $h, $m)) {
            $status = (int) $m[1];
        }
    }
    return ['status' => $status, 'headers' => $headers, 'raw' => $raw === false ? '' : $raw];
}

function header_value(array $headers, string $name): string
{
    foreach ($headers as $h) {
        if (stripos($h, $name . ':') === 0) {
            return trim(substr($h, strlen($name) + 1));
        }
    }
    return '';
}

// ------------------------------------------------------------------
//  Server lifecycle (one boot per YTDLP_BIN) + teardown
// ------------------------------------------------------------------

$server = null;

function stopServer(): void
{
    global $server;
    if (is_resource($server)) {
        proc_terminate($server);
        proc_close($server);
    }
    $server = null;
}

function startServer(int $port, ?string $ytdlpBin, array $extraEnv = [], array $phpArgs = []): void
{
    global $server, $API;
    stopServer();
    // proc_open's env REPLACES the environment, so PATH must ride along
    // (the proxy's exec() needs it to find env/timeout/sh). A null
    // $ytdlpBin leaves YTDLP_BIN unset entirely (the unconfigured host).
    $env = array_merge(['PATH' => (string) getenv('PATH')], $extraEnv);
    if ($ytdlpBin !== null) {
        $env['YTDLP_BIN'] = $ytdlpBin;
    }
    $server = proc_open(
        array_merge([PHP_BIN], $phpArgs, ['-S', HOST . ':' . $port, '-t', DOC_ROOT]),
        [1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']],
        $pipes,
        DOC_ROOT,
        $env
    );
    for ($i = 0; $i < 50; $i++) {
        $sock = @fsockopen(HOST, $port, $errno, $errstr, 0.2);
        if ($sock) {
            fclose($sock);
            $API = 'http://' . HOST . ':' . $port . '/app/proxys/download.php';
            return;
        }
        usleep(100_000);
    }
    fwrite(STDERR, "Built-in PHP server did not start on port $port\n");
    exit(1);
}

$STUB    = sys_get_temp_dir() . '/ytdlp-stub-' . getmypid() . '.sh';
$COUNTER = sys_get_temp_dir() . '/ytdlp-stub-count-' . getmypid();

$idMp3 = substr(hash('sha256', VIDEO_ID . ':mp3'), 0, 16);
$idMp4 = substr(hash('sha256', VIDEO_ID . ':mp4'), 0, 16);

register_shutdown_function(function () use ($STUB, $COUNTER, $idMp3, $idMp4) {
    stopServer();
    @unlink($STUB);
    @unlink($COUNTER);
    foreach ([$idMp3, $idMp4] as $id) {
        foreach (glob(CACHE_DIR . '/' . $id . '.*') ?: [] as $file) {
            @unlink($file);
        }
    }
});

function stubInvocations(string $counter): int
{
    return is_file($counter) ? count(file($counter)) : 0;
}

// ------------------------------------------------------------------
//  Phase 1: yt-dlp missing -> graceful 503 (the prod shared host case)
// ------------------------------------------------------------------

echo "yt-dlp missing\n";
startServer(8942, '/nonexistent/yt-dlp', ['FFMPEG_BIN' => '/nonexistent/ffmpeg']);

$res = request('action=info', json_encode(['url' => 'https://youtu.be/' . VIDEO_ID]), 'POST');
check('info without yt-dlp answers 503', $res['status'] === 503, "status {$res['status']}");
check('and names the problem', ($res['body']['error'] ?? null) === 'ytdlp_missing');

$res = request('action=prepare', json_encode(['url' => 'https://youtu.be/' . VIDEO_ID, 'format' => 'mp3']), 'POST');
check('prepare without yt-dlp answers 503', $res['status'] === 503, "status {$res['status']}");

// This boot mirrors the broken shared host exactly: both binaries dead but
// configured. Health must let a browser tell apart every deployment step.
$res = request('action=health');
$h = $res['body'];
check('health reports yt-dlp missing', $res['status'] === 200 && ($h['ytdlp'] ?? null) === false,
    json_encode($h));
check('health reports ffmpeg missing', ($h['ffmpeg'] ?? null) === false, json_encode($h));
check('health flags YTDLP_BIN as configured-but-broken', ($h['ytdlpConfigured'] ?? null) === true, json_encode($h));
check('health confirms exec is enabled', ($h['execEnabled'] ?? null) === true, json_encode($h));
check('health confirms coreutils timeout exists', ($h['timeout'] ?? null) === true, json_encode($h));
check('health confirms the cache dir is writable', ($h['cacheDirWritable'] ?? null) === true, json_encode($h));

// With no YTDLP_BIN at all, health must say so (unset, not just broken).
startServer(8941, null, ['FFMPEG_BIN' => '/nonexistent/ffmpeg']);
$res = request('action=health');
check('an unset YTDLP_BIN reports unconfigured', $res['status'] === 200 && ($res['body']['ytdlpConfigured'] ?? null) === false,
    json_encode($res['body']));

// A host with exec() in disable_functions can never rip; health must show
// it and the rip actions must answer a clear 503 instead of a fatal 500.
startServer(8940, '/nonexistent/yt-dlp', [], ['-d', 'disable_functions=exec']);
$res = request('action=health');
$h = $res['body'];
check('disabled exec shows in health', $res['status'] === 200 && ($h['execEnabled'] ?? null) === false, json_encode($h));
check('and forces timeout to false', ($h['timeout'] ?? null) === false, json_encode($h));
$res = request('action=info', json_encode(['url' => 'https://youtu.be/' . VIDEO_ID]), 'POST');
check('info with disabled exec answers 503 exec_disabled',
    $res['status'] === 503 && ($res['body']['error'] ?? null) === 'exec_disabled', "status {$res['status']}");
$res = request('action=prepare', json_encode(['url' => 'https://youtu.be/' . VIDEO_ID, 'format' => 'mp3']), 'POST');
check('prepare with disabled exec answers 503 exec_disabled',
    $res['status'] === 503 && ($res['body']['error'] ?? null) === 'exec_disabled', "status {$res['status']}");

// ------------------------------------------------------------------
//  Phase 2: /bin/false -> validation is the gate, exec is the proof
// ------------------------------------------------------------------

echo "url validation\n";
startServer(8943, '/bin/false');

// Accepted shapes reach exec and fail there (502): validation passed.
$accepted = [
    'watch link'        => 'https://www.youtube.com/watch?v=' . VIDEO_ID,
    'short link'        => 'https://youtu.be/' . VIDEO_ID,
    'mobile link'       => 'https://m.youtube.com/watch?v=' . VIDEO_ID,
    'shorts link'       => 'https://www.youtube.com/shorts/' . VIDEO_ID,
    'schemeless paste'  => 'youtube.com/watch?v=' . VIDEO_ID,
];
foreach ($accepted as $label => $url) {
    $res = request('action=info', json_encode(['url' => $url]), 'POST');
    check("$label is accepted (fails only at exec)", $res['status'] === 502, "status {$res['status']}");
}

// Rejected shapes never reach the shell: 400 invalid_url.
$rejected = [
    'plain wrong site'      => 'https://example.com/watch?v=' . VIDEO_ID,
    'vimeo'                 => 'https://vimeo.com/123456789',
    'lookalike host'        => 'https://youtube.com.evil.com/watch?v=' . VIDEO_ID,
    'id of the wrong size'  => 'https://www.youtube.com/watch?v=tooShort00',
    'javascript scheme'     => 'javascript:alert(1)',
    'empty string'          => '',
];
foreach ($rejected as $label => $url) {
    $res = request('action=info', json_encode(['url' => $url]), 'POST');
    check("$label is rejected", $res['status'] === 400 && ($res['body']['error'] ?? null) === 'invalid_url',
        "status {$res['status']}");
}

echo "request validation\n";

$res = request('action=info');
check('info rejects GET', $res['status'] === 405, "status {$res['status']}");

$res = request('action=prepare');
check('prepare rejects GET', $res['status'] === 405, "status {$res['status']}");

$res = request('action=info', 'not json{', 'POST');
check('broken JSON is refused', $res['status'] === 400 && ($res['body']['error'] ?? null) === 'invalid_json');

$res = request('action=info', str_repeat('x', 10000), 'POST');
check('an oversized body is refused', $res['status'] === 413, "status {$res['status']}");

$res = request('action=prepare', json_encode(['url' => 'https://youtu.be/' . VIDEO_ID, 'format' => 'flac']), 'POST');
check('formats other than mp3/mp4 are refused', $res['status'] === 400 && ($res['body']['error'] ?? null) === 'invalid_format');

$res = request('action=prepare', json_encode(['url' => 'https://youtu.be/' . VIDEO_ID]), 'POST');
check('a missing format is refused', $res['status'] === 400, "status {$res['status']}");

$res = request('action=file&id=' . urlencode('../../app/.env'));
check('a traversal id is refused', $res['status'] === 400 && ($res['body']['error'] ?? null) === 'invalid_id');

$res = request('action=file&id=' . str_repeat('a', 16));
check('an unknown id 404s', $res['status'] === 404, "status {$res['status']}");

$res = request('action=nonsense');
check('unknown actions 400', $res['status'] === 400, "status {$res['status']}");

// ------------------------------------------------------------------
//  Phase 3: stub yt-dlp -> the full prepare/file/cleanup lifecycle
// ------------------------------------------------------------------

echo "rip lifecycle (stub yt-dlp)\n";

// The stub honors just enough of the real interface: -J prints metadata,
// otherwise it writes fake media at the -o path (mp3 when -x is present)
// and the metadata JSON at the --print-to-file target. Every invocation
// appends to the counter file so cache hits are provable.
$stubScript = <<<SH
#!/bin/sh
echo run >> "$COUNTER"
ext=mp4
out=""
meta=""
while [ \$# -gt 0 ]; do
  case "\$1" in
    -J) printf '%s\\n' '{"title":"Stub Video: Ünïcode Tape","channel":"Stub Channel","duration":42,"thumbnail":"https://example.com/thumb.jpg"}'; exit 0 ;;
    -x) ext=mp3 ;;
    -o) out="\$2"; shift ;;
    --print-to-file) meta="\$3"; shift 2 ;;
  esac
  shift
done
[ -n "\$out" ] || exit 1
out=\$(printf '%s' "\$out" | sed "s/%(ext)s/\$ext/")
printf 'FAKEMEDIA' > "\$out"
if [ -n "\$meta" ]; then
  printf '%s' '{"title":"Stub Video: Ünïcode Tape","channel":"Stub Channel","duration":42}' > "\$meta"
fi
exit 0
SH;
file_put_contents($STUB, $stubScript);
chmod($STUB, 0755);

// FFMPEG_BIN is pinned to /bin/true so the lifecycle phases pass on a box
// with no ffmpeg installed (the stub does the writing, not ffmpeg).
startServer(8944, $STUB, ['FFMPEG_BIN' => '/bin/true']);

$res = request('action=info', json_encode(['url' => 'https://youtu.be/' . VIDEO_ID]), 'POST');
check('info returns the metadata', $res['status'] === 200, "status {$res['status']}");
check('info carries title, channel, duration, thumbnail',
    ($res['body']['title'] ?? null) === STUB_TITLE
    && ($res['body']['channel'] ?? null) === 'Stub Channel'
    && ($res['body']['durationSeconds'] ?? null) === 42
    && !empty($res['body']['thumbnail']));

$before = stubInvocations($COUNTER);
$res = request('action=prepare', json_encode(['url' => 'https://youtu.be/' . VIDEO_ID, 'format' => 'mp3']), 'POST');
check('prepare mp3 succeeds', $res['status'] === 200, "status {$res['status']}");
check('the job id is the deterministic hash', ($res['body']['id'] ?? null) === $idMp3);
check('the filename is the sanitized title', ($res['body']['filename'] ?? null) === 'Stub Video Ünïcode Tape.mp3',
    'got ' . json_encode($res['body']['filename'] ?? null));
check('the size is the media size', ($res['body']['size'] ?? null) === 9);
check('the media file landed in the cache', is_file(CACHE_DIR . '/' . $idMp3 . '.mp3'));
check('the sidecar landed next to it', is_file(CACHE_DIR . '/' . $idMp3 . '.json'));
check('exactly one yt-dlp run happened', stubInvocations($COUNTER) === $before + 1);

$res = request('action=prepare', json_encode(['url' => 'https://www.youtube.com/watch?v=' . VIDEO_ID, 'format' => 'mp3']), 'POST');
check('a repeat prepare is a cache hit', $res['status'] === 200 && ($res['body']['id'] ?? null) === $idMp3);
check('and does not run yt-dlp again', stubInvocations($COUNTER) === $before + 1);

$res = request('action=prepare', json_encode(['url' => 'https://youtu.be/' . VIDEO_ID, 'format' => 'mp4']), 'POST');
check('prepare mp4 gets its own job', $res['status'] === 200 && ($res['body']['id'] ?? null) === $idMp4);
check('with an mp4 filename', ($res['body']['filename'] ?? null) === 'Stub Video Ünïcode Tape.mp4');

$res = rawRequest('action=file&id=' . $idMp3);
check('the mp3 downloads', $res['status'] === 200 && $res['raw'] === 'FAKEMEDIA');
check('as audio/mpeg', stripos(header_value($res['headers'], 'Content-Type'), 'audio/mpeg') === 0);
check('with the exact byte count', header_value($res['headers'], 'Content-Length') === '9');
$disposition = header_value($res['headers'], 'Content-Disposition');
check('as an attachment named after the video',
    stripos($disposition, 'attachment') === 0
    && str_contains($disposition, 'filename="Stub Video _n_code Tape.mp3"')
    && str_contains($disposition, "filename*=UTF-8''Stub%20Video%20%C3%9Cn%C3%AFcode%20Tape.mp3"),
    $disposition);

$res = rawRequest('action=file&id=' . $idMp4);
check('the mp4 downloads as video/mp4', $res['status'] === 200
    && stripos(header_value($res['headers'], 'Content-Type'), 'video/mp4') === 0);

// Age both mp3 files past the 3 hour window; cleanup must reap the pair.
touch(CACHE_DIR . '/' . $idMp3 . '.mp3', time() - 4 * 60 * 60);
touch(CACHE_DIR . '/' . $idMp3 . '.json', time() - 4 * 60 * 60);
$res = request('action=cleanup');
check('cleanup reaps the aged pair', ($res['body']['deleted'] ?? 0) >= 2, json_encode($res['body']));
check('the fresh mp4 survives', is_file(CACHE_DIR . '/' . $idMp4 . '.mp4'));
$res = request('action=file&id=' . $idMp3);
check('a pruned id 404s', $res['status'] === 404, "status {$res['status']}");

// ------------------------------------------------------------------
//  Phase 3b: ffmpeg missing -> fresh rips refuse fast, the cache still serves
// ------------------------------------------------------------------
//
// mp3 extraction and mp4 stream merging both need ffmpeg, so a fresh rip
// must refuse instantly with a clear code instead of downloading the whole
// video first and dying as a generic 502. info (metadata only) and already
// ripped files keep working.

echo "ffmpeg missing (fail-fast)\n";

$ffVideoId = 'aB3dE5fG7h9';   // fresh id: nothing cached for it
$idFfMp3 = substr(hash('sha256', $ffVideoId . ':mp3'), 0, 16);
$idFfMp4 = substr(hash('sha256', $ffVideoId . ':mp4'), 0, 16);
register_shutdown_function(function () use ($idFfMp3, $idFfMp4) {
    foreach ([$idFfMp3, $idFfMp4] as $id) {
        foreach (glob(CACHE_DIR . '/' . $id . '.*') ?: [] as $file) {
            @unlink($file);
        }
    }
});

startServer(8946, $STUB, ['FFMPEG_BIN' => '/nonexistent/ffmpeg']);

$res = request('action=info', json_encode(['url' => 'https://youtu.be/' . $ffVideoId]), 'POST');
check('info needs no ffmpeg', $res['status'] === 200, "status {$res['status']}");

$before = stubInvocations($COUNTER);
$res = request('action=prepare', json_encode(['url' => 'https://youtu.be/' . $ffVideoId, 'format' => 'mp3']), 'POST');
check('a fresh mp3 rip without ffmpeg refuses fast',
    $res['status'] === 503 && ($res['body']['error'] ?? null) === 'ffmpeg_missing', "status {$res['status']}");
$res = request('action=prepare', json_encode(['url' => 'https://youtu.be/' . $ffVideoId, 'format' => 'mp4']), 'POST');
check('a fresh mp4 rip without ffmpeg refuses fast too',
    $res['status'] === 503 && ($res['body']['error'] ?? null) === 'ffmpeg_missing', "status {$res['status']}");
check('and yt-dlp never ran', stubInvocations($COUNTER) === $before);

$res = request('action=prepare', json_encode(['url' => 'https://youtu.be/' . VIDEO_ID, 'format' => 'mp4']), 'POST');
check('an already-ripped job still serves from cache', $res['status'] === 200 && ($res['body']['id'] ?? null) === $idMp4,
    "status {$res['status']}");
check('again without running yt-dlp', stubInvocations($COUNTER) === $before);

// ------------------------------------------------------------------
//  Phase 4: DOWNLOAD_CACHE_MAX_MB caps the cache
// ------------------------------------------------------------------
//
// The 2 GB default cap must be shrinkable from .env for a small disk. The
// old fixture is bigger than the whole 1 MB cap, so a trim can never keep
// it; the new one always fits.

echo "cache size cap (DOWNLOAD_CACHE_MAX_MB)\n";

$capA = CACHE_DIR . '/captest-a.tmp';
$capB = CACHE_DIR . '/captest-b.tmp';
register_shutdown_function(function () use ($capA, $capB) {
    @unlink($capA);
    @unlink($capB);
});
file_put_contents($capA, str_repeat('A', 1_200_000));
file_put_contents($capB, str_repeat('B', 100_000));
touch($capA, time() - 120);
touch($capB, time() - 60);

startServer(8947, $STUB, ['FFMPEG_BIN' => '/bin/true']);
$res = request('action=cleanup');
check('fresh files survive cleanup under the default cap', is_file($capA) && is_file($capB),
    json_encode($res['body']));

startServer(8948, $STUB, ['FFMPEG_BIN' => '/bin/true', 'DOWNLOAD_CACHE_MAX_MB' => '1']);
$res = request('action=cleanup');
check('a 1 MB override trims the oldest file out', !is_file($capA), json_encode($res['body']));
check('and keeps the newest one that fits', is_file($capB));
check('reporting at least one deletion', ($res['body']['deleted'] ?? 0) >= 1, json_encode($res['body']));

// ------------------------------------------------------------------

echo "\n$passed passed, $failed failed\n";
exit($failed === 0 ? 0 : 1);
