<?php
declare(strict_types=1);

// Integration tests for app/services/stocks-sync-service.php (the LJSE
// fetch + Telegram alert engine behind views/stocks) and the controller's
// POST ?action=refresh trigger.
//
// No real network: a second built-in server runs tests/fixtures/ljse-stub.php
// and LJSE_BASE_URL / TELEGRAM_API_BASE point at it. The stub serves scenario
// JSON written by this suite and logs every call, so "Telegram got exactly one
// message" is a file assertion. The service itself is exercised in-process
// (like the dashboard seeding function), with DB_* pointed at the LOCAL scratch DB;
// the refresh action goes through a first built-in server over HTTP.
//
// Requires the seeded admin@test.local / guest@test.local users and the
// stocks schema (app/models/stocks-model.sql) in the local DB.
//
// Run: /opt/lampp/bin/php tests/stocks-sync.test.php

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
const APP_PORT  = 8957;
const STUB_PORT = 8958;
const API       = 'http://' . HOST . ':' . APP_PORT . '/app/controllers/stocks-controller.php';
const STUB_DIR  = __DIR__ . '/fixtures/stocks-stub-data';
const STUB_LOG  = STUB_DIR . '/requests.log';
const SYNC_FILE = DOC_ROOT . '/app/cache/stocks-sync.json';

$ADMIN_SID = str_repeat('a', 64);

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

function request(string $method, string $url, ?string $sid = null, ?array $body = null): array
{
    $headers = [];
    if ($sid !== null) $headers[] = 'Cookie: portfolio_sid=' . $sid;
    $opts = ['http' => ['method' => $method, 'ignore_errors' => true, 'timeout' => 15]];
    if ($body !== null) {
        $headers[] = 'Content-Type: application/json';
        $opts['http']['content'] = json_encode($body);
    }
    if ($headers) $opts['http']['header'] = implode("\r\n", $headers);
    $raw = @file_get_contents($url, false, stream_context_create($opts));
    $status = 0;
    foreach ($http_response_header ?? [] as $h) {
        if (preg_match('#^HTTP/\S+\s+(\d{3})#', $h, $m)) $status = (int) $m[1];
    }
    return ['status' => $status, 'body' => $raw !== false ? json_decode($raw, true) : null];
}

function telegramCalls(): array
{
    if (!file_exists(STUB_LOG)) return [];
    $lines = array_filter(explode("\n", trim((string) file_get_contents(STUB_LOG))));
    $calls = [];
    foreach ($lines as $line) {
        $entry = json_decode($line, true);
        if (is_array($entry) && str_contains($entry['path'], 'sendMessage')) $calls[] = $entry;
    }
    return $calls;
}

function ljseCalls(): array
{
    if (!file_exists(STUB_LOG)) return [];
    $lines = array_filter(explode("\n", trim((string) file_get_contents(STUB_LOG))));
    $calls = [];
    foreach ($lines as $line) {
        $entry = json_decode($line, true);
        if (is_array($entry) && !str_contains($entry['path'], 'sendMessage')) $calls[] = $entry;
    }
    return $calls;
}

function clearStubLog(): void
{
    @unlink(STUB_LOG);
}

// TradingPriceList scenario in the real endpoint's shape (only the fields the
// service reads). Dates live in 1999 so they can never collide with real rows.
function writeTradingPriceList(array $rowsBySegment, string $marketDate): void
{
    $priceList = [];
    foreach ($rowsBySegment as $segment => $rows) {
        $priceList[] = [
            'market_segment_id' => $segment,
            'tradingPriceList' => ['rows' => $rows],
        ];
    }
    file_put_contents(STUB_DIR . '/tradingpricelist.json', json_encode([
        'market_data_date' => $marketDate,
        'currency' => 'EUR',
        'priceList' => $priceList,
    ]));
}

function tplRow(string $symbol, string $isin, ?float $last, array $over = []): array
{
    return array_merge([
        'symbol' => $symbol,
        'isin' => $isin,
        'last_price_n' => $last,
        'open_price_n' => $last,
        'high_price_n' => $last !== null ? $last * 1.02 : null,
        'low_price_n' => $last !== null ? $last * 0.98 : null,
        'volume_n' => 100,
        'turnover_n' => $last !== null ? $last * 100 : null,
        'IsTraded' => $last !== null,
        'date' => '1999-03-04T00:00:00',
    ], $over);
}

// ------------------------------------------------------------------
//  Environment: in-process service + two servers
// ------------------------------------------------------------------

@mkdir(STUB_DIR, 0777, true);

