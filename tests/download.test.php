<?php
declare(strict_types=1);

// Integration tests for app/proxys/download.php (the views/download YouTube
// ripper: yt-dlp media + JSON sidecars in app/cache/download/, pruned after
// 3 hours).
//
// No network, no yt-dlp, no database: the suite boots the PHP built-in
// server three times with a different YTDLP_BIN injected into the process
// environment (the proxy reads it via getenv() for exactly this reason):
//   1. a nonexistent path        -> every rip action answers 503
//   2. /bin/false                -> URL validation vs. exec reachability
//   3. a generated shell stub    -> the full prepare/file/cleanup lifecycle
// Everything it creates (stub, counter, cache files) is removed on shutdown.
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

function startServer(int $port, string $ytdlpBin): void
{
    global $server, $API;
    stopServer();
    // proc_open's env REPLACES the environment, so PATH must ride along
    // (the proxy's exec() needs it to find env/timeout/sh).
    $env = ['PATH' => (string) getenv('PATH'), 'YTDLP_BIN' => $ytdlpBin];
    $server = proc_open(
        [PHP_BIN, '-S', HOST . ':' . $port, '-t', DOC_ROOT],
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
startServer(8942, '/nonexistent/yt-dlp');

$res = request('action=info', json_encode(['url' => 'https://youtu.be/' . VIDEO_ID]), 'POST');
check('info without yt-dlp answers 503', $res['status'] === 503, "status {$res['status']}");
check('and names the problem', ($res['body']['error'] ?? null) === 'ytdlp_missing');

$res = request('action=prepare', json_encode(['url' => 'https://youtu.be/' . VIDEO_ID, 'format' => 'mp3']), 'POST');
check('prepare without yt-dlp answers 503', $res['status'] === 503, "status {$res['status']}");

$res = request('action=health');
check('health reports yt-dlp missing', $res['status'] === 200 && ($res['body']['ytdlp'] ?? null) === false,
    json_encode($res['body']));

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

startServer(8944, $STUB);

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
//  Phase 4: an FTP-uploaded, non-executable yt-dlp falls back to python3
// ------------------------------------------------------------------
//
// Simulates shared/cPanel hosting: no shell to chmod the uploaded file, so
// ytdlpCmdPrefix() in download.php must invoke it as `python3 <path>`
// instead of executing it directly. A shell-script stub can't stand in
// here (python3 can't interpret sh syntax), so this phase uses a real
// (tiny) Python stub, deliberately left non-executable.

echo "python3 fallback (non-executable yt-dlp)\n";

$pyVideoId = 'zzPyFallbk1';
$idPy = substr(hash('sha256', $pyVideoId . ':mp3'), 0, 16);
$STUB_PY = sys_get_temp_dir() . '/ytdlp-stub-py-' . getmypid() . '.py';
$COUNTER_PY = sys_get_temp_dir() . '/ytdlp-stub-py-count-' . getmypid();

register_shutdown_function(function () use ($STUB_PY, $COUNTER_PY, $idPy) {
    @unlink($STUB_PY);
    @unlink($COUNTER_PY);
    foreach (glob(CACHE_DIR . '/' . $idPy . '.*') ?: [] as $file) {
        @unlink($file);
    }
});

$pyStub = <<<PY
#!/usr/bin/env python3
import sys
with open("$COUNTER_PY", "a") as f:
    f.write("run\\n")
args = sys.argv[1:]
if "-J" in args:
    print('{"title":"Stub Video: Ünïcode Tape","channel":"Stub Channel","duration":42,"thumbnail":"https://example.com/thumb.jpg"}')
    sys.exit(0)
ext = "mp3" if "-x" in args else "mp4"
out = None
meta = None
i = 0
while i < len(args):
    if args[i] == "-o":
        out = args[i + 1]
        i += 2
        continue
    if args[i] == "--print-to-file":
        meta = args[i + 2]
        i += 3
        continue
    i += 1
if not out:
    sys.exit(1)
out = out.replace("%(ext)s", ext)
with open(out, "w") as f:
    f.write("PYSTUBMEDIA")
if meta:
    with open(meta, "w") as f:
        f.write('{"title":"Stub Video: Ünïcode Tape","channel":"Stub Channel","duration":42}')
sys.exit(0)
PY;
file_put_contents($STUB_PY, $pyStub);
chmod($STUB_PY, 0644);   // deliberately not executable: the whole point of this phase
check('the stub file is not executable', !is_executable($STUB_PY));

startServer(8945, $STUB_PY);

$res = request('action=health');
check('health reports the non-executable upload as usable', $res['status'] === 200 && ($res['body']['ytdlp'] ?? null) === true,
    json_encode($res['body']));

$res = request('action=info', json_encode(['url' => 'https://youtu.be/' . $pyVideoId]), 'POST');
check('info succeeds through the python3 fallback', $res['status'] === 200, "status {$res['status']}");
check('and returns the stub metadata', ($res['body']['title'] ?? null) === STUB_TITLE);

$before = stubInvocations($COUNTER_PY);
$res = request('action=prepare', json_encode(['url' => 'https://youtu.be/' . $pyVideoId, 'format' => 'mp3']), 'POST');
check('prepare succeeds through the python3 fallback', $res['status'] === 200, "status {$res['status']}");
check('with the deterministic job id', ($res['body']['id'] ?? null) === $idPy);
check('exactly one python3 invocation happened', stubInvocations($COUNTER_PY) === $before + 1);

$res = rawRequest('action=file&id=' . $idPy);
check('the resulting file downloads', $res['status'] === 200 && $res['raw'] === 'PYSTUBMEDIA');

// ------------------------------------------------------------------

echo "\n$passed passed, $failed failed\n";
exit($failed === 0 ? 0 : 1);
