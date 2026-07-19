<?php
declare(strict_types=1);

// Integration tests for app/controllers/stocks-controller.php, the Borza LJSE
// tracker backend (full rework of the old JSON watchlist).
//
// Contract: every branch sits behind Auth::requireProjectRole('stocks') with
// no specific role name, so ANY granted role in the 'stocks' project passes
// and site admins pass implicitly. Per-user tables (transactions, alerts) are
// always scoped to the caller; market data (overview, history) is shared.
//
// Runs ONLY against the local scratch DB (127.0.0.1/portfolio): the DB_* env
// overrides below make database.php skip loading app/.env (which points at the
// remote production database). Never run these against prod.
//
// Requires the seeded test users in the local DB:
//   admin@test.local  session token = 64 x 'a'
//   guest@test.local  session token = 64 x 'b'
// and the stocks schema (app/models/stocks-model.sql) applied locally.
//
// Run: /opt/lampp/bin/php tests/stocks-controller.test.php

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
const PORT     = 8956;
const API      = 'http://' . HOST . ':' . PORT . '/app/controllers/stocks-controller.php';

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
function request(string $method, string $url, ?string $sid = null, ?array $body = null): array
{
    $headers = [];
    if ($sid !== null) {
        $headers[] = 'Cookie: portfolio_sid=' . $sid;
    }
    $opts = ['http' => ['method' => $method, 'ignore_errors' => true, 'timeout' => 15]];
    if ($body !== null) {
        $headers[] = 'Content-Type: application/json';
        $opts['http']['content'] = json_encode($body);
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

// ------------------------------------------------------------------
//  Fixtures
// ------------------------------------------------------------------

$pdo = new PDO(DB_DSN, DB_USER, DB_PASS, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
$adminId = (int) $pdo->query("SELECT id FROM users WHERE email = 'admin@test.local'")->fetchColumn();
$guestId = (int) $pdo->query("SELECT id FROM users WHERE email = 'guest@test.local'")->fetchColumn();
if ($adminId === 0 || $guestId === 0) {
    fwrite(STDERR, "Missing admin/guest fixture users in local DB\n");
    exit(1);
}

$projectId = (int) $pdo->query("SELECT id FROM projects WHERE project_key = 'stocks'")->fetchColumn();
if ($projectId === 0) {
    fwrite(STDERR, "stocks project missing; run app/models/stocks-model.sql on the local DB first\n");
    exit(1);
}

$krkgId = (int) $pdo->query("SELECT id FROM stocks_instruments WHERE symbol = 'KRKG'")->fetchColumn();
$slotrId = (int) $pdo->query("SELECT id FROM stocks_instruments WHERE symbol = 'SLOTR'")->fetchColumn();
if ($krkgId === 0 || $slotrId === 0) {
    fwrite(STDERR, "Seed instruments missing; run app/models/stocks-model.sql on the local DB first\n");
    exit(1);
}

// The scratch DB may also hold REAL rows from a live sync/backfill, so quote
// assertions run against dedicated throwaway instruments whose only prices
// are the 1999 fixtures below; cleanup removes the instruments (prices
// cascade) and the KRKG history fixtures by date.
$insInstrument = $pdo->prepare(
    "INSERT INTO stocks_instruments (symbol, isin, name, segment, security_type)
     VALUES (?, ?, ?, 'B', 'share')
     ON DUPLICATE KEY UPDATE name = VALUES(name)"
);
$insInstrument->execute(['TSTX', 'SI9900000001', 'Testna delnica']);
$insInstrument->execute(['TSTY', 'SI9900000002', 'Testna enodnevna']);
$insInstrument->execute(['TSTZ', 'SI9900000003', 'Testna brez cen']);
$tstxId = (int) $pdo->query("SELECT id FROM stocks_instruments WHERE symbol = 'TSTX'")->fetchColumn();
$tstyId = (int) $pdo->query("SELECT id FROM stocks_instruments WHERE symbol = 'TSTY'")->fetchColumn();

$FIXTURE_DATES = ['1999-03-01', '1999-03-02', '1999-03-03'];
$insPrice = $pdo->prepare(
    'INSERT INTO stocks_prices (instrument_id, trade_date, open_price, high_price, low_price, last_price, volume, turnover)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE last_price = VALUES(last_price)'
);
$insPrice->execute([$tstxId, '1999-03-01', 100, 112, 99, 100, 500, 50000]);
$insPrice->execute([$tstxId, '1999-03-02', 101, 111, 100, 110, 400, 44000]);
$insPrice->execute([$tstxId, '1999-03-03', 110, 110, 104, 105, 300, 31500]);
$insPrice->execute([$tstyId, '1999-03-03', 10.4, 10.5, 10.3, 10.43, 1000, 10430]);
$insPrice->execute([$krkgId, '1999-03-01', 100, 112, 99, 100, 500, 50000]);
$insPrice->execute([$krkgId, '1999-03-02', 101, 111, 100, 110, 400, 44000]);
$insPrice->execute([$krkgId, '1999-03-03', 110, 110, 104, 105, 300, 31500]);

$txBaseline    = (int) $pdo->query('SELECT COALESCE(MAX(id), 0) FROM stocks_transactions')->fetchColumn();
$alertBaseline = (int) $pdo->query('SELECT COALESCE(MAX(id), 0) FROM stocks_alerts')->fetchColumn();
$divBaseline   = (int) $pdo->query('SELECT COALESCE(MAX(id), 0) FROM stocks_dividends')->fetchColumn();

register_shutdown_function(function () use ($pdo, $guestId, $projectId, $txBaseline, $alertBaseline, $divBaseline, $FIXTURE_DATES) {
    $dates = "'" . implode("','", $FIXTURE_DATES) . "'";
    $pdo->exec("DELETE FROM stocks_prices WHERE trade_date IN ($dates)");
    $pdo->exec("DELETE FROM stocks_instruments WHERE symbol IN ('TSTX','TSTY','TSTZ')");
    $pdo->exec("DELETE FROM stocks_transactions WHERE id > $txBaseline");
    $pdo->exec("DELETE FROM stocks_alerts WHERE id > $alertBaseline");
    $pdo->exec("DELETE FROM stocks_dividends WHERE id > $divBaseline");
    $del = $pdo->prepare('DELETE FROM user_project_roles WHERE user_id = ? AND project_id = ?');
    $del->execute([$guestId, $projectId]);
});

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
//  The gate: login plus any role in the 'stocks' project
// ------------------------------------------------------------------

echo "stocks controller: gate\n";

$res = request('GET', API . '?resource=overview');
check('anonymous GET is 401', $res['status'] === 401, "got {$res['status']}");
check('no wildcard CORS header', !hasHeader($res['headers'], 'Access-Control-Allow-Origin'));
check('no-store on auth responses', hasHeader($res['headers'], 'Cache-Control'));

$res = request('GET', API . '?resource=overview', $GUEST_SID);
check('signed-in user without a stocks role is 403', $res['status'] === 403, "got {$res['status']}");

$grant = $pdo->prepare(
    'INSERT INTO user_project_roles (user_id, project_id, role) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE role = VALUES(role)'
);
$grant->execute([$guestId, $projectId, 'investor']);

$res = request('GET', API . '?resource=overview', $GUEST_SID);
check('granted role passes the gate', $res['status'] === 200, "got {$res['status']}");

$res = request('GET', API . '?resource=overview', $ADMIN_SID);
check('admin passes implicitly', $res['status'] === 200, "got {$res['status']}");

// ------------------------------------------------------------------
//  Overview: the board with latest quote, day move base and 52-week data
// ------------------------------------------------------------------

echo "stocks controller: overview\n";

$body = $res['body'];
check('overview lists instruments', is_array($body['instruments'] ?? null) && count($body['instruments']) >= 24);

$bySymbol = [];
foreach ($body['instruments'] as $row) {
    $bySymbol[$row['symbol']] = $row;
}
check('KRKG row present with name and segment',
    isset($bySymbol['KRKG']) && $bySymbol['KRKG']['name'] === 'Krka' && $bySymbol['KRKG']['segment'] === 'A');
$tstx = $bySymbol['TSTX'] ?? null;
check('latest close is the quote', $tstx !== null && (float) $tstx['last'] === 105.0, json_encode($tstx['last'] ?? null));
check('previous close comes from the prior row', (float) $tstx['prevClose'] === 110.0, json_encode($tstx['prevClose'] ?? null));
check('quote carries its trade date', $tstx['lastDate'] === '1999-03-03');
check('52-week stats use high/low columns', (float) $tstx['high52'] === 112.0 && (float) $tstx['low52'] === 99.0,
    json_encode([$tstx['high52'] ?? null, $tstx['low52'] ?? null]));
check('sparkline closes are chronological', $tstx['closes'] === [100.0, 110.0, 105.0] || $tstx['closes'] === [100, 110, 105],
    json_encode($tstx['closes'] ?? null));
check('board row carries the latest day volume and turnover',
    (float) $tstx['volume'] === 300.0 && (float) $tstx['turnover'] === 31500.0,
    json_encode([$tstx['volume'] ?? null, $tstx['turnover'] ?? null]));
check('instrument with a single row has null prevClose',
    array_key_exists('prevClose', $bySymbol['TSTY']) && $bySymbol['TSTY']['prevClose'] === null);
check('instrument with no prices has null last', array_key_exists('last', $bySymbol['TSTZ']) && $bySymbol['TSTZ']['last'] === null);

// ------------------------------------------------------------------
//  History: daily rows for one instrument
// ------------------------------------------------------------------

echo "stocks controller: history\n";

$res = request('GET', API . '?resource=history&id=' . $tstxId . '&from=1999-01-01&to=1999-12-31', $GUEST_SID);
check('history returns the fixture rows', $res['status'] === 200 && count($res['body']) === 3, json_encode($res['body']));
check('history rows carry OHLC and volume',
    ($res['body'][0]['date'] ?? '') === '1999-03-01' && (float) $res['body'][0]['high'] === 112.0
    && (float) $res['body'][0]['volume'] === 500.0);

$res = request('GET', API . '?resource=history&id=999999', $GUEST_SID);
check('history for an unknown instrument is 404', $res['status'] === 404, "got {$res['status']}");

// ------------------------------------------------------------------
//  Transactions: per-user ledger with validation
// ------------------------------------------------------------------

echo "stocks controller: transactions\n";

$res = request('POST', API . '?resource=transactions', $GUEST_SID, [
    'instrument_id' => $krkgId, 'side' => 'buy', 'quantity' => 10,
    'price' => 100.5, 'fees' => 5, 'trade_date' => '1999-03-02', 'note' => 'test nakup',
]);
check('guest creates a buy (201)', $res['status'] === 201, "got {$res['status']}: " . json_encode($res['body']));
$guestTxId = (int) ($res['body']['id'] ?? 0);
check('created transaction echoes its row', ($res['body']['side'] ?? '') === 'buy' && (float) $res['body']['quantity'] === 10.0);

$res = request('POST', API . '?resource=transactions', $ADMIN_SID, [
    'instrument_id' => $slotrId, 'side' => 'buy', 'quantity' => 50,
    'price' => 10.4, 'fees' => 1, 'trade_date' => '1999-03-03',
]);
check('admin creates their own buy (201)', $res['status'] === 201, "got {$res['status']}");

$res = request('GET', API . '?resource=transactions', $GUEST_SID);
$guestRows = array_filter($res['body'], fn ($t) => (int) $t['id'] > $txBaseline);
check('guest sees exactly their own transactions', count($guestRows) === 1, json_encode($res['body']));

$res = request('GET', API . '?resource=transactions', $ADMIN_SID);
$adminSees = array_column($res['body'], 'id');
check('admin does not see guest rows', !in_array($guestTxId, array_map('intval', $adminSees), true));

// Validation.
$res = request('POST', API . '?resource=transactions', $GUEST_SID, [
    'instrument_id' => 999999, 'side' => 'buy', 'quantity' => 1, 'price' => 1, 'trade_date' => '1999-03-02',
]);
check('unknown instrument is rejected (422)', $res['status'] === 422, "got {$res['status']}");

$res = request('POST', API . '?resource=transactions', $GUEST_SID, [
    'instrument_id' => $krkgId, 'side' => 'steal', 'quantity' => 1, 'price' => 1, 'trade_date' => '1999-03-02',
]);
check('bad side is rejected (422)', $res['status'] === 422, "got {$res['status']}");

$res = request('POST', API . '?resource=transactions', $GUEST_SID, [
    'instrument_id' => $krkgId, 'side' => 'buy', 'quantity' => 0, 'price' => 1, 'trade_date' => '1999-03-02',
]);
check('zero quantity is rejected (422)', $res['status'] === 422, "got {$res['status']}");

$res = request('POST', API . '?resource=transactions', $GUEST_SID, [
    'instrument_id' => $krkgId, 'side' => 'buy', 'quantity' => 1, 'price' => 1, 'trade_date' => 'sometime',
]);
check('bad date is rejected (422)', $res['status'] === 422, "got {$res['status']}");

// Update own row; a foreign row is invisible (404).
$res = request('PUT', API . '?resource=transactions&id=' . $guestTxId, $GUEST_SID, [
    'instrument_id' => $krkgId, 'side' => 'buy', 'quantity' => 12,
    'price' => 101, 'fees' => 6, 'trade_date' => '1999-03-02', 'note' => 'popravek',
]);
check('guest edits their transaction', $res['status'] === 200 && (float) $res['body']['quantity'] === 12.0,
    "got {$res['status']}");

$res = request('PUT', API . '?resource=transactions&id=' . $guestTxId, $ADMIN_SID, [
    'instrument_id' => $krkgId, 'side' => 'buy', 'quantity' => 1, 'price' => 1, 'trade_date' => '1999-03-02',
]);
check('another user cannot edit it (404)', $res['status'] === 404, "got {$res['status']}");

$res = request('DELETE', API . '?resource=transactions&id=' . $guestTxId, $ADMIN_SID);
check('another user cannot delete it (404)', $res['status'] === 404, "got {$res['status']}");

$res = request('DELETE', API . '?resource=transactions&id=' . $guestTxId, $GUEST_SID);
check('guest deletes their transaction', $res['status'] === 200, "got {$res['status']}");

$res = request('GET', API . '?resource=transactions', $GUEST_SID);
$guestRows = array_filter($res['body'], fn ($t) => (int) $t['id'] > $txBaseline);
check('deleted row is gone', count($guestRows) === 0);

// ------------------------------------------------------------------
//  Alerts: per-user Telegram rules
// ------------------------------------------------------------------

echo "stocks controller: alerts\n";

$res = request('POST', API . '?resource=alerts', $GUEST_SID, [
    'instrument_id' => $krkgId, 'kind' => 'above', 'threshold' => 280,
]);
check('guest creates a price alert (201)', $res['status'] === 201, "got {$res['status']}: " . json_encode($res['body']));
$guestAlertId = (int) ($res['body']['id'] ?? 0);
check('alert echoes symbol and active flag', ($res['body']['symbol'] ?? '') === 'KRKG' && (int) $res['body']['active'] === 1);

$res = request('POST', API . '?resource=alerts', $GUEST_SID, [
    'kind' => 'move', 'threshold' => 3,
]);
check('global move alert without instrument (201)', $res['status'] === 201, "got {$res['status']}");
check('global alert has null instrument', $res['body']['instrument_id'] === null);

$res = request('POST', API . '?resource=alerts', $GUEST_SID, ['kind' => 'above', 'threshold' => 100]);
check('above without instrument is rejected (422)', $res['status'] === 422, "got {$res['status']}");

$res = request('POST', API . '?resource=alerts', $GUEST_SID, [
    'instrument_id' => $krkgId, 'kind' => 'sideways', 'threshold' => 1,
]);
check('bad kind is rejected (422)', $res['status'] === 422, "got {$res['status']}");

$res = request('POST', API . '?resource=alerts', $GUEST_SID, [
    'instrument_id' => $krkgId, 'kind' => 'above', 'threshold' => 0,
]);
check('zero threshold is rejected (422)', $res['status'] === 422, "got {$res['status']}");

$res = request('GET', API . '?resource=alerts', $ADMIN_SID);
$adminAlertIds = array_map('intval', array_column($res['body'], 'id'));
check('alerts are per-user', !in_array($guestAlertId, $adminAlertIds, true));

$res = request('PUT', API . '?resource=alerts&id=' . $guestAlertId, $GUEST_SID, ['active' => 0]);
check('guest pauses their alert', $res['status'] === 200 && (int) $res['body']['active'] === 0, "got {$res['status']}");

$res = request('PUT', API . '?resource=alerts&id=' . $guestAlertId, $ADMIN_SID, ['active' => 1]);
check('another user cannot touch it (404)', $res['status'] === 404, "got {$res['status']}");

$res = request('DELETE', API . '?resource=alerts&id=' . $guestAlertId, $GUEST_SID);
check('guest deletes their alert', $res['status'] === 200, "got {$res['status']}");

// ------------------------------------------------------------------
//  Dividends: shared reference data
// ------------------------------------------------------------------

echo "stocks controller: dividends\n";

$res = request('POST', API . '?resource=dividends', $GUEST_SID, [
    'instrument_id' => $krkgId, 'amount' => 8.5, 'ex_date' => '1999-07-01', 'pay_date' => '1999-07-15', 'note' => 'test',
]);
check('member records an announced dividend (201)', $res['status'] === 201, "got {$res['status']}: " . json_encode($res['body']));
$divId = (int) ($res['body']['id'] ?? 0);

$res = request('GET', API . '?resource=dividends', $ADMIN_SID);
$divIds = array_map('intval', array_column($res['body'], 'id'));
check('dividends are shared across members', in_array($divId, $divIds, true));

$res = request('POST', API . '?resource=dividends', $GUEST_SID, ['instrument_id' => $krkgId, 'amount' => 0]);
check('zero dividend amount is rejected (422)', $res['status'] === 422, "got {$res['status']}");

$res = request('POST', API . '?resource=dividends', $GUEST_SID, [
    'instrument_id' => $krkgId, 'amount' => 1, 'ex_date' => 'julija nekoč',
]);
check('bad ex_date is rejected (422)', $res['status'] === 422, "got {$res['status']}");

$res = request('DELETE', API . '?resource=dividends&id=' . $divId, $ADMIN_SID);
check('any member can prune a dividend row', $res['status'] === 200, "got {$res['status']}");

echo "\n$passed passed, $failed failed\n";
exit($failed === 0 ? 0 : 1);
