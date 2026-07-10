<?php
declare(strict_types=1);

// Integration tests for app/proxys/flowers.php (shared Paper Flowers
// bouquets: JSON files in app/cache/flowers/, pruned after 7 days).
//
// No database involved: the proxy is pure filesystem. The suite boots the
// PHP built-in server against the repo root, exercises save/load/cleanup,
// and removes every file it created on shutdown.
//
// Run: /opt/lampp/bin/php tests/flowers-share.test.php

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit('CLI only');
}

const PHP_BIN   = '/opt/lampp/bin/php';
const DOC_ROOT  = __DIR__ . '/..';
const HOST      = '127.0.0.1';
const PORT      = 8941;
const API       = 'http://' . HOST . ':' . PORT . '/app/proxys/flowers.php';
const CACHE_DIR = DOC_ROOT . '/app/cache/flowers';

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

/** @return array{status:int, body:mixed} */
function request(string $query, ?string $content = null, string $method = 'GET'): array
{
    $opts = ['http' => [
        'method'        => $method,
        'ignore_errors' => true,
        'timeout'       => 10,
    ]];
    if ($content !== null) {
        $opts['http']['header']  = 'Content-Type: application/json';
        $opts['http']['content'] = $content;
    }
    $raw = file_get_contents(API . '?' . $query, false, stream_context_create($opts));
    $status = 0;
    foreach ($http_response_header ?? [] as $h) {
        if (preg_match('#^HTTP/\S+\s+(\d{3})#', $h, $m)) {
            $status = (int) $m[1];
        }
    }
    return ['status' => $status, 'body' => $raw !== false ? json_decode($raw, true) : null];
}

/** @return array{status:int, body:mixed} */
function save(array $payload): array
{
    return request('action=save', json_encode($payload), 'POST');
}

// ------------------------------------------------------------------
//  Server lifecycle + teardown
// ------------------------------------------------------------------

/** Bouquet ids created by this run, unlinked again on shutdown. */
$CREATED_IDS = [];

function track(string $id): void
{
    global $CREATED_IDS;
    $CREATED_IDS[] = $id;
}

