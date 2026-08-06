<?php
declare(strict_types=1);
define('SECURE_ACCESS', true);

// Backend for the standalone views/vrata PWA: unlocks a physical door and
// allocates the camera's HLS stream via the Tuya cloud.
//
// SEC-03 hardening: the unlock is a state-changing, real-world action, so it
// is POST-only (a bare GET from a link-preview/prefetch bot must never open
// the door), the shared key is read from the JSON body only (never the URL,
// where it would leak into access logs, history, Referer and prefetch), it is
// same-origin gated, and failed key attempts are rate limited per IP. A
// signed-in user with a role in the 'vrata' project (admins implicitly) is
// authorized without needing the key at all.

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
// No Access-Control-Allow-Origin: this opens a door; every consumer is the
// same-origin PWA and wildcard CORS is incompatible with that.

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

require_once __DIR__ . '/../config/dev-mode.php';
require_once __DIR__ . '/../config/database.php'; // also loads .env (Tuya + VRATA_KEY)
require_once __DIR__ . '/../config/auth.php';

function vrata_respond(int $code, array $payload): never
{
    http_response_code($code);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE);
    exit;
}

function vrata_env(string $name): string
{
    $v = $_ENV[$name] ?? getenv($name);
    return is_string($v) ? $v : '';
}

// ------------------------------------------------------------------
//  Per-IP rate limiting for shared-key attempts (a file of timestamps)
// ------------------------------------------------------------------

function vrata_attempts_file(): string
{
    $override = getenv('VRATA_ATTEMPTS_FILE');
    return is_string($override) && $override !== ''
        ? $override
        : __DIR__ . '/../cache/vrata-attempts.json';
}

function vrata_window(): int
{
    $w = (int) (getenv('VRATA_ATTEMPT_WINDOW') ?: 900);
    return $w > 0 ? $w : 900;
}

function vrata_max_attempts(): int
{
    $m = (int) (getenv('VRATA_MAX_ATTEMPTS') ?: 10);
    return $m > 0 ? $m : 10;
}

function vrata_load_attempts(): array
{
    $file = vrata_attempts_file();
    if (!is_file($file)) return [];
    $data = json_decode((string) file_get_contents($file), true);
    return is_array($data) ? $data : [];
}

function vrata_save_attempts(array $data): void
{
    file_put_contents(vrata_attempts_file(), json_encode($data), LOCK_EX);
}

/** Timestamps of this IP's failed attempts still inside the window. */
function vrata_recent_failures(string $ip): array
{
    $cutoff = time() - vrata_window();
    $all = vrata_load_attempts();
    return array_values(array_filter(
        $all[$ip] ?? [],
        fn($t) => (int) $t >= $cutoff
    ));
}

function vrata_locked_out(string $ip): bool
{
    return count(vrata_recent_failures($ip)) >= vrata_max_attempts();
}

function vrata_record_failure(string $ip): void
{
    $all = vrata_load_attempts();
    $recent = vrata_recent_failures($ip);
    $recent[] = time();
    $all[$ip] = $recent;
    vrata_save_attempts($all);
}

function vrata_clear_failures(string $ip): void
{
    $all = vrata_load_attempts();
    unset($all[$ip]);
    vrata_save_attempts($all);
}

// ------------------------------------------------------------------
//  Server-side still capture
// ------------------------------------------------------------------
//
// The Tesla browser only paints <video>, and anything decoded from it, while
// the car is in Park, so views/vrata/frame cannot touch the HLS feed itself.
// It asks for a snapshot instead: ffmpeg pulls one frame here and writes it
// under shots/ for the page to point a plain <img> at.
//
// Each capture gets a fresh random name so the still is not sitting at a
// guessable URL, and so the browser can never serve a stale cached copy. Only
// the newest few are kept.

/** Where published stills land. Overridable so tests never touch the real one. */
function vrata_snapshot_dir(): string
{
    $override = getenv('VRATA_SNAPSHOT_DIR');
    return is_string($override) && $override !== ''
        ? $override
        : __DIR__ . '/../../views/vrata/frame/shots';
}

const VRATA_SNAPSHOT_KEEP = 3;       // newest files to keep on disk
const VRATA_SNAPSHOT_TRIES = 6;      // grabs before giving up on the warm-up
const VRATA_SNAPSHOT_GAP = 3;        // seconds between grabs
const VRATA_SNAPSHOT_TIMEOUT = 25;   // hard kill for one ffmpeg run
const VRATA_SNAPSHOT_BUDGET = 45;    // total seconds of retrying
const VRATA_BLANK_LUMA = 6;          // mean luma below this is the placeholder
const VRATA_PROBE_TIMEOUT = 3;       // seconds for one TCP reachability probe
const VRATA_FETCH_TIMEOUT = 10;      // seconds for one playlist/segment fetch