$pdo = new PDO(DB_DSN, DB_USER, DB_PASS, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
$adminId = (int) $pdo->query("SELECT id FROM users WHERE email = 'admin@test.local'")->fetchColumn();
$guestId = (int) $pdo->query("SELECT id FROM users WHERE email = 'guest@test.local'")->fetchColumn();
if ($adminId === 0 || $guestId === 0) {
    fwrite(STDERR, "Missing admin/guest fixture users in local DB\n");
    exit(1);
}
$krkgId = (int) $pdo->query("SELECT id FROM stocks_instruments WHERE symbol = 'KRKG'")->fetchColumn();
$slotrId = (int) $pdo->query("SELECT id FROM stocks_instruments WHERE symbol = 'SLOTR'")->fetchColumn();
if ($krkgId === 0 || $slotrId === 0) {
    fwrite(STDERR, "Seed instruments missing; run app/models/stocks-model.sql locally first\n");
    exit(1);
}

$alertBaseline = (int) $pdo->query('SELECT COALESCE(MAX(id), 0) FROM stocks_alerts')->fetchColumn();
$syncBackup = file_exists(SYNC_FILE) ? file_get_contents(SYNC_FILE) : null;

register_shutdown_function(function () use ($pdo, $alertBaseline, $syncBackup) {
    $pdo->exec("DELETE FROM stocks_prices WHERE trade_date BETWEEN '1999-01-01' AND '1999-12-31'");
    $pdo->exec("DELETE FROM stocks_alerts WHERE id > $alertBaseline");
    $pdo->exec("DELETE FROM stocks_instruments WHERE symbol = 'NEWX'");
    if ($syncBackup !== null) {
        file_put_contents(SYNC_FILE, $syncBackup);
    } else {
        @unlink(SYNC_FILE);
    }
    @unlink(STUB_LOG);
    @unlink(STUB_DIR . '/tradingpricelist.json');
    @unlink(STUB_DIR . '/securityhistory-SI0031102120.json');
    @rmdir(STUB_DIR);
});

// In-process env for the service (database.php skips app/.env when DB_* set).
$env = [
    'DB_HOST' => '127.0.0.1', 'DB_PORT' => '3306', 'DB_NAME' => 'portfolio',
    'DB_USER_W' => DB_USER, 'DB_PASS_W' => DB_PASS,
    'DB_USER_R' => DB_USER, 'DB_PASS_R' => DB_PASS,
    'LJSE_BASE_URL' => 'http://' . HOST . ':' . STUB_PORT,
    'TELEGRAM_API_BASE' => 'http://' . HOST . ':' . STUB_PORT,
    'TELEGRAM_BOT_TOKEN' => 'stub-token',
    'TELEGRAM_CHAT_ID' => '42',
    'STOCKS_SYNC_TTL' => '300',
];
foreach ($env as $k => $v) {
    $_ENV[$k] = $v;
    putenv("$k=$v");
}

define('SECURE_ACCESS', true);
require_once DOC_ROOT . '/app/config/database.php';
require_once DOC_ROOT . '/app/services/stocks-sync-service.php';

// Stub server (LJSE + Telegram).
$nullDev = '/dev/null';
$stubEnv = [
    'STOCKS_STUB_DIR' => STUB_DIR,
    'STOCKS_STUB_LOG' => STUB_LOG,
    'PATH' => getenv('PATH') ?: '/usr/bin:/bin',
];
$stub = proc_open(
    [PHP_BIN, '-S', HOST . ':' . STUB_PORT, __DIR__ . '/fixtures/ljse-stub.php'],
    [1 => ['file', $nullDev, 'w'], 2 => ['file', $nullDev, 'w']],
    $stubPipes, __DIR__, $stubEnv
);
register_shutdown_function(function () use ($stub) {
    if (is_resource($stub)) proc_terminate($stub);
});

// App server for the refresh action.
$serverEnv = $env + ['PATH' => getenv('PATH') ?: '/usr/bin:/bin'];
$server = proc_open(
    [PHP_BIN, '-d', 'variables_order=EGPCS', '-S', HOST . ':' . APP_PORT, '-t', DOC_ROOT],
    [1 => ['file', $nullDev, 'w'], 2 => ['file', $nullDev, 'w']],
    $pipes, DOC_ROOT, $serverEnv
);
register_shutdown_function(function () use ($server) {
    if (is_resource($server)) proc_terminate($server);
});

foreach ([STUB_PORT, APP_PORT] as $port) {
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

$db = Database::write();

// ------------------------------------------------------------------
//  run(): prices land in the DB, discovery, idempotence
// ------------------------------------------------------------------

echo "stocks sync: run\n";

// Previous day close for KRKG so the move alert has a base.
$pdo->prepare(
    'INSERT INTO stocks_prices (instrument_id, trade_date, last_price) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE last_price = VALUES(last_price)'
)->execute([$krkgId, '1999-03-03', 110]);

writeTradingPriceList([
    'A' => [
        tplRow('KRKG', 'SI0031102120', 120.0),
        tplRow('PHANTOM', 'SI0000000001', null), // pending day, no trades: skipped
    ],
    'B' => [tplRow('NEWX', 'SI9999999999', 5.5)],
    'E' => [tplRow('SLOTR', 'SI0027400017', 10.5)],
    'D' => [tplRow('RS81', 'SI0002104345', 99.9)], // bonds segment: ignored
], '1999-03-04');

clearStubLog();
$result = StocksSync::run($db);
check('run reports the market date', ($result['marketDate'] ?? '') === '1999-03-04', json_encode($result));
check('run counts stored quotes', ($result['prices'] ?? 0) === 3, json_encode($result));

$row = $pdo->query("SELECT * FROM stocks_prices WHERE instrument_id = $krkgId AND trade_date = '1999-03-04'")->fetch(PDO::FETCH_ASSOC);
check('KRKG day row upserted with OHLC', $row !== false && (float) $row['last_price'] === 120.0
    && (float) $row['high_price'] === 122.4, json_encode($row));

$newx = $pdo->query("SELECT * FROM stocks_instruments WHERE symbol = 'NEWX'")->fetch(PDO::FETCH_ASSOC);
check('new listing auto-discovered with symbol as name', $newx !== false && $newx['name'] === 'NEWX'
    && $newx['segment'] === 'B');

$phantom = $pdo->query("SELECT COUNT(*) FROM stocks_instruments WHERE symbol = 'PHANTOM'")->fetchColumn();
check('untraded pending row stores no price', (int) $pdo->query(
    "SELECT COUNT(*) FROM stocks_prices p JOIN stocks_instruments i ON i.id = p.instrument_id
     WHERE i.symbol = 'PHANTOM'"
)->fetchColumn() === 0);

$bond = $pdo->query("SELECT COUNT(*) FROM stocks_instruments WHERE symbol = 'RS81'")->fetchColumn();
check('bond segment is ignored', (int) $bond === 0);

$countBefore = (int) $pdo->query("SELECT COUNT(*) FROM stocks_prices WHERE trade_date = '1999-03-04'")->fetchColumn();
StocksSync::run($db);
$countAfter = (int) $pdo->query("SELECT COUNT(*) FROM stocks_prices WHERE trade_date = '1999-03-04'")->fetchColumn();
check('re-run is idempotent', $countBefore === $countAfter && $countBefore === 3);

check('sync file records the run', file_exists(SYNC_FILE)
    && str_contains((string) file_get_contents(SYNC_FILE), '1999-03-04'));

// ------------------------------------------------------------------
//  Alerts: Telegram fires once per rule per market day
// ------------------------------------------------------------------

echo "stocks sync: alerts\n";

$insAlert = $pdo->prepare(
    'INSERT INTO stocks_alerts (user_id, instrument_id, kind, threshold, active) VALUES (?, ?, ?, ?, ?)'
);
$insAlert->execute([$guestId, $krkgId, 'above', 115, 1]);
$aboveId = (int) $pdo->lastInsertId();
$insAlert->execute([$guestId, null, 'move', 5, 1]);
$moveId = (int) $pdo->lastInsertId();
$insAlert->execute([$guestId, $krkgId, 'below', 100, 1]);
$belowId = (int) $pdo->lastInsertId();
$insAlert->execute([$guestId, $krkgId, 'above', 110, 0]);
$inactiveId = (int) $pdo->lastInsertId();

clearStubLog();
$result = StocksSync::run($db);
$calls = telegramCalls();
check('one Telegram message per run', count($calls) === 1, count($calls) . ' calls');
check('run reports fired alerts', ($result['alertsFired'] ?? 0) === 2, json_encode($result));

$payload = json_decode($calls[0]['body'] ?? '{}', true);
$text = (string) ($payload['text'] ?? '');
check('message goes to the configured chat', ($payload['chat_id'] ?? '') === '42');
check('message names the symbol and threshold', str_contains($text, 'KRKG') && str_contains($text, '115'));
check('message is Slovenian', str_contains($text, 'nad pragom') || str_contains($text, 'Borzna opozorila'));

$fired = $pdo->query("SELECT last_fired_date FROM stocks_alerts WHERE id = $aboveId")->fetchColumn();
check('fired alert is stamped with the market date', $fired === '1999-03-04');
$quiet = $pdo->query("SELECT last_fired_date FROM stocks_alerts WHERE id = $belowId")->fetchColumn();
check('quiet alert is not stamped', $quiet === null);
$inactive = $pdo->query("SELECT last_fired_date FROM stocks_alerts WHERE id = $inactiveId")->fetchColumn();
check('inactive alert is not stamped', $inactive === null);

clearStubLog();
StocksSync::run($db);
check('same market day never fires twice', count(telegramCalls()) === 0);

// A board-wide move rule reports EVERY mover, not only the first one it finds.
$pdo->prepare(
    'INSERT INTO stocks_prices (instrument_id, trade_date, last_price) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE last_price = VALUES(last_price)'
)->execute([$slotrId, '1999-03-03', 10.0]); // SLOTR: 10.0 -> 10.5 is +5 %
$insAlert->execute([$guestId, null, 'move', 4, 1]);
$moveAllId = (int) $pdo->lastInsertId();

clearStubLog();
StocksSync::run($db);
$calls = telegramCalls();
$text = (string) (json_decode($calls[0]['body'] ?? '{}', true)['text'] ?? '');
check('board-wide move rule lists every mover', count($calls) === 1
    && str_contains($text, 'KRKG') && str_contains($text, 'SLOTR'), $text);

// ------------------------------------------------------------------
//  runIfStale(): the TTL guard
// ------------------------------------------------------------------

echo "stocks sync: staleness\n";

clearStubLog();
$result = StocksSync::runIfStale($db);
check('fresh cache skips the fetch', ($result['refreshed'] ?? true) === false && count(ljseCalls()) === 0,
    json_encode($result));

file_put_contents(SYNC_FILE, json_encode([
    'syncedAt' => date('c', time() - 3600), 'marketDate' => '1999-03-04',
]));
clearStubLog();
$result = StocksSync::runIfStale($db);
check('stale cache triggers a fetch', ($result['refreshed'] ?? false) === true && count(ljseCalls()) === 1,
    json_encode($result));

// ------------------------------------------------------------------
//  Failure: exchange unreachable
// ------------------------------------------------------------------

echo "stocks sync: failure\n";

@unlink(STUB_DIR . '/tradingpricelist.json');
$countBefore = (int) $pdo->query('SELECT COUNT(*) FROM stocks_prices')->fetchColumn();
$result = StocksSync::run($db);
check('down exchange reports an error, no exception', isset($result['error']), json_encode($result));
$countAfter = (int) $pdo->query('SELECT COUNT(*) FROM stocks_prices')->fetchColumn();
check('failed run leaves prices untouched', $countBefore === $countAfter);

// ------------------------------------------------------------------
//  Backfill: per-security history
// ------------------------------------------------------------------

echo "stocks sync: backfill\n";

file_put_contents(STUB_DIR . '/securityhistory-SI0031102120.json', json_encode([
    'rows' => [
        ['date_yyyy_MM_dd' => '1999-02-01', 'open_price_n' => 100, 'high_price_n' => 102,
         'low_price_n' => 99, 'last_price_n' => 101, 'volume_n' => 50, 'turnover_n' => 5050],
        ['date_yyyy_MM_dd' => '1999-02-02', 'open_price_n' => 101, 'high_price_n' => 103,
         'low_price_n' => 100, 'last_price_n' => 102.5, 'volume_n' => 60, 'turnover_n' => 6150],
        ['date_yyyy_MM_dd' => '1999-02-03', 'open_price_n' => null, 'high_price_n' => null,
         'low_price_n' => null, 'last_price_n' => null, 'volume_n' => 0, 'turnover_n' => 0],
    ],
]));

$stored = StocksSync::backfillInstrument($db, $krkgId, '1999-02-01', '1999-02-28');
check('backfill stores the traded days', $stored === 2, "stored $stored");
$close = $pdo->query("SELECT last_price FROM stocks_prices WHERE instrument_id = $krkgId AND trade_date = '1999-02-02'")->fetchColumn();
check('backfilled close is exact', (float) $close === 102.5);

// ------------------------------------------------------------------
//  The controller's refresh trigger
// ------------------------------------------------------------------

echo "stocks sync: refresh action\n";

$res = request('POST', API . '?action=refresh');
check('anonymous refresh is 401', $res['status'] === 401, "got {$res['status']}");

writeTradingPriceList(['A' => [tplRow('KRKG', 'SI0031102120', 121.0)]], '1999-03-04');
file_put_contents(SYNC_FILE, json_encode(['syncedAt' => date('c', time() - 3600)]));
$res = request('POST', API . '?action=refresh', $ADMIN_SID);
check('admin refresh runs the sync', $res['status'] === 200 && ($res['body']['refreshed'] ?? false) === true,
    "got {$res['status']}: " . json_encode($res['body']));

echo "\n$passed passed, $failed failed\n";
exit($failed === 0 ? 0 : 1);
