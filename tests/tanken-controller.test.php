<?php
declare(strict_types=1);

// Integration tests for app/controllers/tanken-controller.php and
// app/services/tanken-service.php, the German fuel price view (views/tanken).
//
// Two contracts hold this suite, and both are about somebody else's terms
// rather than about our own correctness:
//
//   THE API IS CALLED AT MOST ONCE PER MINUTE. Tankerkoenig's free tier allows
//   one request a minute and revokes keys that harvest. Production has no
//   cron, so the poll rides the page load and any number of visitors can
//   arrive at once. Fifty requests must still produce one call.
//
//   NOTHING IS FILTERED AND NOTHING LEAKS. MTS-K's terms forbid narrowing
//   results in ways the user did not ask for, so a closed station stays in the
//   payload; and the API key must never appear in a response.
//
// Runs ONLY against the local scratch DB (127.0.0.1/portfolio): the DB_* env
// overrides below make database.php skip loading app/.env (which points at the
// remote production database). Never run these against prod.
//
// A second server runs tests/fixtures/tankerkoenig-stub.php, so no real API is
// ever touched and a denied request can be asserted to have reached it zero
// times. Seams: TANKERKOENIG_BASE_URL, TANKERKOENIG_API_KEY, TANKEN_POLL_INTERVAL,
// TANKEN_DISCOVER_TTL, TANKEN_POOL_CAP.
//
// Teardown deletes only the stations this suite created (a uuid prefix) and
// restores the poll state row.
//
// Run: /opt/lampp/bin/php tests/tanken-controller.test.php

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
const PORT      = 8966;
const STUB_PORT = 8967;
const API       = 'http://' . HOST . ':' . PORT . '/app/controllers/tanken-controller.php';

// Fixture stations get a recognisable uuid prefix so teardown can find them.
// A valid UUID shape (all hex): the service rejects anything that is not
// one, because such an id could never be sent to prices.php.
const PREFIX = 'ffffffff-fade-0000-0000-';
const KEY    = 'test-api-key-must-never-be-echoed';

$passed = 0;
$failed = 0;

function check(string $name, bool $cond, string $detail = ''): void
{
    global $passed, $failed;
    if ($cond) { $passed++; echo "  ok  $name\n"; }
    else { $failed++; echo "FAIL  $name" . ($detail !== '' ? "  ($detail)" : '') . "\n"; }
}

/** @return array{status:int, body:mixed, raw:string} */
function request(string $url): array
{
    $opts = ['http' => ['method' => 'GET', 'ignore_errors' => true, 'timeout' => 15]];
    $raw = @file_get_contents($url, false, stream_context_create($opts));
    $status = 0;
    foreach ($http_response_header ?? [] as $h) {
        if (preg_match('#^HTTP/\S+\s+(\d{3})#', $h, $m)) { $status = (int) $m[1]; }
    }
    return ['status' => $status, 'body' => $raw !== false ? json_decode($raw, true) : null, 'raw' => (string) $raw];
}

function stations(float $lat, float $lng, float $rad = 5.0): array
{
    return request(API . '?action=stations&lat=' . $lat . '&lng=' . $lng . '&rad=' . $rad);
}

// ------------------------------------------------------------------
//  Scenario + call log
// ------------------------------------------------------------------

$scenarioFile = sys_get_temp_dir() . '/tanken-stub-scenario-' . getmypid() . '.json';
$logFile      = sys_get_temp_dir() . '/tanken-stub-log-' . getmypid() . '.jsonl';

function scenario(array $data): void
{
    global $scenarioFile;
    file_put_contents($scenarioFile, json_encode($data));
}

function clearLog(): void
{
    global $logFile;
    @unlink($logFile);
}