/** True when PHP is actually allowed to run external commands. */
function vrata_exec_available(): bool
{
    if (!function_exists('exec')) return false;
    $disabled = array_map('trim', explode(',', (string) ini_get('disable_functions')));
    return !in_array('exec', $disabled, true);
}

/**
 * Resolves an ffmpeg to run. Shared hosting rarely has one on PATH, so a
 * static build dropped at app/bin/ffmpeg over SFTP is picked up with no
 * configuration; FFMPEG_BIN in .env still wins if set.
 */
function vrata_ffmpeg_bin(): ?string
{
    static $resolved = false;
    static $bin = null;
    if ($resolved) return $bin;
    $resolved = true;

    // A configured path is preferred but still verified: an FFMPEG_BIN typo
    // must not send us into the retry loop only to fail 15s later.
    $env = $_ENV['FFMPEG_BIN'] ?? getenv('FFMPEG_BIN');
    if (is_string($env) && $env !== '') {
        if (str_contains($env, '/')) {
            if (is_executable($env)) return $bin = $env;
        } elseif (($found = vrata_which($env)) !== null) {
            return $bin = $found;
        }
    }

    $bundled = __DIR__ . '/../bin/ffmpeg';
    if (is_file($bundled)) {
        // SFTP uploads usually drop the executable bit; restore it once.
        if (!is_executable($bundled)) @chmod($bundled, 0755);
        if (is_executable($bundled)) return $bin = $bundled;
    }

    if (($found = vrata_which('ffmpeg')) !== null) {
        return $bin = $found;
    }

    foreach (['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/bin/ffmpeg'] as $path) {
        if (is_executable($path)) return $bin = $path;
    }

    return $bin = null;
}

/** Resolves a bare command name on PATH, or null. */
function vrata_which(string $name): ?string
{
    if (!vrata_exec_available()) return null;
    // No `env` wrapper: `command` is a shell builtin, so env would try to exec
    // a binary by that name and always report 127.
    exec('command -v ' . escapeshellarg($name) . ' 2>/dev/null', $out, $code);
    return $code === 0 && isset($out[0]) && $out[0] !== '' ? $out[0] : null;
}

/**
 * Last ffmpeg exit code and output, kept so a failure can explain itself.
 * There is no console on shared hosting and no log we can read.
 */
function vrata_last_error(?array $set = null): array
{
    static $last = ['code' => null, 'out' => []];
    if ($set !== null) $last = $set;
    return $last;
}

/**
 * Wrapper commands to put in front of a binary, where the host has them.
 * Both are optional: managed hosting sometimes ships neither, and a missing
 * one would make every run fail with 127.
 *
 * env: XAMPP exports LD_LIBRARY_PATH=/opt/lampp/lib, whose old libstdc++
 * breaks the system ffmpeg, so it is unset where possible.
 * timeout: ffmpeg must not keep reading the live playlist, it blocks
 * indefinitely waiting for the next segment and ignores TERM inside a TLS
 * read. -frames:v 1 normally returns in a second regardless.
 */
function vrata_cmd_prefix(int $seconds): string
{
    $prefix = '';
    if (vrata_which('env') !== null) {
        $prefix .= 'env -u LD_LIBRARY_PATH ';
    }
    if (vrata_which('timeout') !== null) {
        $prefix .= 'timeout -k 3 ' . $seconds . ' ';
    }
    return $prefix;
}

// ------------------------------------------------------------------
//  Reaching the stream host at all
// ------------------------------------------------------------------
//
// Tuya hands out stream URLs on port 8080, and plenty of managed hosts refuse
// outbound connections to anything but 80/443. Observed on prod: the edge
// also answers on 443 for some allocations, so the URL is worth retrying
// there before giving up. vrata_probe is for the diag action only: a socket
// that opens proves nothing on its own, since one has opened and then died
// mid-HTTP here, so the capture path validates by content instead.

/** @return array{ok:bool, errno:int, error:string, ms:int} */
function vrata_probe(string $host, int $port): array
{
    $t0 = microtime(true);
    $errno = 0;
    $errstr = '';
    $sock = @stream_socket_client(
        'tcp://' . $host . ':' . $port,
        $errno,
        $errstr,
        VRATA_PROBE_TIMEOUT
    );
    $ms = (int) round((microtime(true) - $t0) * 1000);
    if ($sock !== false) {
        fclose($sock);
        return ['ok' => true, 'errno' => 0, 'error' => '', 'ms' => $ms];
    }
    return ['ok' => false, 'errno' => $errno, 'error' => $errstr, 'ms' => $ms];
}

/** The port a URL actually connects on. */
function vrata_url_port(string $url): int
{
    $p = parse_url($url);
    if (isset($p['port'])) return (int) $p['port'];
    return ($p['scheme'] ?? 'https') === 'http' ? 80 : 443;
}

