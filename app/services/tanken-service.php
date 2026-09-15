<?php
declare(strict_types=1);

if (!defined('SECURE_ACCESS')) {
    header('HTTP/1.0 403 Forbidden');
    exit('Access denied.');
}

/**
 * Tankerkoenig poller for views/tanken: the only code in this repo that talks
 * to the fuel price API.
 *
 * The frontend never calls Tankerkoenig. It reads tanken_current_prices, which
 * this service fills. Two entry points, both going through the same lease:
 *   - tanken-controller.php on a page load (production has no cron, so the
 *     poll rides the request path the way the rest of the site's housekeeping
 *     does; see PRODUCT.md)
 *   - app/scripts/tanken-poll.php from the CLI, if a scheduler ever exists
 *
 * THE LEASE IS THE POINT. The free tier allows one request per minute and
 * revokes keys that harvest, so every outbound call must first win the
 * conditional UPDATE in claimLease(). A thousand simultaneous visitors
 * therefore produce at most one request: InnoDB's row lock decides who goes,
 * and everybody else reads the cache. There is no code path that calls the
 * API without a lease.
 *
 * Nothing here throws. Network trouble comes back as ['error' => ...] so a
 * failed poll is one line in a log and the controller can pass it through
 * while still serving the last known prices.
 *
 * Env seams (all optional, with production defaults):
 *   TANKERKOENIG_API_KEY      required in production; absent = no calls made
 *   TANKERKOENIG_BASE_URL     default https://creativecommons.tankerkoenig.de
 *   TANKEN_POLL_INTERVAL      seconds between API calls, default 60, floor 60
 *   TANKEN_POOL_CAP           stations kept in rotation, default 100
 *   TANKEN_TRACK_TTL_HOURS    how long a looked-up station stays tracked, default 24
 *   TANKEN_DISCOVER_TTL       seconds before a location is re-discovered, default 1800
 */
class Tanken
{
    /** Tankerkoenig's own ceilings. Mirrored in views/tanken/logic.js and
     *  pinned there by tests/tanken-logic.test.mjs, so change both together. */
    public const MAX_RADIUS_KM = 25;
    public const MAX_IDS_PER_REQUEST = 10;
    public const MIN_CALL_INTERVAL = 60;

    /** Germany's bounding box, generously rounded. Coordinates outside it are
     *  a bug or a probe, never a fuel stop, and must not cost an API call. */
    public const DE_BBOX = ['minLat' => 47.0, 'maxLat' => 55.2, 'minLng' => 5.7, 'maxLng' => 15.2];

    private const DEFAULT_POOL_CAP = 100;
    private const DEFAULT_TRACK_TTL_HOURS = 24;
    private const DEFAULT_DISCOVER_TTL = 1800;
    /** A day of uninterrupted once-a-minute polling. Nothing legitimate can
     *  exceed it, so crossing it means the lease is broken: stop calling. */
    private const MAX_CALLS_PER_DAY = 1440;

    private const FUELS = ['e5', 'e10', 'diesel'];

    // -----------------------------------------------------------------
    //  The lease
    // -----------------------------------------------------------------

