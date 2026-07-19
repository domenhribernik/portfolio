<?php
declare(strict_types=1);

// Cron entry point for the LJSE tracker (views/stocks). Replaces the old
// Yahoo-based check_stocks.py: fetches the LJSE price list into the DB and
// sends the Telegram alert digest via app/services/stocks-sync-service.php.
//
// Usage:
//   php app/scripts/stocks-sync.php                 one sync pass + alerts
//   php app/scripts/stocks-sync.php --backfill=365  seed daily history for
//                                                   every instrument (run once
//                                                   after applying the model)
//
// Cron (LJSE trades roughly 9:15-14:00 CET on weekdays):
//   */15 9-14 * * 1-5  php /path/to/app/scripts/stocks-sync.php >> /tmp/stocks-sync.log 2>&1
//
// DB credentials and TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID come from app/.env
// exactly like the web controllers (loaded by app/config/database.php).

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit('CLI only');
}

define('SECURE_ACCESS', true);
require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../services/stocks-sync-service.php';

$options = getopt('', ['backfill::']);
$db = Database::write();

if (array_key_exists('backfill', $options)) {
    $days = max(1, (int) ($options['backfill'] ?: 365));
    $from = date('Y-m-d', strtotime("-$days days"));
    $to = date('Y-m-d');

    $instruments = $db->query(
        'SELECT id, symbol FROM stocks_instruments WHERE is_active = 1 ORDER BY symbol'
    )->fetchAll(PDO::FETCH_ASSOC);

    $total = 0;
    foreach ($instruments as $instrument) {
        $stored = StocksSync::backfillInstrument($db, (int) $instrument['id'], $from, $to);
        printf("%-6s %d days\n", $instrument['symbol'], $stored);
        $total += $stored;
        usleep(300_000); // be polite to the exchange
    }
    echo "backfill done: $total rows over $days days\n";
    exit(0);
}

$result = StocksSync::run($db);
if (isset($result['error'])) {
    fwrite(STDERR, 'sync failed: ' . $result['error'] . "\n");
    exit(1);
}
printf(
    "synced %s: %d quotes, %d alerts fired\n",
    $result['marketDate'] ?? '?',
    $result['prices'] ?? 0,
    $result['alertsFired'] ?? 0
);