/**
 * The same URL moved to port 443, or null when it is already there. Some
 * Tuya stream edges answer HLS on both 8080 and 443; where they do, this is
 * the entire fix for a host that only allows standard ports out.
 */
function vrata_url_on_443(string $url): ?string
{
    $p = parse_url($url);
    if (!is_array($p) || !isset($p['host']) || !isset($p['port'])) return null;
    if ((int) $p['port'] === 443) return null;

    return 'https://' . $p['host']
        . ($p['path'] ?? '')
        . (isset($p['query']) ? '?' . $p['query'] : '');
}

// ------------------------------------------------------------------
//  Fetching HLS with curl, not with ffmpeg
// ------------------------------------------------------------------
//
// ffmpeg's own HTTP client is the least reliable thing in this path: on prod
// it has failed both with a refused connection (port 8080 blocked outbound)
// and, once moved to 443, with "Error reading HTTP response: End of file".
// PHP's curl is the host's own, with its CA store and proxy settings, and its
// errno says what actually went wrong instead of a log line to scrape.
//
// So the split is: curl does every network read, ffmpeg only decodes a file
// already on disk. That also makes a blocked port impossible to mistake for a
// broken binary, because the two now fail in different functions.

/** @return array{body:?string, http:int, errno:int, error:string} */
function vrata_fetch(string $url, int $timeout = VRATA_FETCH_TIMEOUT): array
{
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => VRATA_PROBE_TIMEOUT,
        CURLOPT_TIMEOUT        => $timeout,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS      => 3,
    ]);
    $body = curl_exec($ch);
    $out = [
        'body'  => is_string($body) && $body !== '' ? $body : null,
        'http'  => (int) curl_getinfo($ch, CURLINFO_HTTP_CODE),
        'errno' => curl_errno($ch),
        'error' => curl_error($ch),
    ];
    curl_close($ch);
    if ($out['http'] >= 400) $out['body'] = null;
    return $out;
}

/** Resolves a playlist-relative URI against the playlist's own URL. */
function vrata_resolve_url(string $base, string $ref): string
{
    if (preg_match('#^https?://#i', $ref)) return $ref;

    $p = parse_url($base);
    $root = ($p['scheme'] ?? 'https') . '://' . ($p['host'] ?? '')
        . (isset($p['port']) ? ':' . $p['port'] : '');
    if (str_starts_with($ref, '/')) return $root . $ref;

    $dir = preg_replace('#/[^/]*$#', '/', $p['path'] ?? '/');
    return $root . $dir . $ref;
}

/** Non-comment lines of a playlist, which are its URIs. */
function vrata_playlist_uris(string $body): array
{
    $uris = [];
    foreach (preg_split('/\R/', $body) ?: [] as $line) {
        $line = trim($line);
        if ($line !== '' && $line[0] !== '#') $uris[] = $line;
    }
    return $uris;
}

/**
 * Fetches the playlist this host can actually read, following one level of
 * master playlist, and falling back to port 443 when the allocated URL is
 * unreachable. Validated by content: a socket that opens but returns no
 * playlist is not a working stream, which a bare TCP probe cannot tell.
 *
 * @return array{url:?string, body:?string, tried:array<string, array>}
 */
function vrata_open_playlist(string $url): array
{
    $tried = [];
    foreach ([$url, vrata_url_on_443($url)] as $candidate) {
        if ($candidate === null) continue;

        $port = (string) vrata_url_port($candidate);
        $res = vrata_fetch($candidate, VRATA_FETCH_TIMEOUT);
        $tried[$port] = [
            'http'  => $res['http'],
            'errno' => $res['errno'],
            'error' => $res['error'],
            'bytes' => $res['body'] === null ? 0 : strlen($res['body']),
        ];
        if ($res['body'] === null || !str_starts_with(ltrim($res['body']), '#EXTM3U')) {
            continue;
        }

        // A master playlist only lists other playlists; take the first variant.
        if (str_contains($res['body'], '#EXT-X-STREAM-INF')) {
            $uris = vrata_playlist_uris($res['body']);
            if ($uris === []) continue;
            $variant = vrata_resolve_url($candidate, $uris[0]);
            $res = vrata_fetch($variant, VRATA_FETCH_TIMEOUT);
            $tried[$port . '/variant'] = [
                'http'  => $res['http'],
                'errno' => $res['errno'],
                'error' => $res['error'],
                'bytes' => $res['body'] === null ? 0 : strlen($res['body']),
            ];
            if ($res['body'] === null) continue;
            $candidate = $variant;
        }

        return ['url' => $candidate, 'body' => $res['body'], 'tried' => $tried];
    }

    return ['url' => null, 'body' => null, 'tried' => $tried];
}