    /**
     * Try to win the right to make one outbound API call.
     *
     * The whole rate limit lives in this single UPDATE. It succeeds only if
     * the last call is at least MIN_CALL_INTERVAL old AND no other request is
     * mid-flight, and it stamps last_call_at in the same statement, so two
     * concurrent callers cannot both read "it has been 61 seconds" and both
     * go. rowCount() === 1 means this process owns the call.
     */
    public static function claimLease(PDO $db): bool
    {
        $interval = max(self::MIN_CALL_INTERVAL, (int) (self::env('TANKEN_POLL_INTERVAL') ?: self::MIN_CALL_INTERVAL));

        // Reset the daily counter on the first call of a new day.
        $db->exec('UPDATE tanken_poll_state SET calls_today = 0, call_day = CURDATE()
                    WHERE id = 1 AND (call_day IS NULL OR call_day <> CURDATE())');

        $stmt = $db->prepare(
            'UPDATE tanken_poll_state
                SET last_call_at = NOW(),
                    leased_until = DATE_ADD(NOW(), INTERVAL 30 SECOND),
                    calls_today  = calls_today + 1
              WHERE id = 1
                AND last_call_at <= DATE_SUB(NOW(), INTERVAL ' . $interval . ' SECOND)
                AND leased_until <= NOW()
                AND calls_today  < ' . self::MAX_CALLS_PER_DAY
        );
        $stmt->execute();
        return $stmt->rowCount() === 1;
    }

    /** Release the in-flight half of the lease early, so a fast call does not
     *  hold the next 30 seconds hostage. last_call_at still gates the minute. */
    private static function endLease(PDO $db, ?string $error): void
    {
        $stmt = $db->prepare(
            'UPDATE tanken_poll_state
                SET leased_until = NOW(),
                    last_ok_at   = CASE WHEN :err IS NULL THEN NOW() ELSE last_ok_at END,
                    last_error   = :err2
              WHERE id = 1'
        );
        $stmt->execute([':err' => $error, ':err2' => $error === null ? null : mb_substr($error, 0, 255)]);
    }

    public static function pollState(PDO $db): array
    {
        $row = $db->query('SELECT last_ok_at, last_error FROM tanken_poll_state WHERE id = 1')->fetch();
        return is_array($row) ? $row : ['last_ok_at' => null, 'last_error' => null];
    }

    // -----------------------------------------------------------------
    //  Path 1a: discovery (list.php)
    // -----------------------------------------------------------------

    /**
     * Make sure we know the stations around a point, calling list.php at most
     * once per lease. list.php returns current prices as well as the station
     * list, so a location nobody has ever asked about is fully rendered from
     * this single request.
     *
     * Station selection is entirely the user's: we ask for every station in
     * the radius they chose with type=all and keep all of them. There is no
     * favourite list anywhere in this codebase, and MTS-K's terms forbid
     * filtering results the user did not ask for.
     */
    public static function discover(PDO $db, float $lat, float $lng, float $rad): array
    {
        $rad = self::clampRadius($rad);

        if (self::hasRecentCoverage($db, $lat, $lng, $rad)) {
            self::touchNearby($db, $lat, $lng, $rad);
            return ['discovered' => false, 'reason' => 'cached'];
        }

        $key = self::env('TANKERKOENIG_API_KEY');
        if ($key === '') {
            return ['discovered' => false, 'error' => 'No API key configured'];
        }
        if (!self::claimLease($db)) {
            // Somebody else is inside the minute. Serve what we have; the page
            // retries and the next request that arrives after the minute wins.
            return ['discovered' => false, 'reason' => 'rate-limited'];
        }

        $payload = self::fetchJson('/json/list.php?' . http_build_query([
            'lat' => $lat, 'lng' => $lng, 'rad' => $rad, 'sort' => 'dist', 'type' => 'all', 'apikey' => $key,
        ]));

        if ($payload === null || empty($payload['ok']) || !isset($payload['stations'])) {
            $message = is_array($payload) && isset($payload['message'])
                ? 'Tankerkoenig: ' . (string) $payload['message']
                : 'Tankerkoenig unreachable or returned an unexpected payload';
            self::endLease($db, $message);
            return ['discovered' => false, 'error' => $message];
        }

        $observedAt = date('Y-m-d H:i:s');
        $stored = 0;
        foreach ($payload['stations'] as $station) {
            $uuid = (string) ($station['id'] ?? '');
            // A station id that is not a 36 character UUID cannot be passed to
            // prices.php and would not fit the column. Skipping it costs one
            // station; letting it through would throw and cost the whole page.
            // This is rejecting malformed input, not filtering someone's
            // results, so it does not touch the no-filtering rule.
            if (!self::isUuid($uuid)) continue;
            self::upsertStation($db, $station);
            // list.php reports open/closed as a boolean rather than a status
            // string, so normalise it onto the same vocabulary prices.php uses.
            $status = !empty($station['isOpen']) ? 'open' : 'closed';
            foreach (self::FUELS as $fuel) {
                self::upsertPrice($db, $uuid, $fuel, $station[$fuel] ?? null, $status, $observedAt);
            }
            $stored++;
        }
        self::markPolled($db, array_map(static fn($s) => (string) ($s['id'] ?? ''), $payload['stations']));
        self::endLease($db, null);

        return ['discovered' => true, 'stations' => $stored];
    }

    // -----------------------------------------------------------------
    //  Path 1b: the rotation (prices.php)
    // -----------------------------------------------------------------

    /**
     * Refresh the ten stalest tracked stations with one prices.php call.
     *
     * Ten is the API's hard ceiling on `ids`, and one call per minute is the
     * quota, so a pool at TANKEN_POOL_CAP (100) comes fully round in about ten
     * minutes. That ratio is why the cap exists: raise it and prices get older,
     * not more numerous.
     */
    public static function tick(PDO $db): array
    {
        $key = self::env('TANKERKOENIG_API_KEY');
        if ($key === '') return ['polled' => 0, 'error' => 'No API key configured'];

        $ids = self::rotationBatch($db);
        if (!$ids) return ['polled' => 0, 'reason' => 'nothing tracked'];

        if (!self::claimLease($db)) return ['polled' => 0, 'reason' => 'rate-limited'];

        $payload = self::fetchJson('/json/prices.php?' . http_build_query([
            'ids' => implode(',', $ids), 'apikey' => $key,
        ]));

        if ($payload === null || empty($payload['ok']) || !isset($payload['prices'])) {
            $message = is_array($payload) && isset($payload['message'])
                ? 'Tankerkoenig: ' . (string) $payload['message']
                : 'Tankerkoenig unreachable or returned an unexpected payload';
            self::endLease($db, $message);
            // Deliberately do not touch tanken_current_prices: the page keeps
            // serving the last values with their real observed_at, which is a
            // better answer than an empty list.
            return ['polled' => 0, 'error' => $message];
        }

        $observedAt = date('Y-m-d H:i:s');
        $polled = 0;
        foreach ($payload['prices'] as $uuid => $entry) {
            if (!is_array($entry) || !self::isUuid((string) $uuid)) continue;
            $status = (string) ($entry['status'] ?? 'no prices');
            if (!in_array($status, ['open', 'closed', 'no prices'], true)) $status = 'no prices';
            foreach (self::FUELS as $fuel) {
                // A closed station reports no prices at all. Keep whatever we
                // last knew and just move the status, so the row shows a greyed
                // figure with an honest timestamp rather than going blank.
                $value = $entry[$fuel] ?? null;
                if ($status === 'closed' && ($value === null || $value === false)) {
                    self::touchStatus($db, (string) $uuid, $fuel, $status, $observedAt);
                    continue;
                }
                self::upsertPrice($db, (string) $uuid, $fuel, $value, $status, $observedAt);
            }
            $polled++;
        }
        // Stamp every id we asked about, not just the ones that answered, or a
        // station the API keeps omitting would jam at the head of the rotation.
        self::markPolled($db, $ids);
        self::endLease($db, null);

        return ['polled' => $polled];
    }

    /** tick(), but silent about being too early. The controller's entry point. */
    public static function runIfDue(PDO $db): array
    {
        try {
            return self::tick($db);
        } catch (Throwable $e) {
            // Housekeeping must never be able to fail a page load.
            error_log('Tanken poll failed: ' . $e->getMessage());
            return ['polled' => 0, 'error' => 'poll failed'];
        }
    }

    // -----------------------------------------------------------------
    //  Reads
    // -----------------------------------------------------------------

    /**
     * Every tracked station within `rad` km of the point, with its cached
     * prices. Sorting and formatting belong to the page; this returns the
     * complete set, unfiltered and untruncated.
     */
    public static function stationsNear(PDO $db, float $lat, float $lng, float $rad): array
    {
        $rad = self::clampRadius($rad);
        $rows = self::nearbyRows($db, $lat, $lng, $rad);
        if (!$rows) return [];

        $prices = self::pricesFor($db, array_column($rows, 'uuid'));

        $out = [];
        foreach ($rows as $row) {
            $out[] = [
                'id' => $row['uuid'],
                'name' => $row['name'],
                'brand' => $row['brand'],
                'street' => $row['street'],
                'houseNumber' => $row['house_number'],
                'postCode' => $row['post_code'],
                'place' => $row['place'],
                'lat' => (float) $row['lat'],
                'lng' => (float) $row['lng'],
                'dist' => round($row['_dist'], 2),
                'prices' => $prices[$row['uuid']] ?? new stdClass(),
            ];
        }
        return $out;
    }

    /** Cached prices for a set of stations, in one query. */
    private static function pricesFor(PDO $db, array $uuids): array
    {
        if (!$uuids) return [];
        $in = implode(',', array_fill(0, count($uuids), '?'));
        $stmt = $db->prepare("SELECT station_uuid, fuel, price, status, observed_at
                                FROM tanken_current_prices WHERE station_uuid IN ($in)");
        $stmt->execute(array_values($uuids));

        $out = [];
        foreach ($stmt->fetchAll() as $row) {
            $out[$row['station_uuid']][$row['fuel']] = [
                'price' => $row['price'] === null ? null : (float) $row['price'],
                'status' => $row['status'],
                'observedAt' => str_replace(' ', 'T', (string) $row['observed_at']),
            ];
        }
        return $out;
    }

    // -----------------------------------------------------------------
    //  Internals
    // -----------------------------------------------------------------

    public static function clampRadius(float $rad): float
    {
        if (!is_finite($rad) || $rad <= 0) return 5.0;
        return min($rad, (float) self::MAX_RADIUS_KM);
    }

    public static function inGermany(float $lat, float $lng): bool
    {
        $b = self::DE_BBOX;
        return $lat >= $b['minLat'] && $lat <= $b['maxLat'] && $lng >= $b['minLng'] && $lng <= $b['maxLng'];
    }

    /** Rows inside the radius, bbox-prefiltered in SQL and then measured
     *  exactly in PHP. No ST_Distance_Sphere: it is MySQL-version sensitive,
     *  and a haversine over a few dozen rows costs nothing. */
    private static function nearbyRows(PDO $db, float $lat, float $lng, float $rad): array
    {
        [$latPad, $lngPad] = self::pads($lat, $rad);
        $stmt = $db->prepare('SELECT uuid, name, brand, street, house_number, post_code, place, lat, lng
                                FROM tanken_stations
                               WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?');
        $stmt->execute([$lat - $latPad, $lat + $latPad, $lng - $lngPad, $lng + $lngPad]);

        $out = [];
        foreach ($stmt->fetchAll() as $row) {
            $d = self::haversineKm($lat, $lng, (float) $row['lat'], (float) $row['lng']);
            if ($d <= $rad) {
                $row['_dist'] = $d;
                $out[] = $row;
            }
        }
        usort($out, static fn($a, $b) => $a['_dist'] <=> $b['_dist']);
        return $out;
    }

    private static function pads(float $lat, float $rad): array
    {
        $latPad = $rad / 110.6 + 0.02;
        $cos = max(0.2, cos(deg2rad($lat)));
        return [$latPad, $rad / (110.6 * $cos) + 0.02];
    }

    private static function haversineKm(float $lat1, float $lng1, float $lat2, float $lng2): float
    {
        $p1 = deg2rad($lat1);
        $p2 = deg2rad($lat2);
        $dp = deg2rad($lat2 - $lat1);
        $dl = deg2rad($lng2 - $lng1);
        $a = sin($dp / 2) ** 2 + cos($p1) * cos($p2) * sin($dl / 2) ** 2;
        return 2 * 6371.0088 * asin(min(1.0, sqrt($a)));
    }

    /** Do we already know this area well enough to skip a list.php call?
     *  Answered from the station rows themselves, so no record of where a
     *  visitor was needs to exist anywhere. */
    private static function hasRecentCoverage(PDO $db, float $lat, float $lng, float $rad): bool
    {
        $ttl = (int) (self::env('TANKEN_DISCOVER_TTL') ?: self::DEFAULT_DISCOVER_TTL);
        [$latPad, $lngPad] = self::pads($lat, $rad);
        $stmt = $db->prepare('SELECT COUNT(*) FROM tanken_stations
                               WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?
                                 AND last_requested_at > DATE_SUB(NOW(), INTERVAL ' . $ttl . ' SECOND)');
        $stmt->execute([$lat - $latPad, $lat + $latPad, $lng - $lngPad, $lng + $lngPad]);
        return ((int) $stmt->fetchColumn()) > 0;
    }

    /** Keep every station the visitor just looked at inside the rotation TTL. */
    private static function touchNearby(PDO $db, float $lat, float $lng, float $rad): void
    {
        [$latPad, $lngPad] = self::pads($lat, $rad);
        $stmt = $db->prepare('UPDATE tanken_stations SET last_requested_at = NOW()
                               WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?');
        $stmt->execute([$lat - $latPad, $lat + $latPad, $lng - $lngPad, $lng + $lngPad]);
    }

    /**
     * The ten stalest stations still inside the tracking TTL, taken from the
     * TANKEN_POOL_CAP most recently wanted. The inner LIMIT is the cap: past
     * it, the least recently looked-at stations simply stop being polled
     * rather than diluting everybody's freshness.
     *
     * The two limits are interpolated because MySQL will not take a bound
     * parameter in LIMIT under native prepares; both are cast to int first.
     */
    private static function rotationBatch(PDO $db): array
    {
        $cap = max(10, (int) (self::env('TANKEN_POOL_CAP') ?: self::DEFAULT_POOL_CAP));
        $ttl = max(1, (int) (self::env('TANKEN_TRACK_TTL_HOURS') ?: self::DEFAULT_TRACK_TTL_HOURS));
        $batch = self::MAX_IDS_PER_REQUEST;

        $sql = 'SELECT uuid FROM (
                    SELECT uuid, last_polled_at FROM tanken_stations
                     WHERE last_requested_at > DATE_SUB(NOW(), INTERVAL ' . $ttl . ' HOUR)
                     ORDER BY last_requested_at DESC
                     LIMIT ' . $cap . '
                ) AS pool
                ORDER BY (last_polled_at IS NULL) DESC, last_polled_at ASC
                LIMIT ' . $batch;
        return array_map('strval', $db->query($sql)->fetchAll(PDO::FETCH_COLUMN));
    }

    private static function markPolled(PDO $db, array $uuids): void
    {
        $uuids = array_values(array_filter($uuids, static fn($u) => $u !== ''));
        if (!$uuids) return;
        $in = implode(',', array_fill(0, count($uuids), '?'));
        $stmt = $db->prepare("UPDATE tanken_stations SET last_polled_at = NOW() WHERE uuid IN ($in)");
        $stmt->execute($uuids);
    }

    private static function upsertStation(PDO $db, array $s): void
    {
        $stmt = $db->prepare(
            'INSERT INTO tanken_stations
                (uuid, name, brand, street, house_number, post_code, place, lat, lng, last_requested_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
             ON DUPLICATE KEY UPDATE
                name = VALUES(name), brand = VALUES(brand), street = VALUES(street),
                house_number = VALUES(house_number), post_code = VALUES(post_code),
                place = VALUES(place), lat = VALUES(lat), lng = VALUES(lng),
                last_requested_at = NOW()'
        );
        $stmt->execute([
            (string) $s['id'],
            mb_substr((string) ($s['name'] ?? ''), 0, 190),
            mb_substr((string) ($s['brand'] ?? ''), 0, 120),
            mb_substr((string) ($s['street'] ?? ''), 0, 190),
            mb_substr((string) ($s['houseNumber'] ?? ''), 0, 40),
            mb_substr((string) ($s['postCode'] ?? ''), 0, 10),
            mb_substr((string) ($s['place'] ?? ''), 0, 120),
            (float) ($s['lat'] ?? 0),
            (float) ($s['lng'] ?? 0),
        ]);
    }

    /** `false` is how the API spells "this station sells no such fuel", which
     *  is a real answer and stored as NULL + 'no prices', not skipped. */
    private static function upsertPrice(PDO $db, string $uuid, string $fuel, $value, string $status, string $observedAt): void
    {
        $price = (is_int($value) || is_float($value)) && $value > 0 ? (float) $value : null;
        if ($price === null && $status === 'open') $status = 'no prices';

        $stmt = $db->prepare(
            'INSERT INTO tanken_current_prices (station_uuid, fuel, price, status, observed_at)
             VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                price = VALUES(price), status = VALUES(status), observed_at = VALUES(observed_at)'
        );
        $stmt->execute([$uuid, $fuel, $price, $status, $observedAt]);
    }

    /** Move a row's status and timestamp while keeping its last known price. */
    private static function touchStatus(PDO $db, string $uuid, string $fuel, string $status, string $observedAt): void
    {
        $stmt = $db->prepare('UPDATE tanken_current_prices SET status = ?, observed_at = ?
                               WHERE station_uuid = ? AND fuel = ?');
        $stmt->execute([$status, $observedAt, $uuid, $fuel]);
    }

    /**
     * GET returning decoded JSON, or null. The API key is in the query string,
     * so nothing here ever logs or returns the URL: an error message names the
     * endpoint at most.
     */
    private static function fetchJson(string $path): ?array
    {
        $base = rtrim(self::env('TANKERKOENIG_BASE_URL') ?: 'https://creativecommons.tankerkoenig.de', '/');
        $ctx = stream_context_create(['http' => [
            'timeout' => 15,
            'ignore_errors' => true,
            'header' => "User-Agent: domenhribernik.com fuel price view\r\nAccept: application/json\r\n",
        ]]);
        $raw = @file_get_contents($base . $path, false, $ctx);
        if ($raw === false) return null;
        $status = 0;
        foreach ($http_response_header ?? [] as $h) {
            if (preg_match('#^HTTP/\S+\s+(\d{3})#', $h, $m)) $status = (int) $m[1];
        }
        $data = json_decode($raw, true);
        if (!is_array($data)) return null;
        // A 4xx still carries {ok:false, message:...}, which is worth reporting.
        if ($status >= 400 && !isset($data['message'])) return null;
        return $data;
    }

    private static function isUuid(string $value): bool
    {
        return (bool) preg_match('/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/', $value);
    }

    private static function env(string $key): string
    {
        $value = $_ENV[$key] ?? getenv($key);
        return is_string($value) ? $value : '';
    }
}
