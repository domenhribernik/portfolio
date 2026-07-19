<?php
declare(strict_types=1);
define('SECURE_ACCESS', true);

header('Content-Type: application/json; charset=utf-8');
// Responses vary with the session cookie, so they must never be cached.
header('Cache-Control: no-store');
// No Access-Control-Allow-Origin here: everything is gated by the session
// cookie, and wildcard CORS is incompatible with cookie auth.

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

require_once __DIR__ . '/../config/dev-mode.php';
require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../config/auth.php';

// Borza: the LJSE tracker backend (views/stocks). Market data lives in
// stocks_instruments / stocks_prices and is written by the sync service
// (app/services/stocks-sync-service.php); transactions and alert rules are
// per-user rows, always scoped to the caller.
//
// Private-audience gate: any role in the 'stocks' project passes (grant e.g.
// 'investor' from views/admin); site admins pass implicitly. Reads included,
// this is not a public view.

$GLOBALS['stocksUser'] = Auth::requireProjectRole('stocks');

// How many closes the board's sparklines carry, and how far the 52-week
// window reaches back from each instrument's own latest trading day.
// (Declared before the dispatch below runs, since top-level consts are not
// hoisted past an exit.)
const SPARKLINE_DAYS = 60;
const WEEK52_DAYS = 365;
const TX_SIDES = ['buy', 'sell', 'div'];
const ALERT_KINDS = ['above', 'below', 'move'];

$method   = $_SERVER['REQUEST_METHOD'];
$resource = $_GET['resource'] ?? null;
$action   = $_GET['action']   ?? null;
$id       = isset($_GET['id']) ? (int) $_GET['id'] : null;

try {
    if ($action === 'refresh') {
        if ($method !== 'POST') sendError('Method not allowed', 405);
        refreshMarketData();
    } elseif ($resource === 'overview') {
        if ($method !== 'GET') sendError('Method not allowed', 405);
        getOverview();
    } elseif ($resource === 'history') {
        if ($method !== 'GET') sendError('Method not allowed', 405);
        getHistory($id);
    } elseif ($resource === 'transactions') {
        handleTransactions($method, $id);
    } elseif ($resource === 'alerts') {
        handleAlerts($method, $id);
    } elseif ($resource === 'dividends') {
        handleDividends($method, $id);
    } else {
        sendError('Unknown resource. Use ?resource=overview, history, transactions, alerts or dividends', 400);
    }
} catch (Exception $e) {
    error_log('Stocks controller error: ' . $e->getMessage());
    sendError('Internal server error', 500);
}

// --- Helpers ---