/**
 * Fetches a URL, retrying on 443 when the allocated port is unreachable.
 * Playlists resolve their segments relatively, so those inherit whichever
 * port worked, but an absolute URI inside the playlist (the EXT-X-KEY is
 * one) still points at 8080 and needs the same fallback.
 */
function vrata_fetch_maybe_443(string $url): array
{
    $res = vrata_fetch($url);
    if ($res['body'] !== null) return $res;

    $alt = vrata_url_on_443($url);
    return $alt === null ? $res : vrata_fetch($alt);
}

/**
 * The AES-128 key and IV a playlist declares for its last segment.
 *
 * **Tuya encrypts every segment**, so this is the normal path, not an edge
 * case: without it the downloaded .ts is ciphertext and ffmpeg rejects it
 * with "Invalid data found when processing input". ffmpeg was doing this
 * itself back when it fetched the playlist.
 *
 * @return array{method:string, key:?string, iv:string}|null  null when in the clear
 */
function vrata_playlist_key(string $base, string $body, int $sequence): ?array
{
    // Keys can rotate; the last declaration is the one covering the last
    // segment, which is the one this code always picks.
    if (!preg_match_all('/#EXT-X-KEY:([^\r\n]+)/', $body, $all)) return null;
    $attrs = (string) end($all[1]);

    $method = preg_match('/METHOD=([A-Za-z0-9-]+)/', $attrs, $m) ? $m[1] : 'NONE';
    if ($method === 'NONE') return null;
    if ($method !== 'AES-128' || !preg_match('/URI="([^"]+)"/', $attrs, $u)) {
        return ['method' => $method, 'key' => null, 'iv' => ''];
    }

    $res = vrata_fetch_maybe_443(vrata_resolve_url($base, $u[1]));
    if ($res['body'] === null || strlen($res['body']) !== 16) {
        return ['method' => $method, 'key' => null, 'iv' => ''];
    }

    // An explicit IV wins; otherwise HLS uses the segment's media sequence
    // number as a 16-byte big-endian counter.
    $iv = preg_match('/IV=0x([0-9A-Fa-f]+)/', $attrs, $i)
        ? (string) hex2bin(str_pad($i[1], 32, '0', STR_PAD_LEFT))
        : pack('N4', 0, 0, 0, $sequence);

    return ['method' => $method, 'key' => $res['body'], 'iv' => $iv];
}

/**
 * Writes the newest media segment of an open playlist to $dest, decrypted.
 * An fMP4 playlist needs its EXT-X-MAP init segment in front or the decoder
 * sees headerless fragments; a plain MPEG-TS one has no map and needs none.
 */
function vrata_fetch_segment(array $playlist, string $dest): bool
{
    $body = (string) $playlist['body'];
    $base = (string) $playlist['url'];

    $uris = vrata_playlist_uris($body);
    if ($uris === []) {
        vrata_last_error(['code' => null, 'out' => ['playlist listed no segments']]);
        return false;
    }

    $init = '';
    if (preg_match('/#EXT-X-MAP:[^\r\n]*URI="([^"]+)"/', $body, $m)) {
        $res = vrata_fetch_maybe_443(vrata_resolve_url($base, $m[1]));
        if ($res['body'] === null) {
            vrata_last_error(['code' => $res['errno'], 'out' => ['init segment: ' . $res['error']]]);
            return false;
        }
        $init = $res['body'];
    }

    // Last URI is the most recent segment: the live edge, not the backlog.
    $index = count($uris) - 1;
    $seg = vrata_fetch_maybe_443(vrata_resolve_url($base, $uris[$index]));
    if ($seg['body'] === null) {
        vrata_last_error(['code' => $seg['errno'], 'out' => ['segment: ' . $seg['error']]]);
        return false;
    }
    $bytes = $seg['body'];

    $mediaSeq = preg_match('/#EXT-X-MEDIA-SEQUENCE:(\d+)/', $body, $s) ? (int) $s[1] : 0;
    $crypt = vrata_playlist_key($base, $body, $mediaSeq + $index);
    if ($crypt !== null) {
        if ($crypt['key'] === null) {
            vrata_last_error(['code' => null, 'out' => ['unusable ' . $crypt['method'] . ' key']]);
            return false;
        }
        $plain = openssl_decrypt($bytes, 'aes-128-cbc', $crypt['key'], OPENSSL_RAW_DATA, $crypt['iv']);
        if ($plain === false) {
            // HLS specifies PKCS7, but not every packager pads; retry raw
            // rather than fail on a segment that is merely unpadded.
            $plain = openssl_decrypt(
                $bytes,
                'aes-128-cbc',
                $crypt['key'],
                OPENSSL_RAW_DATA | OPENSSL_ZERO_PADDING,
                $crypt['iv']
            );
        }
        if ($plain === false || $plain === '') {
            vrata_last_error(['code' => null, 'out' => ['AES-128 decrypt failed']]);
            return false;
        }
        $bytes = $plain;
    }

    // Not filesize(): the retry loop writes this same path repeatedly and the
    // stat cache would answer for the previous attempt.
    $written = @file_put_contents($dest, $init . $bytes);
    return $written !== false && $written > 0;
}

