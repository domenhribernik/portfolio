<?php
declare(strict_types=1);

/**
 * A fake Tankerkoenig for tests/tanken-controller.test.php.
 *
 * Runs as the router script of its own built-in server, so every path lands
 * here and TANKERKOENIG_BASE_URL can point the service at it. Two jobs:
 *
 *  1. Answer /json/list.php and /json/prices.php from a scenario file the
 *     suite writes, so an ok:false or an outage is one line of test setup.
 *  2. Log every request it receives as a JSON line, which is how "the API was
 *     called exactly once" becomes an assertion instead of a hope.
 *
 * A missing scenario file doubles as the service-down case.
 *
 * Env: TANKEN_STUB_SCENARIO (path), TANKEN_STUB_LOG (path).
 */

$scenarioPath = getenv('TANKEN_STUB_SCENARIO') ?: '';
$logPath = getenv('TANKEN_STUB_LOG') ?: '';

$uri = $_SERVER['REQUEST_URI'] ?? '';
$path = parse_url($uri, PHP_URL_PATH) ?: '';
parse_str((string) parse_url($uri, PHP_URL_QUERY), $query);

if ($logPath !== '') {
    // The key is logged deliberately: one of the suite's assertions is that it
    // reached the API and did NOT reach the browser.
    @file_put_contents($logPath, json_encode([
        'at' => microtime(true),
        'path' => $path,
        'query' => $query,
    ]) . "\n", FILE_APPEND | LOCK_EX);
}

header('Content-Type: application/json');

if ($scenarioPath === '' || !is_file($scenarioPath)) {
    http_response_code(500);
    echo json_encode(['ok' => false, 'message' => 'stub has no scenario']);
    exit;
}

$scenario = json_decode((string) file_get_contents($scenarioPath), true);
if (!is_array($scenario)) {
    http_response_code(500);
    echo json_encode(['ok' => false, 'message' => 'unreadable scenario']);
    exit;
}

if (!empty($scenario['fail'])) {
    http_response_code((int) ($scenario['status'] ?? 503));
    echo json_encode(['ok' => false, 'message' => $scenario['message'] ?? 'service unavailable']);
    exit;
}

$stations = $scenario['stations'] ?? [];

if (str_contains($path, 'list.php')) {
    echo json_encode([
        'ok' => true,
        'license' => 'CC BY 4.0',
        'data' => 'MTS-K',
        'status' => 'ok',
        'stations' => $stations,
    ]);
    exit;
}

if (str_contains($path, 'prices.php')) {
    $ids = array_filter(explode(',', (string) ($query['ids'] ?? '')));
    $prices = [];
    foreach ($stations as $station) {
        if (!in_array($station['id'], $ids, true)) continue;
        $entry = ['status' => !empty($station['isOpen']) ? 'open' : 'closed'];
        foreach (['e5', 'e10', 'diesel'] as $fuel) {
            // The real API omits prices entirely for a closed station and
            // sends `false` for a fuel a station does not sell.
            $entry[$fuel] = $entry['status'] === 'closed'
                ? false
                : ($station[$fuel] ?? false);
        }
        if (($station['noPrices'] ?? false) === true) {
            $entry = ['status' => 'no prices'];
        }
        $prices[$station['id']] = $entry;
    }
    echo json_encode(['ok' => true, 'license' => 'CC BY 4.0', 'data' => 'MTS-K', 'prices' => $prices]);
    exit;
}

http_response_code(404);
echo json_encode(['ok' => false, 'message' => 'no such endpoint']);
