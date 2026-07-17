<?php
declare(strict_types=1);

// Integration tests for app/proxys/stats-proxy.php (the homepage "lines of
// code" stat: per-extension line/file counts over the deployed tree, cached
// per day).
//
// No database: the suite boots the PHP built-in server with STATS_ROOT /
// STATS_CACHE injected into the process environment (the proxy reads them via
// getenv() for exactly this reason), pointing the counter at a generated
// fixture tree instead of the real repo. Covers the raw counting, the
// dev-tooling exclusions (.claude, tests, tools, ...), and the daily cache
// including the version stamp that busts it when counting rules change.
// Everything it creates (fixture tree, cache file) is removed on shutdown.
//
// Run: /opt/lampp/bin/php tests/stats-proxy.test.php

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit('CLI only');
}

const PHP_BIN  = '/opt/lampp/bin/php';
const DOC_ROOT = __DIR__ . '/..';
const HOST     = '127.0.0.1';
const PORT     = 8955;

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
//  Fixture tree + HTTP helpers
// ------------------------------------------------------------------

$FIXTURE = sys_get_temp_dir() . '/stats-fixture-' . getmypid();
$CACHE   = sys_get_temp_dir() . '/stats-cache-' . getmypid() . '.json';

/** Create $path (under the fixture root) with exactly $lines lines. */
function mkfile(string $rel, int $lines): void
{
    global $FIXTURE;
    $path = $FIXTURE . '/' . $rel;
    if (!is_dir(dirname($path))) {
        mkdir(dirname($path), 0777, true);
    }
    $body = '';
    for ($i = 1; $i <= $lines; $i++) {
        $body .= "line $i\n";
    }
    file_put_contents($path, $body);
}

function rmTree(string $dir): void
{
    if (!is_dir($dir)) {
        return;
    }
    $it = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::CHILD_FIRST
    );
    foreach ($it as $file) {
        $file->isDir() ? rmdir($file->getPathname()) : unlink($file->getPathname());
    }
    rmdir($dir);
}

/** @return array{status:int, body:mixed} */
function request(): array
{
    $opts = ['http' => ['method' => 'GET', 'ignore_errors' => true, 'timeout' => 15]];
    $url  = 'http://' . HOST . ':' . PORT . '/app/proxys/stats-proxy.php';
    $raw  = file_get_contents($url, false, stream_context_create($opts));
    $status = 0;
    foreach ($http_response_header ?? [] as $h) {
        if (preg_match('#^HTTP/\S+\s+(\d{3})#', $h, $m)) {
            $status = (int) $m[1];
        }
    }
    return ['status' => $status, 'body' => $raw !== false ? json_decode($raw, true) : null];
}

// ------------------------------------------------------------------
//  Server lifecycle + teardown
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