/** Decodes a single frame out of an already-downloaded segment file. */
function vrata_grab_frame(string $source, string $dest): bool
{
    $ffmpeg = vrata_ffmpeg_bin();
    if ($ffmpeg === null || !vrata_exec_available()) return false;

    $cmd = vrata_cmd_prefix(VRATA_SNAPSHOT_TIMEOUT)
        . escapeshellarg($ffmpeg) . ' -y -loglevel error -nostdin'
        . ' -i ' . escapeshellarg($source)
        . ' -frames:v 1 -update 1 -q:v 4 ' . escapeshellarg($dest)
        . ' </dev/null 2>&1';
    $out = [];
    exec($cmd, $out, $code);
    // The loop reuses $dest, so the cached size would be the previous frame's.
    clearstatcache(true, $dest);
    $ok = $code === 0 && is_file($dest) && filesize($dest) > 0;
    if (!$ok) {
        vrata_last_error(['code' => $code, 'out' => array_slice($out, -4)]);
    }
    return $ok;
}

/** Mean luma 0-255 of a JPEG, or null if it can't be read. */
function vrata_mean_luma(string $file): ?float
{
    if (!function_exists('imagecreatefromjpeg')) return null;
    $img = @imagecreatefromjpeg($file);
    if (!$img) return null;

    $w = imagesx($img);
    $h = imagesy($img);
    $stepX = max(1, (int) ($w / 32));
    $stepY = max(1, (int) ($h / 18));
    $sum = 0.0;
    $n = 0;
    for ($y = 0; $y < $h; $y += $stepY) {
        for ($x = 0; $x < $w; $x += $stepX) {
            $rgb = imagecolorat($img, $x, $y);
            $sum += 0.299 * (($rgb >> 16) & 0xFF)
                  + 0.587 * (($rgb >> 8) & 0xFF)
                  + 0.114 * ($rgb & 0xFF);
            $n++;
        }
    }
    imagedestroy($img);
    return $n > 0 ? $sum / $n : null;
}

/**
 * Grabs frames until the camera's black "waking up" placeholder gives way to
 * real picture, then publishes the still. Never returns.
 */