$server = proc_open(
    [PHP_BIN, '-S', HOST . ':' . PORT, '-t', DOC_ROOT],
    [1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']],
    $pipes,
    DOC_ROOT
);

register_shutdown_function(function () use ($server) {
    global $CREATED_IDS;
    if (is_resource($server)) {
        proc_terminate($server);
    }
    foreach (array_unique($CREATED_IDS) as $id) {
        @unlink(CACHE_DIR . '/' . $id . '.json');
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
//  Save + load round trip
// ------------------------------------------------------------------

echo "save + load\n";

$id = 'test' . base_convert((string) random_int(1, PHP_INT_MAX), 10, 36);
track($id);
$res = save([
    'id'      => $id,
    'order'   => [['type' => 'rose', 'count' => 3], ['type' => 'tulip', 'count' => 2]],
    'message' => "  happy birthday mum  ",
]);
check('save accepts a valid bouquet', $res['status'] === 200, "status {$res['status']}");
check('save echoes the id', ($res['body']['id'] ?? null) === $id);

$res = request('action=load&id=' . $id);
check('load finds the bouquet', $res['status'] === 200, "status {$res['status']}");
check('load returns the order', ($res['body']['order'] ?? null) === [
    ['type' => 'rose', 'count' => 3],
    ['type' => 'tulip', 'count' => 2],
]);
check('message is trimmed', ($res['body']['message'] ?? null) === 'happy birthday mum');
check('payload carries a version and timestamp',
    ($res['body']['v'] ?? null) === 1 && isset($res['body']['createdAt']));

$res = save(['id' => $id, 'order' => [['type' => 'rose', 'count' => 1]]]);
check('message is optional', $res['status'] === 200, "status {$res['status']}");
$res = request('action=load&id=' . $id);
check('omitted message loads as empty string', ($res['body']['message'] ?? null) === '');

// ------------------------------------------------------------------
//  Validation
// ------------------------------------------------------------------

echo "validation\n";

$res = request('action=save');
check('save rejects GET', $res['status'] === 405, "status {$res['status']}");

$res = request('action=save', 'not json{', 'POST');
check('save rejects broken JSON', $res['status'] === 400, "status {$res['status']}");

$res = save(['id' => 'x1', 'order' => []]);
check('save rejects an empty order', $res['status'] === 400, "status {$res['status']}");

$res = save(['id' => 'x1', 'order' => [['type' => 'rose', 'count' => 0]]]);
check('save rejects a zero-stem order', $res['status'] === 400, "status {$res['status']}");

$res = save(['id' => 'x1', 'order' => [['type' => 'DROP TABLE', 'count' => 2]]]);
check('save rejects junk species names', $res['status'] === 400, "status {$res['status']}");

$res = save(['order' => [['type' => 'rose', 'count' => 1]]]);
check('save rejects a missing id', $res['status'] === 400, "status {$res['status']}");

$flood = 'flood' . base_convert((string) random_int(1, PHP_INT_MAX), 10, 36);
track($flood);
$res = save(['id' => $flood, 'order' => [
    ['type' => 'rose', 'count' => 9],
    ['type' => 'tulip', 'count' => 999999],
]]);
check('oversized orders save', $res['status'] === 200, "status {$res['status']}");
$res = request('action=load&id=' . $flood);
$total = array_sum(array_column($res['body']['order'] ?? [], 'count'));
check('but the stored total clamps to 12 stems', $total === 12, "total $total");

$long = 'long' . base_convert((string) random_int(1, PHP_INT_MAX), 10, 36);
track($long);
$res = save([
    'id'      => $long,
    'order'   => [['type' => 'rose', 'count' => 1]],
    'message' => str_repeat('a', 500),
]);
check('a long note saves', $res['status'] === 200, "status {$res['status']}");
$res = request('action=load&id=' . $long);
check('but the stored note clamps to 280 chars',
    mb_strlen($res['body']['message'] ?? '') === 280);

$res = request('action=save', str_repeat('x', 10000), 'POST');
check('an oversized body is refused', $res['status'] === 413, "status {$res['status']}");

// A crafted id must never escape the cache directory: everything outside
// [a-z0-9] is stripped before it touches the filesystem.
track('etcpasswd');
$res = save(['id' => '../../etc/passwd', 'order' => [['type' => 'rose', 'count' => 1]]]);
check('a path-traversal id is flattened', ($res['body']['id'] ?? null) === 'etcpasswd');
check('nothing landed outside the cache dir',
    !file_exists(DOC_ROOT . '/app/etc/passwd.json') && file_exists(CACHE_DIR . '/etcpasswd.json'));

$res = request('action=load&id=' . urlencode('../../.env'));
check('load sanitizes ids too', $res['status'] === 404, "status {$res['status']}");

$res = request('action=nonsense');
check('unknown actions 400', $res['status'] === 400, "status {$res['status']}");

// ------------------------------------------------------------------
//  Pruning: bouquets older than 7 days wilt, fresh ones survive
// ------------------------------------------------------------------

echo "pruning\n";

$old = 'old' . base_convert((string) random_int(1, PHP_INT_MAX), 10, 36);
track($old);
save(['id' => $old, 'order' => [['type' => 'daisy', 'count' => 2]]]);
touch(CACHE_DIR . '/' . $old . '.json', time() - 8 * 24 * 60 * 60);

$res = request('action=cleanup');
check('cleanup reports deletions', ($res['body']['deleted'] ?? 0) >= 1);
check('the 8-day-old bouquet is gone', !file_exists(CACHE_DIR . '/' . $old . '.json'));
check('the fresh bouquet survives', file_exists(CACHE_DIR . '/' . $id . '.json'));

$res = request('action=load&id=' . $old);
check('loading a pruned bouquet 404s', $res['status'] === 404, "status {$res['status']}");

// ------------------------------------------------------------------

echo "\n$passed passed, $failed failed\n";
exit($failed === 0 ? 0 : 1);
