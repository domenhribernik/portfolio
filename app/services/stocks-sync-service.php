<?php
declare(strict_types=1);

if (!defined('SECURE_ACCESS')) {
    header('HTTP/1.0 403 Forbidden');
    exit('Access denied.');
}

/**
 * LJSE market sync + Telegram alert engine for views/stocks.
 *
 * Pulls the daily price list from the Ljubljana Stock Exchange (the same
 * public JSON the ljse.si tečajnica page reads), upserts instruments and
 * daily OHLC rows, evaluates the users' alert rules and sends the site
 * owner a Telegram digest. Called two ways:
 *   - app/scripts/stocks-sync.php (cron, every 15 min on trading days)
 *   - POST ?action=refresh on stocks-controller.php (page-load freshness),
 *     which goes through runIfStale() so a busy page can't hammer LJSE.
 *
 * Env seams (all optional, with production defaults):
 *   LJSE_BASE_URL       default https://ljse.si     (tests: local stub)
 *   TELEGRAM_API_BASE   default https://api.telegram.org
 *   TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID   from app/.env, as contact.php
 *   STOCKS_SYNC_TTL     staleness window in seconds, default 900
 */
class StocksSync
{
    // Segments the tracker follows: A Prva kotacija, B Standardna, E ETF.
    private const SEGMENTS = ['A', 'B', 'E'];
    private const SYNC_FILE = __DIR__ . '/../cache/stocks-sync.json';
    private const DEFAULT_TTL = 900;

    /**
     * One full sync pass. Returns a summary array; network trouble comes
     * back as ['error' => ...] instead of an exception so cron logs stay
     * one line and the controller can pass it through.
     */
    public static function run(PDO $db): array
    {
        $payload = self::fetchJson('/json/TradingPriceList?lng=si&market_segment_ids=' .
            implode(',', self::SEGMENTS) . '&type=ALL&only_traded=0');
        if ($payload === null || !isset($payload['priceList'])) {
            return ['error' => 'LJSE unreachable or returned an unexpected payload'];
        }

        $marketDate = null;
        $stored = 0;

        foreach ($payload['priceList'] as $segmentBlock) {
            $segment = (string) ($segmentBlock['market_segment_id'] ?? '');
            if (!in_array($segment, self::SEGMENTS, true)) continue;

            foreach ($segmentBlock['tradingPriceList']['rows'] ?? [] as $row) {
                $last = $row['last_price_n'] ?? null;
                if ($last === null) continue; // pending day, nothing traded yet

                $date = substr((string) ($row['date'] ?? ''), 0, 10);
                if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) continue;
                $marketDate = $marketDate === null ? $date : max($marketDate, $date);

                $instrumentId = self::ensureInstrument($db, $row, $segment);
                self::upsertPrice($db, $instrumentId, $date, $row);
                $stored++;
            }
        }

        $alertsFired = 0;
        if ($marketDate !== null) {
            $alertsFired = self::processAlerts($db, $marketDate);
        }