function vrata_snapshot(string $url): never
{
    @set_time_limit(90);

    // Bail before the retry loop: with no ffmpeg to run, every grab fails
    // instantly and the retries only burn 15s of the caller's time. Report
    // what was searched, since prod has no console to check.
    if (!vrata_exec_available()) {
        vrata_respond(502, ['error' => 'exec_disabled']);
    }
    if (vrata_ffmpeg_bin() === null) {
        // The common SFTP mistake: the binary is there but arrived without its
        // executable bit, and PHP cannot chmod a file it does not own. Saying
        // "missing" about a file sitting in place would send you hunting.
        if (is_file(__DIR__ . '/../bin/ffmpeg')) {
            vrata_respond(502, [
                'error' => 'ffmpeg_not_executable',
                'fix' => 'chmod 755 app/bin/ffmpeg',
            ]);
        }
        vrata_respond(502, [
            'error' => 'ffmpeg_missing',
            'looked_in' => ['FFMPEG_BIN', 'app/bin/ffmpeg', 'PATH',
                            '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/bin/ffmpeg'],
        ]);
    }

    // Fail fast and precisely when the playlist cannot be read. Without this
    // the loop spends 45 seconds retrying something that will never work and
    // then reports 'capture_failed', which points at the camera when the real
    // answer is this host's egress. 'tried' carries the curl errno per port.
    $playlist = vrata_open_playlist($url);
    if ($playlist['body'] === null) {
        vrata_respond(502, [
            'error' => 'stream_unreachable',
            'host'  => parse_url($url, PHP_URL_HOST),
            'tried' => $playlist['tried'],
        ]);
    }

    $tmp = tempnam(sys_get_temp_dir(), 'vrata') ?: null;
    if ($tmp === null) {
        vrata_respond(500, ['error' => 'tmp_failed']);
    }
    $tmpJpg = $tmp . '.jpg';
    $tmpSeg = $tmp . '.seg';
    @unlink($tmp);

    $got = false;
    $blank = false;
    $deadline = time() + VRATA_SNAPSHOT_BUDGET;
    for ($i = 0; $i < VRATA_SNAPSHOT_TRIES; $i++) {
        if ($i > 0) {
            if (time() >= $deadline) break;
            sleep(VRATA_SNAPSHOT_GAP);
            // Re-read the playlist: the point of waiting is a newer segment,
            // and the old one still lists the black warm-up frames.
            $playlist = vrata_open_playlist($playlist['url']);
            if ($playlist['body'] === null) break;
        }

        if (!vrata_fetch_segment($playlist, $tmpSeg)) continue;

        if (!vrata_grab_frame($tmpSeg, $tmpJpg)) {
            // 126 (wrong architecture) and 127 (missing loader or helper) mean
            // the binary cannot run at all; six retries will not change that.
            if (in_array(vrata_last_error()['code'], [126, 127], true)) break;
            continue;
        }

        $got = true;
        $luma = vrata_mean_luma($tmpJpg);
        // Unreadable luma (no GD) means we cannot tell, so take what we have.
        if ($luma === null || $luma >= VRATA_BLANK_LUMA) {
            $blank = false;
            break;
        }
        $blank = true;
    }

    if (!$got) {
        // The playlist was readable (checked above), so this is the segment
        // download or the decode. vrata_last_error() carries whichever spoke
        // last: a curl errno from the fetch, or ffmpeg's exit and log lines.
        // 126 = wrong architecture, 127 = a missing helper such as `timeout`.
        $last = vrata_last_error();
        $segBytes = is_file($tmpSeg) ? filesize($tmpSeg) : 0;
        @unlink($tmpJpg);
        @unlink($tmpSeg);
        vrata_respond(502, [
            'error' => 'capture_failed',
            'ffmpeg' => vrata_ffmpeg_bin(),
            'exit' => $last['code'],
            'output' => $last['out'],
            'segment_bytes' => $segBytes,
        ]);
    }

    $bytes = @file_get_contents($tmpJpg);
    @unlink($tmpJpg);
    @unlink($tmpSeg);
    if ($bytes === false || $bytes === '') {
        vrata_respond(502, ['error' => 'capture_failed']);
    }

    if (!is_dir(vrata_snapshot_dir()) && !@mkdir(vrata_snapshot_dir(), 0775, true) && !is_dir(vrata_snapshot_dir())) {
        // The web server user needs write access to views/vrata/frame/.
        vrata_respond(500, ['error' => 'write_failed']);
    }

    $name = 'shot-' . bin2hex(random_bytes(16)) . '.jpg';
    if (@file_put_contents(vrata_snapshot_dir() . '/' . $name, $bytes, LOCK_EX) === false) {
        vrata_respond(500, ['error' => 'write_failed']);
    }
    @chmod(vrata_snapshot_dir() . '/' . $name, 0664);
    vrata_prune_snapshots();

    vrata_respond(200, [
        'ok' => true,
        'ts' => time(),
        'file' => 'shots/' . $name,
        // True when every grab came back black: the picture is a placeholder,
        // so the page can say "camera still waking" instead of lying.
        'blank' => $blank,
    ]);
}

/** Keeps only the newest few stills; the rest are dead weight. */
function vrata_prune_snapshots(): void
{
    $files = glob(vrata_snapshot_dir() . '/shot-*.jpg') ?: [];
    if (count($files) <= VRATA_SNAPSHOT_KEEP) return;

    usort($files, fn($a, $b) => filemtime($b) <=> filemtime($a));
    foreach (array_slice($files, VRATA_SNAPSHOT_KEEP) as $old) {
        @unlink($old);
    }
}

// ------------------------------------------------------------------
//  Diagnostics
// ------------------------------------------------------------------
//
// There is no shell on the host and no log we can read, so a failed capture
// is otherwise unattributable: a blocked port, an expired URL and a binary
// that cannot run all reduce to the same "it didn't work". The 'diag' action
// allocates a real stream and reports every layer separately.

/** @return array{a:string[], aaaa:string[]} */
function vrata_dns(string $host): array
{
    $a = @gethostbynamel($host) ?: [];
    $aaaa = [];
    if (function_exists('dns_get_record')) {
        foreach (@dns_get_record($host, DNS_AAAA) ?: [] as $rec) {
            if (isset($rec['ipv6'])) $aaaa[] = $rec['ipv6'];
        }
    }
    return ['a' => array_values($a), 'aaaa' => $aaaa];
}

/**
 * Fetches a URL and reports how it went, never what came back: the playlist
 * body carries the signed stream token and must not travel to a client.
 *
 * @return array{http:int, errno:int, error:string, bytes:int, playlist:bool}
 */
function vrata_fetch_report(string $url): array
{
    $res = vrata_fetch($url);
    return [
        'http'     => $res['http'],
        'errno'    => $res['errno'],
        'error'    => $res['error'],
        'bytes'    => $res['body'] === null ? 0 : strlen($res['body']),
        'playlist' => $res['body'] !== null && str_starts_with(ltrim($res['body']), '#EXTM3U'),
    ];
}