function sendJson(mixed $data, int $code = 200): void
{
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

function sendError(string $message, int $code = 400): void
{
    http_response_code($code);
    echo json_encode(['error' => $message], JSON_UNESCAPED_UNICODE);
    exit;
}

function readBody(): array
{
    $raw = file_get_contents('php://input');
    if (!$raw) return [];
    $json = json_decode($raw, true);
    return is_array($json) ? $json : [];
}

function userId(): int
{
    return (int) $GLOBALS['stocksUser']['id'];
}

function numOrNull(mixed $v): ?float
{
    return $v === null ? null : (float) $v;
}

// --- Market data ---

/**
 * The whole board in one payload: every instrument with its latest quote,
 * previous close, its own 52-week range and a sparkline series. Per-
 * instrument LIMIT queries keep this window-function-free (MySQL-version
 * agnostic); 24 indexed lookups are nothing for a private tool.
 */
function getOverview(): void
{
    $db = Database::read();
    $instruments = $db->query(
        'SELECT id, symbol, isin, name, segment, security_type
         FROM stocks_instruments WHERE is_active = 1
         ORDER BY segment, symbol'
    )->fetchAll();

    $recent = $db->prepare(
        'SELECT trade_date, last_price, high_price, low_price, volume, turnover
         FROM stocks_prices WHERE instrument_id = ?
         ORDER BY trade_date DESC LIMIT 400'
    );

    foreach ($instruments as &$row) {
        $recent->execute([$row['id']]);
        $prices = $recent->fetchAll();

        $row['last'] = $row['prevClose'] = $row['lastDate'] = null;
        $row['high52'] = $row['low52'] = null;
        $row['volume'] = $row['turnover'] = null;
        $row['closes'] = [];
        if (!$prices) continue;

        $latest = $prices[0];
        $row['last'] = (float) $latest['last_price'];
        $row['lastDate'] = $latest['trade_date'];
        $row['volume'] = numOrNull($latest['volume']);
        $row['turnover'] = numOrNull($latest['turnover']);
        $row['prevClose'] = isset($prices[1]) ? (float) $prices[1]['last_price'] : null;

        $windowFloor = date('Y-m-d', strtotime($latest['trade_date'] . ' -' . WEEK52_DAYS . ' days'));
        $high = null;
        $low = null;
        foreach ($prices as $p) {
            if ($p['trade_date'] < $windowFloor) break;
            $dayHigh = (float) ($p['high_price'] ?? $p['last_price']);
            $dayLow = (float) ($p['low_price'] ?? $p['last_price']);
            $high = $high === null ? $dayHigh : max($high, $dayHigh);
            $low = $low === null ? $dayLow : min($low, $dayLow);
        }
        $row['high52'] = $high;
        $row['low52'] = $low;

        $spark = array_slice($prices, 0, SPARKLINE_DAYS);
        $row['closes'] = array_reverse(array_map(fn ($p) => (float) $p['last_price'], $spark));
    }
    unset($row);

    sendJson([
        'instruments' => $instruments,
        'syncedAt' => lastSyncTime(),
    ]);
}

/** Daily OHLC rows for one instrument, oldest first. */
function getHistory(?int $id): void
{
    if (!$id) sendError('id required', 400);
    $db = Database::read();

    $exists = $db->prepare('SELECT id FROM stocks_instruments WHERE id = ?');
    $exists->execute([$id]);
    if ($exists->fetchColumn() === false) sendError('Instrument not found', 404);

    $to = preg_match('/^\d{4}-\d{2}-\d{2}$/', $_GET['to'] ?? '') ? $_GET['to'] : date('Y-m-d');
    $from = preg_match('/^\d{4}-\d{2}-\d{2}$/', $_GET['from'] ?? '')
        ? $_GET['from']
        : date('Y-m-d', strtotime($to . ' -365 days'));

    $stmt = $db->prepare(
        'SELECT trade_date, open_price, high_price, low_price, last_price, volume, turnover
         FROM stocks_prices
         WHERE instrument_id = ? AND trade_date BETWEEN ? AND ?
         ORDER BY trade_date ASC'
    );
    $stmt->execute([$id, $from, $to]);

    $rows = array_map(fn ($p) => [
        'date' => $p['trade_date'],
        'open' => numOrNull($p['open_price']),
        'high' => numOrNull($p['high_price']),
        'low' => numOrNull($p['low_price']),
        'close' => (float) $p['last_price'],
        'volume' => numOrNull($p['volume']),
        'turnover' => numOrNull($p['turnover']),
    ], $stmt->fetchAll());

    sendJson($rows);
}

/** When the sync last ran (ISO timestamp) or null before the first run. */
function lastSyncTime(): ?string
{
    $file = __DIR__ . '/../cache/stocks/last-sync.json';
    if (!file_exists($file)) return null;
    $data = json_decode((string) file_get_contents($file), true);
    return is_array($data) ? ($data['syncedAt'] ?? null) : null;
}

/** POST ?action=refresh: pull fresh LJSE data if the cache has gone stale. */
function refreshMarketData(): void
{
    require_once __DIR__ . '/../services/stocks-sync-service.php';
    $result = StocksSync::runIfStale(Database::write());
    sendJson($result);
}

// --- Per-user resources ---

/**
 * Validate a transaction body; returns the clean values or exits with 422.
 * Shared by create and update so both enforce identical rules.
 */
function validateTransaction(array $body): array
{
    $instrumentId = (int) ($body['instrument_id'] ?? 0);
    $side = (string) ($body['side'] ?? '');
    $quantity = (float) ($body['quantity'] ?? 0);
    $price = (float) ($body['price'] ?? -1);
    $fees = (float) ($body['fees'] ?? 0);
    $date = (string) ($body['trade_date'] ?? '');
    $note = trim((string) ($body['note'] ?? ''));

    $exists = Database::read()->prepare('SELECT id FROM stocks_instruments WHERE id = ?');
    $exists->execute([$instrumentId]);
    if ($exists->fetchColumn() === false) sendError('Neznan vrednostni papir', 422);
    if (!in_array($side, TX_SIDES, true)) sendError('Neveljavna vrsta transakcije', 422);
    if ($quantity <= 0) sendError('Količina mora biti večja od 0', 422);
    if ($price < 0) sendError('Cena ne sme biti negativna', 422);
    if ($fees < 0) sendError('Stroški ne smejo biti negativni', 422);
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date) || !strtotime($date)) sendError('Neveljaven datum', 422);
    if (mb_strlen($note) > 200) sendError('Opomba je predolga', 422);

    return [$instrumentId, $side, $quantity, $price, $fees, $date, $note !== '' ? $note : null];
}