function startServer(): void
{
    global $server, $FIXTURE, $CACHE;
    stopServer();
    // proc_open's env REPLACES the environment, so PATH rides along.
    $env = [
        'PATH'        => (string) getenv('PATH'),
        'STATS_ROOT'  => $FIXTURE,
        'STATS_CACHE' => $CACHE,
    ];
    $server = proc_open(
        [PHP_BIN, '-S', HOST . ':' . PORT, '-t', DOC_ROOT],
        [1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']],
        $pipes,
        DOC_ROOT,
        $env
    );
    for ($i = 0; $i < 50; $i++) {
        $sock = @fsockopen(HOST, PORT, $errno, $errstr, 0.2);
        if ($sock) {
            fclose($sock);
            return;
        }
        usleep(100_000);
    }
    fwrite(STDERR, "Built-in PHP server did not start on port " . PORT . "\n");
    exit(1);
}

register_shutdown_function(function () use ($FIXTURE, $CACHE) {
    stopServer();
    rmTree($FIXTURE);
    @unlink($CACHE);
});

// ------------------------------------------------------------------
//  Phase 1: counts a fixture tree exactly (lines, files, total, percent)
// ------------------------------------------------------------------

echo "counting\n";

mkfile('index.html', 3);
mkfile('views/a/style.css', 5);
mkfile('views/a/script.js', 4);
mkfile('app/controllers/a-controller.php', 2);
mkfile('app/models/a-model.sql', 1);
mkfile('notes.md', 10);        // not a counted extension
mkfile('views/a/logic.mjs', 7); // not a counted extension

startServer();
$res = request();
$b = $res['body'];

check('answers 200 JSON', $res['status'] === 200 && is_array($b), "status {$res['status']}");
check('counts html lines/files', ($b['counts']['html']['lines'] ?? null) === 3 && ($b['counts']['html']['files'] ?? null) === 1, json_encode($b['counts']['html'] ?? null));
check('counts css lines/files', ($b['counts']['css']['lines'] ?? null) === 5 && ($b['counts']['css']['files'] ?? null) === 1, json_encode($b['counts']['css'] ?? null));
check('counts js lines/files', ($b['counts']['js']['lines'] ?? null) === 4 && ($b['counts']['js']['files'] ?? null) === 1, json_encode($b['counts']['js'] ?? null));
check('counts php lines/files', ($b['counts']['php']['lines'] ?? null) === 2 && ($b['counts']['php']['files'] ?? null) === 1, json_encode($b['counts']['php'] ?? null));
check('counts sql lines/files', ($b['counts']['sql']['lines'] ?? null) === 1 && ($b['counts']['sql']['files'] ?? null) === 1, json_encode($b['counts']['sql'] ?? null));
check('total is the five-extension sum', ($b['total'] ?? null) === 15, 'total ' . json_encode($b['total'] ?? null));
check('md and mjs are not counted', ($b['total'] ?? 0) === 15);
check('percent reflects lines/total', ($b['counts']['css']['percent'] ?? null) === '33.33', json_encode($b['counts']['css']['percent'] ?? null));
check('dates the count today', ($b['date'] ?? null) === date('Y-m-d'), json_encode($b['date'] ?? null));

// ------------------------------------------------------------------
//  Phase 2: dev tooling and server-only dirs never count
// ------------------------------------------------------------------

echo "\nexclusions\n";

// Dev tooling that lives in the repo but is not site code (and never deploys).
mkfile('.claude/skills/big/script.js', 5000);
mkfile('.agents/agent.js', 40);
mkfile('.impeccable/report.html', 60);
mkfile('.github/scripts/ci.js', 30);
mkfile('tests/thing.test.php', 200);
mkfile('tools/seo/generate.js', 300);
// Already-excluded server-side dirs stay excluded.
mkfile('app/vendor/lib.php', 500);
mkfile('app/cache/stale.js', 100);
mkfile('assets/img/inline.html', 50);

startServer(); // fresh boot, same fixture root: cache is date-keyed, so wipe it
@unlink($CACHE);
$res = request();
$b = $res['body'];

check('tooling and server dirs add nothing', ($b['total'] ?? null) === 15, 'total ' . json_encode($b['total'] ?? null));
check('file counts also unchanged', ($b['counts']['js']['files'] ?? null) === 1 && ($b['counts']['php']['files'] ?? null) === 1, json_encode([$b['counts']['js'] ?? null, $b['counts']['php'] ?? null]));

// ------------------------------------------------------------------
//  Phase 3: daily cache is served same-day, but counting-rule changes bust it
// ------------------------------------------------------------------

echo "\ncache\n";

// Same day, same rules: the cached count is served, new files don't show yet.
mkfile('views/a/extra.js', 9);
$res = request();
check('same-day request serves the cached count', ($res['body']['total'] ?? null) === 15, 'total ' . json_encode($res['body']['total'] ?? null));

// A cache written under OLD counting rules (different version stamp) must be
// recounted even though the date matches, so a deploy that changes the rules
// corrects the public number immediately, not at midnight.
file_put_contents($CACHE, json_encode([
    'date'    => date('Y-m-d'),
    'version' => 'stale-rules',
    'counts'  => ['js' => ['lines' => 999, 'files' => 1, 'percent' => '100.00']],
    'total'   => 999,
]));
$res = request();
$b = $res['body'];
check('rule change busts a same-day cache', ($b['total'] ?? null) === 24, 'total ' . json_encode($b['total'] ?? null));
check('response carries the current version stamp', is_string($b['version'] ?? null) && $b['version'] !== '' && $b['version'] !== 'stale-rules', json_encode($b['version'] ?? null));

// And the freshly written cache is valid again: stable on the next request.
$res = request();
check('recounted cache is served afterwards', ($res['body']['total'] ?? null) === 24, 'total ' . json_encode($res['body']['total'] ?? null));

// ------------------------------------------------------------------
//  Summary
// ------------------------------------------------------------------

echo "\n$passed passed, $failed failed\n";
exit($failed === 0 ? 0 : 1);