/** What ffmpeg this host resolves, and whether it can actually be run. */
function vrata_ffmpeg_report(): array
{
    $bin = vrata_ffmpeg_bin();
    if ($bin === null) {
        return [
            'bin'     => null,
            'exec'    => vrata_exec_available(),
            'bundled' => is_file(__DIR__ . '/../bin/ffmpeg'),
        ];
    }
    $out = [];
    $code = null;
    exec(vrata_cmd_prefix(5) . escapeshellarg($bin) . ' -version 2>&1', $out, $code);
    return [
        'bin'     => $bin,
        'exec'    => vrata_exec_available(),
        'exit'    => $code,
        'version' => $out[0] ?? '',
    ];
}

/** Runs the real capture pipeline once and reports where it stopped. */
function vrata_capture_report(string $url): array
{
    $playlist = vrata_open_playlist($url);
    $report = [
        'playlist_tried' => $playlist['tried'],
        'playlist_port'  => $playlist['url'] === null ? null : vrata_url_port($playlist['url']),
        'segments'       => $playlist['body'] === null
            ? 0
            : count(vrata_playlist_uris($playlist['body'])),
    ];
    if ($playlist['body'] === null) return $report + ['stopped_at' => 'playlist'];

    $tmp = tempnam(sys_get_temp_dir(), 'vratadiag');
    if ($tmp === false) return $report + ['stopped_at' => 'tmp'];

    $seg = $tmp . '.seg';
    $jpg = $tmp . '.jpg';
    @unlink($tmp);

    if (!vrata_fetch_segment($playlist, $seg)) {
        @unlink($seg);
        return $report + ['stopped_at' => 'segment', 'why' => vrata_last_error()];
    }
    $report['segment_bytes'] = filesize($seg);

    $decoded = vrata_grab_frame($seg, $jpg);
    $report['jpeg_bytes'] = $decoded && is_file($jpg) ? filesize($jpg) : 0;
    $report['luma'] = $decoded ? vrata_mean_luma($jpg) : null;
    if (!$decoded) $report['why'] = vrata_last_error();
    @unlink($seg);
    @unlink($jpg);

    return $report + ['stopped_at' => $decoded ? null : 'decode'];
}

/** Reports every layer between this server and the camera. Never returns. */
function vrata_diag(string $url): never
{
    @set_time_limit(60);

    $host = (string) (parse_url($url, PHP_URL_HOST) ?: '');
    $port = vrata_url_port($url);
    $alt  = vrata_url_on_443($url);

    // Host and port are safe to report; the signed URL itself is a credential.
    $tcp = [(string) $port => vrata_probe($host, $port)];
    if (!isset($tcp['443'])) {
        $tcp['443'] = vrata_probe($host, 443);
    }

    vrata_respond(200, [
        'ok'    => true,
        'host'  => $host,
        'port'  => $port,
        'dns'   => vrata_dns($host),
        'tcp'   => $tcp,
        'fetch' => [
            'as_allocated' => vrata_fetch_report($url),
            'on_443'       => $alt === null ? null : vrata_fetch_report($alt),
        ],
        // The real pipeline, run once: which port served a playlist, whether a
        // segment downloads, and whether ffmpeg decodes it. This is the answer
        // when the individual layers all look fine but capture still fails.
        'capture' => vrata_capture_report($url),
        'ffmpeg' => vrata_ffmpeg_report(),
    ]);
}

// ------------------------------------------------------------------
//  Request guards
// ------------------------------------------------------------------

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    vrata_respond(405, ['error' => 'method_not_allowed']);
}

// CSRF backstop, same convention as the auth system.
Auth::assertSameOrigin();

// JSON bodies only (blocks form-based CSRF; the PWA always posts JSON).
$contentType = $_SERVER['CONTENT_TYPE'] ?? ($_SERVER['HTTP_CONTENT_TYPE'] ?? '');
if (stripos($contentType, 'application/json') === false) {
    vrata_respond(415, ['error' => 'json_required']);
}

$body = json_decode((string) file_get_contents('php://input'), true);
if (!is_array($body)) $body = [];

// ------------------------------------------------------------------
//  Authorization: a vrata project role OR the shared key (body only)
// ------------------------------------------------------------------

$user = Auth::currentUser();

if ($user !== null && Auth::hasProjectRole('vrata')) {
    // Signed-in, authorized: no key required.
} else {
    $providedKey = isset($body['key']) && is_string($body['key']) ? $body['key'] : '';
    if ($providedKey === '') {
        // No key and no qualifying session: distinguish "sign in" from
        // "you don't have access" so the PWA can react sensibly.
        vrata_respond($user !== null ? 403 : 401, [
            'error' => $user !== null ? 'forbidden' : 'auth_required',
        ]);
    }

    $ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
    if (vrata_locked_out($ip)) {
        vrata_respond(429, ['error' => 'too_many_attempts']);
    }

    $expectedKey = vrata_env('VRATA_KEY');
    if ($expectedKey === '' || !hash_equals($expectedKey, $providedKey)) {
        vrata_record_failure($ip);
        vrata_respond(403, ['error' => 'forbidden']);
    }
    vrata_clear_failures($ip);
}