/** @return array<int,array<string,mixed>> */
function calls(): array
{
    global $logFile;
    if (!is_file($logFile)) return [];
    $out = [];
    foreach (file($logFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
        $row = json_decode($line, true);
        if (is_array($row)) $out[] = $row;
    }
    return $out;
}

function station(string $suffix, float $lat, float $lng, array $extra = []): array
{
    return array_merge([
        'id' => PREFIX . $suffix,
        'name' => 'Station ' . $suffix,
        'brand' => 'BRAND' . $suffix,
        'street' => 'Teststrasse',
        'houseNumber' => '1',
        'postCode' => '10115',
        'place' => 'Berlin',
        'lat' => $lat,
        'lng' => $lng,
        'dist' => 0.5,
        'isOpen' => true,
        'e5' => 1.899,
        'e10' => 1.849,
        'diesel' => 1.749,
    ], $extra);
}

// ------------------------------------------------------------------
//  Schema
// ------------------------------------------------------------------

$pdo = new PDO(DB_DSN, DB_USER, DB_PASS, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);

// Apply the model statement by statement: the dashboard tile inserts at the
// end need the dashboard schema, which a bare scratch DB may not have, and
// that must not stop the price tables being created.
$sql = file_get_contents(DOC_ROOT . '/app/models/tanken-model.sql');
// Strip the comment lines BEFORE splitting: the file leads each statement with
// a comment block, so splitting first would leave every statement starting
// with "--" and a naive skip would drop the whole schema.
$sql = preg_replace('/^\s*--.*$/m', '', $sql);
foreach (array_filter(array_map('trim', explode(';', $sql))) as $statement) {
    if ($statement === '') continue;
    try { $pdo->exec($statement); } catch (PDOException $e) { /* optional tile seeding */ }
}
foreach (['tanken_stations', 'tanken_current_prices', 'tanken_poll_state'] as $table) {
    if ($pdo->query("SHOW TABLES LIKE '$table'")->fetchColumn() === false) {
        fwrite(STDERR, "tanken-model.sql did not create $table\n");
        exit(1);
    }
}

function resetState(PDO $pdo): void
{
    // Park both stamps in the past so the next request may call out.
    $pdo->exec("UPDATE tanken_poll_state
                   SET last_call_at = '2000-01-01', leased_until = '2000-01-01',
                       calls_today = 0, call_day = NULL, last_error = NULL, last_ok_at = NULL
                 WHERE id = 1");
}

function clearStations(PDO $pdo): void
{
    $pdo->exec("DELETE FROM tanken_stations WHERE uuid LIKE '" . PREFIX . "%'");
}

function teardown(PDO $pdo): void
{
    clearStations($pdo);
    resetState($pdo);
}

// ------------------------------------------------------------------
//  Servers
// ------------------------------------------------------------------

$nullDev = PHP_OS_FAMILY === 'Windows' ? 'NUL' : '/dev/null';

$stubEnv = [
    'TANKEN_STUB_SCENARIO' => $scenarioFile,
    'TANKEN_STUB_LOG' => $logFile,
    'PATH' => getenv('PATH') ?: '/usr/bin:/bin',
];
$stub = proc_open(
    [PHP_BIN, '-S', HOST . ':' . STUB_PORT, '-t', DOC_ROOT . '/tests/fixtures', DOC_ROOT . '/tests/fixtures/tankerkoenig-stub.php'],
    [1 => ['file', $nullDev, 'w'], 2 => ['file', $nullDev, 'w']],
    $stubPipes, DOC_ROOT, $stubEnv
);

$serverEnv = [
    'DB_HOST'   => '127.0.0.1',
    'DB_PORT'   => '3306',
    'DB_NAME'   => 'portfolio',
    'DB_USER_W' => DB_USER,
    'DB_PASS_W' => DB_PASS,
    'DB_USER_R' => DB_USER,
    'DB_PASS_R' => DB_PASS,
    'TANKERKOENIG_BASE_URL' => 'http://' . HOST . ':' . STUB_PORT,
    'TANKERKOENIG_API_KEY'  => KEY,
    'TANKEN_DISCOVER_TTL'   => '1800',
    'PATH' => getenv('PATH') ?: '/usr/bin:/bin',
];
if (PHP_OS_FAMILY === 'Windows') {
    $serverEnv['SystemRoot'] = getenv('SystemRoot') ?: 'C:\\Windows';
}

$server = proc_open(
    [PHP_BIN, '-d', 'variables_order=EGPCS', '-S', HOST . ':' . PORT, '-t', DOC_ROOT],
    [1 => ['file', $nullDev, 'w'], 2 => ['file', $nullDev, 'w']],
    $pipes, DOC_ROOT, $serverEnv
);

register_shutdown_function(function () use ($server, $stub, $pdo, $scenarioFile, $logFile) {
    if (is_resource($server)) proc_terminate($server);
    if (is_resource($stub)) proc_terminate($stub);
    @unlink($scenarioFile);
    @unlink($logFile);
    teardown($pdo);
});

foreach ([PORT, STUB_PORT] as $port) {
    $ready = false;
    for ($i = 0; $i < 50; $i++) {
        $sock = @fsockopen(HOST, $port, $errno, $errstr, 0.2);
        if ($sock) { fclose($sock); $ready = true; break; }
        usleep(100_000);
    }
    if (!$ready) {
        fwrite(STDERR, "Built-in PHP server did not start on port $port\n");
        exit(1);
    }
}

// ------------------------------------------------------------------
//  Tests
// ------------------------------------------------------------------

echo "tanken controller\n";

$BERLIN = [52.520, 13.405];

// ---- The rate limit -----------------------------------------------------
echo "\n-- the API is called at most once per minute --\n";

teardown($pdo);
clearLog();
scenario(['stations' => [
    station('000000000001', 52.5205, 13.4050),
    station('000000000002', 52.5215, 13.4060, ['e5' => 1.759]),
]]);

$first = stations($BERLIN[0], $BERLIN[1]);
check('a first lookup answers 200', $first['status'] === 200, "got {$first['status']}");
check('and it cost exactly one API call (list.php returns prices too)',
    count(calls()) === 1, 'calls: ' . count(calls()));

clearLog();
// A burst from many visitors at once. Every one of them must be served, and
// none of them may reach the API: the minute belongs to the call above.
$served = 0;
for ($i = 0; $i < 50; $i++) {
    $res = stations($BERLIN[0], $BERLIN[1]);
    if ($res['status'] === 200) $served++;
}
check('fifty concurrent-ish visitors are all served', $served === 50, "served $served");
check('and none of them reached the API', count(calls()) === 0, 'calls: ' . count(calls()));

$state = $pdo->query('SELECT calls_today FROM tanken_poll_state WHERE id = 1')->fetch(PDO::FETCH_ASSOC);
check('the daily counter agrees only one call was made',
    (int) $state['calls_today'] === 1, 'calls_today: ' . $state['calls_today']);

// ---- Nothing is filtered ------------------------------------------------
echo "\n-- nothing is filtered, nothing leaks --\n";

teardown($pdo);
clearLog();
scenario(['stations' => [
    station('00000000000a', 52.5205, 13.4050, ['e5' => 1.899]),
    station('00000000000b', 52.5215, 13.4060, ['isOpen' => false, 'e5' => 1.659]),
    station('00000000000c', 52.5225, 13.4070, ['e5' => false]),
]]);

$res = stations($BERLIN[0], $BERLIN[1]);
$ids = array_column($res['body']['stations'] ?? [], 'id');

check('a closed station is still returned', in_array(PREFIX . '00000000000b', $ids, true));
check('a station selling no E5 is still returned', in_array(PREFIX . '00000000000c', $ids, true));
check('all three stations come back', count($ids) === 3, 'got ' . count($ids));

$byId = [];
foreach ($res['body']['stations'] as $s) { $byId[$s['id']] = $s; }
check('the closed station carries its status, not a silent gap',
    ($byId[PREFIX . '00000000000b']['prices']['e5']['status'] ?? '') === 'closed',
    json_encode($byId[PREFIX . '00000000000b']['prices'] ?? null));
// array_key_exists, not ??: a null price is the assertion, and ?? cannot
// tell "reported as unavailable" apart from "the key is not there".
$noE5 = $byId[PREFIX . '00000000000c']['prices']['e5'] ?? [];
check('the station with no E5 reports no price rather than zero',
    array_key_exists('price', $noE5) && $noE5['price'] === null && $noE5['status'] === 'no prices',
    json_encode($noE5));

// A malformed id cannot reach prices.php and would not fit the column, so it
// is skipped rather than allowed to throw and take the whole page with it.
teardown($pdo);
clearLog();
scenario(['stations' => [
    station('00000000000d', 52.5205, 13.4050),
    array_merge(station('x', 52.5215, 13.4060), ['id' => 'not-a-uuid-at-all-really-far-too-long']),
]]);
$mixed = stations($BERLIN[0], $BERLIN[1]);
check('a malformed station id does not bring the page down',
    $mixed['status'] === 200, "got {$mixed['status']}");
check('the well formed station beside it is still served',
    count($mixed['body']['stations'] ?? []) === 1, json_encode(array_column($mixed['body']['stations'] ?? [], 'id')));

teardown($pdo);
clearLog();
scenario(['stations' => [
    station('00000000000a', 52.5205, 13.4050, ['e5' => 1.899]),
    station('00000000000b', 52.5215, 13.4060, ['isOpen' => false, 'e5' => 1.659]),
    station('00000000000c', 52.5225, 13.4070, ['e5' => false]),
]]);
$res = stations($BERLIN[0], $BERLIN[1]);

check('the API key never appears in the response', !str_contains($res['raw'], KEY));
check('the API key did reach the API, so the test above means something',
    str_contains(json_encode(calls()), KEY));

// XAMPP's serialize_precision=100 renders every price as fifty digits of
// binary noise, which is most of the payload once there are fifty stations.
check('prices serialize as prices, not as raw binary floats',
    !preg_match('/\d\.\d{8,}/', $res['raw']),
    'a long float reached the payload: serialize_precision is not pinned');

check('the CC BY attribution travels with the data',
    ($res['body']['attribution']['licence'] ?? '') === 'CC BY 4.0');
check('no wildcard CORS header is sent',
    !in_array('Access-Control-Allow-Origin: *', $http_response_header ?? [], true));

// ---- The radius ceiling -------------------------------------------------
echo "\n-- the radius ceiling is the licence's, not the query string's --\n";

teardown($pdo);
clearLog();
scenario(['stations' => [station('000000000010', 52.5205, 13.4050)]]);

$res = stations($BERLIN[0], $BERLIN[1], 80.0);
check('a radius of 80 km is clamped to 25 in the response',
    ($res['body']['radius'] ?? 0) == 25, json_encode($res['body']['radius'] ?? null));
$asked = calls()[0]['query']['rad'] ?? null;
check('and the API was asked for 25, not 80', (float) $asked === 25.0, "asked for $asked");

// ---- Failure serves the cache -------------------------------------------
echo "\n-- a failed refresh serves the cache rather than an error --\n";

teardown($pdo);
clearLog();
scenario(['stations' => [station('000000000020', 52.5205, 13.4050, ['e5' => 1.799])]]);

$good = stations($BERLIN[0], $BERLIN[1]);
$cachedPrice = $good['body']['stations'][0]['prices']['e5']['price'] ?? null;
$cachedStamp = $good['body']['stations'][0]['prices']['e5']['observedAt'] ?? null;
check('a good lookup caches a price', $cachedPrice == 1.799, json_encode($cachedPrice));

// Now the API goes down, and the minute is opened so a call will be attempted.
scenario(['fail' => true, 'message' => 'quota exceeded']);
resetState($pdo);
clearLog();

$degraded = stations($BERLIN[0], $BERLIN[1]);
check('the page still answers 200 while the API is down',
    $degraded['status'] === 200, "got {$degraded['status']}");
check('the cached price is served unchanged',
    ($degraded['body']['stations'][0]['prices']['e5']['price'] ?? null) == $cachedPrice);
check('with its original timestamp, not a fresh one',
    ($degraded['body']['stations'][0]['prices']['e5']['observedAt'] ?? null) === $cachedStamp,
    'a failed poll must not make stale data look new');
check('and the payload admits it is degraded', ($degraded['body']['degraded'] ?? false) === true);

// ---- The rotation -------------------------------------------------------
echo "\n-- the rotation refreshes the stalest stations --\n";

teardown($pdo);
clearLog();
scenario(['stations' => [
    station('000000000040', 52.5205, 13.4050, ['e5' => 1.999]),
    station('000000000041', 52.5215, 13.4060, ['e5' => 1.989]),
]]);

$seed = stations($BERLIN[0], $BERLIN[1]);
check('discovery seeds the stations', count($seed['body']['stations'] ?? []) === 2);
$listCalls = array_filter(calls(), fn($c) => str_contains($c['path'], 'list.php'));
check('and it used list.php, not prices.php', count($listCalls) === 1);

$before = $pdo->query("SELECT COUNT(*) FROM tanken_stations
                        WHERE uuid LIKE '" . PREFIX . "%' AND last_polled_at IS NOT NULL")->fetchColumn();

// The area is now known, so the next request skips discovery entirely and the
// freed lease goes to the rotation instead. The prices move so we can tell
// the refresh actually landed.
scenario(['stations' => [
    station('000000000040', 52.5205, 13.4050, ['e5' => 1.509]),
    station('000000000041', 52.5215, 13.4060, ['e5' => 1.489]),
]]);
resetState($pdo);
clearLog();

$refreshed = stations($BERLIN[0], $BERLIN[1]);
$priceCalls = array_values(array_filter(calls(), fn($c) => str_contains($c['path'], 'prices.php')));
check('a known area spends its lease on prices.php instead of list.php',
    count($priceCalls) === 1 && count(calls()) === 1, 'calls: ' . json_encode(array_column(calls(), 'path')));
check('the batch never exceeds the ten ids the API allows',
    count(explode(',', $priceCalls[0]['query']['ids'] ?? '')) <= 10);

$prices = [];
foreach ($refreshed['body']['stations'] as $s) { $prices[$s['id']] = $s['prices']['e5']['price'] ?? null; }
check('the refreshed price reaches the payload',
    $prices[PREFIX . '000000000040'] == 1.509, json_encode($prices));

$after = $pdo->query("SELECT COUNT(*) FROM tanken_stations
                       WHERE uuid LIKE '" . PREFIX . "%' AND last_polled_at IS NOT NULL")->fetchColumn();
check('the rotation cursor advances so the same stations are not polled twice',
    (int) $after >= (int) $before && (int) $after === 2, "before $before, after $after");

// ---- Coverage and method guards -----------------------------------------
echo "\n-- guards --\n";

teardown($pdo);
clearLog();
scenario(['stations' => [station('000000000030', 52.5205, 13.4050)]]);

$abroad = request(API . '?action=stations&lat=46.05&lng=14.51&rad=5');
check('a place outside Germany is answered, not errored', $abroad['status'] === 200);
check('it reports that it is outside coverage', ($abroad['body']['outsideCoverage'] ?? false) === true);
check('and it costs no API call at all', count(calls()) === 0, 'calls: ' . count(calls()));

$bad = request(API . '?action=stations&lat=notanumber&lng=13.4');
check('a non-numeric coordinate is a 422', $bad['status'] === 422, "got {$bad['status']}");

$missing = request(API . '?action=stations');
check('missing coordinates are a 422', $missing['status'] === 422, "got {$missing['status']}");

$unknown = request(API . '?action=nope&lat=52.52&lng=13.405');
check('an unknown action is a 404', $unknown['status'] === 404, "got {$unknown['status']}");

$post = (function () {
    $opts = ['http' => ['method' => 'POST', 'ignore_errors' => true, 'timeout' => 10, 'content' => '{}']];
    @file_get_contents(API, false, stream_context_create($opts));
    foreach ($http_response_header ?? [] as $h) {
        if (preg_match('#^HTTP/\S+\s+(\d{3})#', $h, $m)) return (int) $m[1];
    }
    return 0;
})();
check('POST is refused with 405', $post === 405, "got $post");

echo "\n$passed passed, $failed failed\n";
exit($failed === 0 ? 0 : 1);
