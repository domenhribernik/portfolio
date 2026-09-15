<?php
declare(strict_types=1);

/**
 * CLI entry for the views/tanken price rotation.
 *
 * Production has no cron (PRODUCT.md), so nothing depends on this running:
 * the rotation advances on the page load path through Tanken::runIfDue().
 * This exists so the same engine can be driven by hand for debugging, and so
 * that if the host ever grows a scheduler it is one crontab line rather than
 * a rewrite.
 *
 * Cron, if it ever exists (the lease enforces the real limit regardless):
 *   * * * * * /usr/bin/php /path/to/app/scripts/tanken-poll.php >> /tmp/tanken.log 2>&1
 *
 * Note there would be no point running it more often than once a minute: the
 * lease in tanken_poll_state would refuse the call anyway.
 *
 * Flags:
 *   --ticks=N   make up to N passes, sleeping 60s between them (default 1).
 *               Each pass refreshes at most 10 stations.
 *
 * Exit codes: 0 polled or politely declined, 1 the API or the DB failed.
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit('CLI only');
}

define('SECURE_ACCESS', true);
require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../services/tanken-service.php';

$opts = getopt('', ['ticks::']);
$ticks = max(1, (int) ($opts['ticks'] ?? 1));

try {
    $db = Database::write();
} catch (Throwable $e) {
    fwrite(STDERR, 'tanken-poll: database unavailable: ' . $e->getMessage() . PHP_EOL);
    exit(1);
}

$failed = false;
for ($i = 0; $i < $ticks; $i++) {
    if ($i > 0) sleep(Tanken::MIN_CALL_INTERVAL);

    $result = Tanken::tick($db);
    $stamp = date('c');

    if (isset($result['error'])) {
        fwrite(STDERR, "$stamp  tanken-poll failed: {$result['error']}" . PHP_EOL);
        $failed = true;
        continue;
    }
    if (isset($result['reason'])) {
        echo "$stamp  skipped: {$result['reason']}" . PHP_EOL;
        continue;
    }
    echo "$stamp  polled {$result['polled']} stations" . PHP_EOL;
}

exit($failed ? 1 : 0);