$action = isset($body['action']) && is_string($body['action']) ? $body['action'] : 'unlock';
if (!in_array($action, ['unlock', 'stream', 'snapshot', 'diag'], true)) {
    vrata_respond(400, ['error' => 'unknown_action']);
}

// ------------------------------------------------------------------
//  Tuya cloud
// ------------------------------------------------------------------

$client_id = vrata_env('TUYA_CLIENT_ID');
$secret    = vrata_env('TUYA_SECRET');
$door_id   = vrata_env('TUYA_DOOR_ID');
$camera_id = vrata_env('TUYA_CAMERA_ID');
$base_url  = vrata_env('TUYA_BASE_URL');

// Step 1 — get an access token (shared by all actions).
$timestamp = round(microtime(true) * 1000);
$contentHash = hash('sha256', '');
$stringToSign = "GET\n" . $contentHash . "\n\n" . "/v1.0/token?grant_type=1";
$signStr = $client_id . $timestamp . $stringToSign;
$sign = strtoupper(hash_hmac('sha256', $signStr, $secret));

$ch = curl_init("$base_url/v1.0/token?grant_type=1");
curl_setopt($ch, CURLOPT_HTTPHEADER, [
    "client_id: $client_id",
    "sign: $sign",
    "t: $timestamp",
    "sign_method: HMAC-SHA256",
]);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
$response = json_decode((string) curl_exec($ch), true);
$token = $response['result']['access_token'] ?? null;

if (!$token) {
    vrata_respond(502, ['error' => 'token_failed']);
}

/** Allocates a fresh HLS URL for the camera, or null on failure. */
function vrata_allocate_stream(string $client_id, string $secret, string $base_url, string $camera_id, string $token): ?string
{
    $timestamp = round(microtime(true) * 1000);
    $streamBody = json_encode(['type' => 'hls']);
    $path = "/v1.0/devices/$camera_id/stream/actions/allocate";
    $contentHash = hash('sha256', $streamBody);
    $stringToSign = "POST\n" . $contentHash . "\n\n" . $path;
    $signStr = $client_id . $token . $timestamp . $stringToSign;
    $sign = strtoupper(hash_hmac('sha256', $signStr, $secret));

    $ch = curl_init($base_url . $path);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, $streamBody);
    curl_setopt($ch, CURLOPT_HTTPHEADER, [
        "client_id: $client_id",
        "access_token: $token",
        "sign: $sign",
        "t: $timestamp",
        "sign_method: HMAC-SHA256",
        "Content-Type: application/json",
    ]);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    $data = json_decode((string) curl_exec($ch), true);

    $url = $data['result']['url'] ?? null;
    return is_string($url) && $url !== '' ? $url : null;
}

if ($action === 'stream' || $action === 'snapshot' || $action === 'diag') {
    if ($camera_id === '') {
        vrata_respond(500, ['error' => 'camera_not_configured']);
    }

    $url = vrata_allocate_stream($client_id, $secret, $base_url, $camera_id, $token);
    if ($url === null) {
        vrata_respond(502, ['error' => 'stream_failed']);
    }

    if ($action === 'stream') {
        vrata_respond(200, ['url' => $url]);
    }
    if ($action === 'diag') {
        vrata_diag($url);   // never returns
    }

    vrata_snapshot($url);   // never returns
}

// Default action: unlock.
$timestamp = round(microtime(true) * 1000);
$cmdBody = json_encode(['commands' => [['code' => 'switch_1', 'value' => true]]]);
$contentHash = hash('sha256', $cmdBody);
$stringToSign = "POST\n" . $contentHash . "\n\n" . "/v1.0/iot-03/devices/$door_id/commands";
$signStr = $client_id . $token . $timestamp . $stringToSign;
$sign = strtoupper(hash_hmac('sha256', $signStr, $secret));

$ch = curl_init("$base_url/v1.0/iot-03/devices/$door_id/commands");
curl_setopt($ch, CURLOPT_POST, true);
curl_setopt($ch, CURLOPT_POSTFIELDS, $cmdBody);
curl_setopt($ch, CURLOPT_HTTPHEADER, [
    "client_id: $client_id",
    "access_token: $token",
    "sign: $sign",
    "t: $timestamp",
    "sign_method: HMAC-SHA256",
    "Content-Type: application/json",
]);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
$data = json_decode((string) curl_exec($ch), true);

if (!is_array($data) || ($data['success'] ?? false) !== true) {
    vrata_respond(502, ['error' => 'unlock_failed']);
}
vrata_respond(200, ['ok' => true]);