        $summary = [
            'refreshed' => true,
            'syncedAt' => date('c'),
            'marketDate' => $marketDate,
            'prices' => $stored,
            'alertsFired' => $alertsFired,
        ];
        @file_put_contents(self::SYNC_FILE, json_encode($summary));
        @chmod(self::SYNC_FILE, 0666);
        return $summary;
    }

    /** run(), but only when the last sync is older than STOCKS_SYNC_TTL. */
    public static function runIfStale(PDO $db): array
    {
        $ttl = (int) (self::env('STOCKS_SYNC_TTL') ?: self::DEFAULT_TTL);
        if (file_exists(self::SYNC_FILE)) {
            $state = json_decode((string) file_get_contents(self::SYNC_FILE), true);
            $syncedAt = is_array($state) ? strtotime((string) ($state['syncedAt'] ?? '')) : false;
            if ($syncedAt !== false && time() - $syncedAt < $ttl) {
                return ['refreshed' => false] + (is_array($state) ? $state : []);
            }
        }
        return self::run($db);
    }

    /**
     * Pull one instrument's daily history from the exchange (used to seed a
     * year of charts on first run). Returns how many days were stored.
     */
    public static function backfillInstrument(PDO $db, int $instrumentId, string $from, string $to): int
    {
        $stmt = $db->prepare('SELECT isin FROM stocks_instruments WHERE id = ?');
        $stmt->execute([$instrumentId]);
        $isin = $stmt->fetchColumn();
        if ($isin === false) return 0;

        $payload = self::fetchJson("/json/securityHistory/$isin/$from/$to/si");
        if ($payload === null) return 0;

        $stored = 0;
        foreach ($payload['rows'] ?? [] as $row) {
            $last = $row['last_price_n'] ?? null;
            $date = (string) ($row['date_yyyy_MM_dd'] ?? '');
            if ($last === null || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) continue;
            self::upsertPrice($db, $instrumentId, $date, $row);
            $stored++;
        }
        return $stored;
    }

    // ------------------------------------------------------------------
    //  Storage
    // ------------------------------------------------------------------

    /** Find the instrument by ISIN/symbol, inserting new listings on sight. */
    private static function ensureInstrument(PDO $db, array $row, string $segment): int
    {
        $isin = (string) ($row['isin'] ?? '');
        $symbol = (string) ($row['symbol'] ?? '');

        $stmt = $db->prepare('SELECT id FROM stocks_instruments WHERE isin = ? OR symbol = ?');
        $stmt->execute([$isin, $symbol]);
        $id = $stmt->fetchColumn();
        if ($id !== false) return (int) $id;

        // A listing we have never seen: store it under its symbol until a
        // human gives it a proper display name in the DB.
        $ins = $db->prepare(
            'INSERT INTO stocks_instruments (symbol, isin, name, segment, security_type)
             VALUES (?, ?, ?, ?, ?)'
        );
        $ins->execute([$symbol, $isin, $symbol, $segment, $segment === 'E' ? 'etf' : 'share']);
        return (int) $db->lastInsertId();
    }

    private static function upsertPrice(PDO $db, int $instrumentId, string $date, array $row): void
    {
        $stmt = $db->prepare(
            'INSERT INTO stocks_prices
                (instrument_id, trade_date, open_price, high_price, low_price, last_price, volume, turnover)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                open_price = VALUES(open_price), high_price = VALUES(high_price),
                low_price = VALUES(low_price), last_price = VALUES(last_price),
                volume = VALUES(volume), turnover = VALUES(turnover)'
        );
        $stmt->execute([
            $instrumentId,
            $date,
            $row['open_price_n'] ?? null,
            $row['high_price_n'] ?? null,
            $row['low_price_n'] ?? null,
            $row['last_price_n'],
            $row['volume_n'] ?? null,
            $row['turnover_n'] ?? null,
        ]);
    }

    // ------------------------------------------------------------------
    //  Alerts
    // ------------------------------------------------------------------

    /**
     * Evaluate every active rule against the freshly stored day and send one
     * Telegram digest for everything that fired. last_fired_date throttles
     * each rule to a single message per market day. Mirrors evaluateAlerts()
     * in views/stocks/logic.js.
     */
    private static function processAlerts(PDO $db, string $marketDate): int
    {
        $quotes = self::dayQuotes($db, $marketDate);
        if (!$quotes) return 0;

        $alerts = $db->query(
            'SELECT id, instrument_id, kind, threshold, last_fired_date FROM stocks_alerts WHERE active = 1'
        )->fetchAll(PDO::FETCH_ASSOC);

        $lines = [];
        $firedIds = [];
        foreach ($alerts as $alert) {
            if (($alert['last_fired_date'] ?? null) === $marketDate) continue;

            $instrumentId = $alert['instrument_id'] === null ? null : (int) $alert['instrument_id'];
            $ruleFired = false;
            foreach ($quotes as $quote) {
                if ($instrumentId !== null && $instrumentId !== $quote['instrument_id']) continue;

                $line = self::alertLine((string) $alert['kind'], (float) $alert['threshold'], $quote);
                if ($line !== null) {
                    $lines[] = $line;
                    $ruleFired = true;
                    // A board-wide rule keeps scanning so every mover is listed;
                    // an instrument rule is done after its own quote.
                    if ($instrumentId !== null) break;
                }
            }
            if ($ruleFired) $firedIds[] = (int) $alert['id'];
        }

        if (!$firedIds) return 0;

        $dateSl = sprintf('%d. %d. %d', ...array_reverse(array_map('intval', explode('-', $marketDate))));
        $text = "<b>📈 Borzna opozorila · $dateSl</b>\n" . implode("\n", array_unique($lines));
        self::sendTelegram($text);

        $stamp = $db->prepare(
            'UPDATE stocks_alerts SET last_fired_date = ? WHERE id IN (' .
            implode(',', array_fill(0, count($firedIds), '?')) . ')'
        );
        $stamp->execute([$marketDate, ...$firedIds]);
        return count($firedIds);
    }

    /** The market day's quotes with the prior close for move rules. */
    private static function dayQuotes(PDO $db, string $marketDate): array
    {
        $rows = $db->prepare(
            'SELECT p.instrument_id, i.symbol, p.last_price,
                    (SELECT p2.last_price FROM stocks_prices p2
                     WHERE p2.instrument_id = p.instrument_id AND p2.trade_date < p.trade_date
                     ORDER BY p2.trade_date DESC LIMIT 1) AS prev_close
             FROM stocks_prices p
             JOIN stocks_instruments i ON i.id = p.instrument_id
             WHERE p.trade_date = ?'
        );
        $rows->execute([$marketDate]);
        return array_map(fn ($r) => [
            'instrument_id' => (int) $r['instrument_id'],
            'symbol' => (string) $r['symbol'],
            'last' => (float) $r['last_price'],
            'prevClose' => $r['prev_close'] === null ? null : (float) $r['prev_close'],
        ], $rows->fetchAll(PDO::FETCH_ASSOC));
    }

    /** One Slovenian digest line when the rule fires, null when it doesn't. */
    private static function alertLine(string $kind, float $threshold, array $quote): ?string
    {
        $eur = fn (float $v) => number_format($v, 2, ',', '.') . ' €';
        $sym = '<code>' . $quote['symbol'] . '</code>';

        if ($kind === 'above' && $quote['last'] >= $threshold) {
            return "$sym {$eur($quote['last'])} · nad pragom {$eur($threshold)}";
        }
        if ($kind === 'below' && $quote['last'] <= $threshold) {
            return "$sym {$eur($quote['last'])} · pod pragom {$eur($threshold)}";
        }
        if ($kind === 'move' && $quote['prevClose']) {
            $pct = ($quote['last'] - $quote['prevClose']) / $quote['prevClose'] * 100;
            if (abs($pct) >= $threshold) {
                $signed = ($pct > 0 ? '+' : '') . number_format($pct, 2, ',', '.') . ' %';
                return "$sym $signed · dnevni premik čez " . number_format($threshold, 1, ',', '.') . ' %';
            }
        }
        return null;
    }

    // ------------------------------------------------------------------
    //  Plumbing
    // ------------------------------------------------------------------

    private static function env(string $key): string
    {
        $value = $_ENV[$key] ?? getenv($key);
        return is_string($value) ? $value : '';
    }

    /** GET a JSON document from the exchange; null on any failure. */
    private static function fetchJson(string $path): ?array
    {
        $base = rtrim(self::env('LJSE_BASE_URL') ?: 'https://ljse.si', '/');
        $ctx = stream_context_create(['http' => [
            'timeout' => 20,
            'ignore_errors' => true,
            'header' => "User-Agent: domenhribernik.com portfolio tracker\r\nAccept: application/json\r\n",
        ]]);
        $raw = @file_get_contents($base . $path, false, $ctx);
        if ($raw === false) return null;
        $status = 0;
        foreach ($http_response_header ?? [] as $h) {
            if (preg_match('#^HTTP/\S+\s+(\d{3})#', $h, $m)) $status = (int) $m[1];
        }
        if ($status >= 400) return null;
        $data = json_decode($raw, true);
        return is_array($data) ? $data : null;
    }

    /** Best-effort Telegram send, same contract as contact.php's notifyOwner. */
    private static function sendTelegram(string $text): bool
    {
        $token = self::env('TELEGRAM_BOT_TOKEN');
        $chatId = self::env('TELEGRAM_CHAT_ID');
        if ($token === '' || $chatId === '') return false;

        $base = rtrim(self::env('TELEGRAM_API_BASE') ?: 'https://api.telegram.org', '/');
        $ch = curl_init("$base/bot$token/sendMessage");
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 5,
            CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
            CURLOPT_POSTFIELDS => json_encode([
                'chat_id' => $chatId,
                'text' => $text,
                'parse_mode' => 'HTML',
                'disable_web_page_preview' => true,
            ]),
        ]);
        $ok = curl_exec($ch) !== false && curl_getinfo($ch, CURLINFO_HTTP_CODE) === 200;
        curl_close($ch);
        return $ok;
    }
}