function transactionRow(int $id): ?array
{
    $stmt = Database::read()->prepare(
        'SELECT t.id, t.instrument_id, i.symbol, t.side, t.quantity, t.price, t.fees, t.trade_date, t.note
         FROM stocks_transactions t
         JOIN stocks_instruments i ON i.id = t.instrument_id
         WHERE t.id = ? AND t.user_id = ?'
    );
    $stmt->execute([$id, userId()]);
    $row = $stmt->fetch();
    return $row === false ? null : castTransaction($row);
}

function castTransaction(array $row): array
{
    $row['id'] = (int) $row['id'];
    $row['instrument_id'] = (int) $row['instrument_id'];
    $row['quantity'] = (float) $row['quantity'];
    $row['price'] = (float) $row['price'];
    $row['fees'] = (float) $row['fees'];
    return $row;
}

function handleTransactions(string $method, ?int $id): void
{
    $db = Database::write();

    if ($method === 'GET') {
        $stmt = $db->prepare(
            'SELECT t.id, t.instrument_id, i.symbol, t.side, t.quantity, t.price, t.fees, t.trade_date, t.note
             FROM stocks_transactions t
             JOIN stocks_instruments i ON i.id = t.instrument_id
             WHERE t.user_id = ?
             ORDER BY t.trade_date DESC, t.id DESC'
        );
        $stmt->execute([userId()]);
        sendJson(array_map('castTransaction', $stmt->fetchAll()));

    } elseif ($method === 'POST') {
        [$instrumentId, $side, $quantity, $price, $fees, $date, $note] = validateTransaction(readBody());
        $stmt = $db->prepare(
            'INSERT INTO stocks_transactions (user_id, instrument_id, side, quantity, price, fees, trade_date, note)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        );
        $stmt->execute([userId(), $instrumentId, $side, $quantity, $price, $fees, $date, $note]);
        sendJson(transactionRow((int) $db->lastInsertId()), 201);

    } elseif ($method === 'PUT') {
        if (!$id) sendError('id required', 400);
        if (transactionRow($id) === null) sendError('Transakcija ne obstaja', 404);
        [$instrumentId, $side, $quantity, $price, $fees, $date, $note] = validateTransaction(readBody());
        $stmt = $db->prepare(
            'UPDATE stocks_transactions
             SET instrument_id = ?, side = ?, quantity = ?, price = ?, fees = ?, trade_date = ?, note = ?
             WHERE id = ? AND user_id = ?'
        );
        $stmt->execute([$instrumentId, $side, $quantity, $price, $fees, $date, $note, $id, userId()]);
        sendJson(transactionRow($id));

    } elseif ($method === 'DELETE') {
        if (!$id) sendError('id required', 400);
        $stmt = $db->prepare('DELETE FROM stocks_transactions WHERE id = ? AND user_id = ?');
        $stmt->execute([$id, userId()]);
        if ($stmt->rowCount() === 0) sendError('Transakcija ne obstaja', 404);
        sendJson(['ok' => true]);

    } else {
        sendError('Method not allowed', 405);
    }
}

function alertRow(int $id): ?array
{
    $stmt = Database::read()->prepare(
        'SELECT a.id, a.instrument_id, i.symbol, a.kind, a.threshold, a.active, a.last_fired_date
         FROM stocks_alerts a
         LEFT JOIN stocks_instruments i ON i.id = a.instrument_id
         WHERE a.id = ? AND a.user_id = ?'
    );
    $stmt->execute([$id, userId()]);
    $row = $stmt->fetch();
    return $row === false ? null : castAlert($row);
}

function castAlert(array $row): array
{
    $row['id'] = (int) $row['id'];
    $row['instrument_id'] = $row['instrument_id'] === null ? null : (int) $row['instrument_id'];
    $row['threshold'] = (float) $row['threshold'];
    $row['active'] = (int) $row['active'];
    return $row;
}

function handleAlerts(string $method, ?int $id): void
{
    $db = Database::write();

    if ($method === 'GET') {
        $stmt = $db->prepare(
            'SELECT a.id, a.instrument_id, i.symbol, a.kind, a.threshold, a.active, a.last_fired_date
             FROM stocks_alerts a
             LEFT JOIN stocks_instruments i ON i.id = a.instrument_id
             WHERE a.user_id = ?
             ORDER BY a.id DESC'
        );
        $stmt->execute([userId()]);
        sendJson(array_map('castAlert', $stmt->fetchAll()));

    } elseif ($method === 'POST') {
        $body = readBody();
        $kind = (string) ($body['kind'] ?? '');
        $threshold = (float) ($body['threshold'] ?? 0);
        $instrumentId = isset($body['instrument_id']) && $body['instrument_id'] !== null
            ? (int) $body['instrument_id'] : null;

        if (!in_array($kind, ALERT_KINDS, true)) sendError('Neveljavna vrsta opozorila', 422);
        if ($threshold <= 0) sendError('Prag mora biti večji od 0', 422);
        if ($instrumentId === null && $kind !== 'move') {
            sendError('Cenovno opozorilo potrebuje vrednostni papir', 422);
        }
        if ($instrumentId !== null) {
            $exists = Database::read()->prepare('SELECT id FROM stocks_instruments WHERE id = ?');
            $exists->execute([$instrumentId]);
            if ($exists->fetchColumn() === false) sendError('Neznan vrednostni papir', 422);
        }

        $stmt = $db->prepare(
            'INSERT INTO stocks_alerts (user_id, instrument_id, kind, threshold) VALUES (?, ?, ?, ?)'
        );
        $stmt->execute([userId(), $instrumentId, $kind, $threshold]);
        sendJson(alertRow((int) $db->lastInsertId()), 201);

    } elseif ($method === 'PUT') {
        if (!$id) sendError('id required', 400);
        $row = alertRow($id);
        if ($row === null) sendError('Opozorilo ne obstaja', 404);

        $body = readBody();
        $active = array_key_exists('active', $body) ? (int) ((bool) $body['active']) : $row['active'];
        $threshold = array_key_exists('threshold', $body) ? (float) $body['threshold'] : $row['threshold'];
        if ($threshold <= 0) sendError('Prag mora biti večji od 0', 422);

        $stmt = $db->prepare('UPDATE stocks_alerts SET active = ?, threshold = ? WHERE id = ? AND user_id = ?');
        $stmt->execute([$active, $threshold, $id, userId()]);
        sendJson(alertRow($id));

    } elseif ($method === 'DELETE') {
        if (!$id) sendError('id required', 400);
        $stmt = $db->prepare('DELETE FROM stocks_alerts WHERE id = ? AND user_id = ?');
        $stmt->execute([$id, userId()]);
        if ($stmt->rowCount() === 0) sendError('Opozorilo ne obstaja', 404);
        sendJson(['ok' => true]);

    } else {
        sendError('Method not allowed', 405);
    }
}

// Announced dividends are shared reference data (LJSE has no dividend API,
// so members maintain the calendar by hand); any project member may add or
// prune rows, created_by only records who added one.
function handleDividends(string $method, ?int $id): void
{
    $db = Database::write();

    if ($method === 'GET') {
        $rows = Database::read()->query(
            'SELECT d.id, d.instrument_id, i.symbol, d.ex_date, d.pay_date, d.amount, d.note
             FROM stocks_dividends d
             JOIN stocks_instruments i ON i.id = d.instrument_id
             ORDER BY d.ex_date IS NULL, d.ex_date DESC, d.id DESC'
        )->fetchAll();
        foreach ($rows as &$r) {
            $r['id'] = (int) $r['id'];
            $r['instrument_id'] = (int) $r['instrument_id'];
            $r['amount'] = (float) $r['amount'];
        }
        unset($r);
        sendJson($rows);

    } elseif ($method === 'POST') {
        $body = readBody();
        $instrumentId = (int) ($body['instrument_id'] ?? 0);
        $amount = (float) ($body['amount'] ?? 0);
        $note = trim((string) ($body['note'] ?? ''));

        $exists = Database::read()->prepare('SELECT id FROM stocks_instruments WHERE id = ?');
        $exists->execute([$instrumentId]);
        if ($exists->fetchColumn() === false) sendError('Neznan vrednostni papir', 422);
        if ($amount <= 0) sendError('Dividenda mora biti večja od 0', 422);
        if (mb_strlen($note) > 200) sendError('Opomba je predolga', 422);

        $dates = [];
        foreach (['ex_date', 'pay_date'] as $field) {
            $value = $body[$field] ?? null;
            if ($value === null || $value === '') {
                $dates[$field] = null;
            } elseif (preg_match('/^\d{4}-\d{2}-\d{2}$/', (string) $value) && strtotime((string) $value)) {
                $dates[$field] = (string) $value;
            } else {
                sendError('Neveljaven datum', 422);
            }
        }

        $stmt = $db->prepare(
            'INSERT INTO stocks_dividends (instrument_id, ex_date, pay_date, amount, note, created_by)
             VALUES (?, ?, ?, ?, ?, ?)'
        );
        $stmt->execute([$instrumentId, $dates['ex_date'], $dates['pay_date'], $amount,
            $note !== '' ? $note : null, userId()]);

        $get = Database::read()->prepare(
            'SELECT d.id, d.instrument_id, i.symbol, d.ex_date, d.pay_date, d.amount, d.note
             FROM stocks_dividends d JOIN stocks_instruments i ON i.id = d.instrument_id
             WHERE d.id = ?'
        );
        $get->execute([(int) $db->lastInsertId()]);
        $row = $get->fetch();
        $row['id'] = (int) $row['id'];
        $row['instrument_id'] = (int) $row['instrument_id'];
        $row['amount'] = (float) $row['amount'];
        sendJson($row, 201);

    } elseif ($method === 'DELETE') {
        if (!$id) sendError('id required', 400);
        $stmt = $db->prepare('DELETE FROM stocks_dividends WHERE id = ?');
        $stmt->execute([$id]);
        if ($stmt->rowCount() === 0) sendError('Dividenda ne obstaja', 404);
        sendJson(['ok' => true]);

    } else {
        sendError('Method not allowed', 405);
    }
}
