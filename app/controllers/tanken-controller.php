<?php
declare(strict_types=1);

define('SECURE_ACCESS', true);

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../services/tanken-service.php';

/**
 * Public read endpoint for views/tanken.
 *
 * No auth gate: fuel prices are open data and the page is open to everyone.
 * No Access-Control-Allow-Origin either, because every consumer is
 * same-origin and a wildcard buys nothing.
 *
 * GET ?action=stations&lat=&lng=&rad=
 *   Every tracked station within the radius, nearest first, each with its
 *   cached prices and the timestamp they were observed at. The client sorts
 *   by price; the server never truncates, never drops a closed station and
 *   never filters by brand, because MTS-K's terms forbid narrowing results in
 *   ways the user did not ask for.
 *
 * The response is served from tanken_current_prices alone. Whether this
 * request also triggered an outbound API call is decided by the lease in
 * Tanken, not by the visitor, so page load and refresh rate are unrelated.
 */

// XAMPP ships serialize_precision=100, which renders 1.509 as fifty digits of
// binary noise. Prices are the bulk of this payload, so pin the shortest
// round-trip representation (PHP's own modern default) rather than inherit
// whatever the host is configured with.
ini_set('serialize_precision', '-1');

header('Content-Type: application/json; charset=utf-8');
// Short shared cache: the underlying data cannot change faster than the poll
// interval anyway, and it blunts a reload-happy client.
header('Cache-Control: public, max-age=30');

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
    http_response_code(204);
    exit;
}
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
    sendError('Only GET is supported', 405);
}

try {
    $action = $_GET['action'] ?? 'stations';
    if ($action !== 'stations') {
        sendError('Unknown action', 404);
    }

    if (!isset($_GET['lat'], $_GET['lng']) || !is_numeric($_GET['lat']) || !is_numeric($_GET['lng'])) {
        sendError('lat and lng are required', 422);
    }
    $lat = (float) $_GET['lat'];
    $lng = (float) $_GET['lng'];

    if (!Tanken::inGermany($lat, $lng)) {
        // Not an error the user can fix by retrying, and it must not cost an
        // API call: the data covers Germany and nowhere else.
        sendJson([
            'stations' => [],
            'outsideCoverage' => true,
            'attribution' => attribution(),
        ]);
    }

    // The 25 km ceiling is the API's, and clamping here means no query string
    // can ask for more than the licence allows.
    $rad = Tanken::clampRadius(isset($_GET['rad']) && is_numeric($_GET['rad']) ? (float) $_GET['rad'] : 5.0);

    $write = Database::write();

    // Make sure we know this area. At most one list.php call, behind the lease.
    $discovery = Tanken::discover($write, $lat, $lng, $rad);

    // Housekeeping rides the poll path: there is no cron on the host, so the
    // rotation advances here. The lease means this is usually a no-op.
    //
    // This runs BEFORE the read, not after: the request that wins the lease
    // and pays for the API call should be the one that sees the result. With
    // it the other way round the fresh prices land in the database just after
    // this response was built from the old ones.
    $poll = Tanken::runIfDue($write);

    $stations = Tanken::stationsNear(Database::read(), $lat, $lng, $rad);

    $state = Tanken::pollState($write);

    sendJson([
        'stations' => $stations,
        'radius' => $rad,
        'lastOkAt' => $state['last_ok_at'] === null ? null : str_replace(' ', 'T', (string) $state['last_ok_at']),
        // Surfaced so the page can say "prices may be stale" honestly rather
        // than silently showing old numbers as though they were fresh.
        'degraded' => $state['last_error'] !== null || isset($discovery['error']) || isset($poll['error']),
        'attribution' => attribution(),
    ]);
} catch (Throwable $e) {
    error_log('tanken-controller: ' . $e->getMessage());
    sendError('Something went wrong', 500);
}

/** CC BY 4.0 requires the credit to travel with the data, so it ships in the
 *  payload as well as being printed on the page. */
function attribution(): array
{
    return [
        'text' => 'Prices: MTS-K via Tankerkönig, CC BY 4.0',
        'url' => 'https://www.tankerkoenig.de',
        'licence' => 'CC BY 4.0',
    ];
}

function sendJson(array $payload, int $status = 200): void
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function sendError(string $message, int $status): void
{
    sendJson(['error' => $message], $status);
}
