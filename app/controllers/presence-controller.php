<?php
declare(strict_types=1);
define('SECURE_ACCESS', true);

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

require_once __DIR__ . '/../config/database.php';

$method   = $_SERVER['REQUEST_METHOD'];
$resource = $_GET['resource'] ?? '';
$action   = $_GET['action']   ?? '';
$id       = isset($_GET['id']) ? (int) $_GET['id'] : null;

try {
    switch ($resource) {
        case 'daily':      handleDaily($method, $action); break;
        case 'triggers':   handleTriggers($method, $id); break;
        case 'mentioned':  handleMentioned($method, $action, $id); break;
        case 'weekly':     handleWeekly($method, $action); break;
        case 'settings':   handleSettings($method); break;
        case 'metrics':    handleMetrics($method); break;
        default:           sendError('Unknown resource', 400);
    }
} catch (Throwable $e) {
    error_log('Presence controller error: ' . $e->getMessage());
    sendError('Internal server error', 500);
}

// --- HTTP helpers ---

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

function jsonBody(): array
{
    $raw = file_get_contents('php://input');
    if ($raw === '' || $raw === false) return [];
    $data = json_decode($raw, true);
    if (!is_array($data)) sendError('Invalid JSON body', 400);
    return $data;
}

function sanitize(string $value): string
{
    return htmlspecialchars(trim($value), ENT_QUOTES, 'UTF-8');
}

// --- Date / week helpers ---

function todayDate(): string
{
    return (new DateTimeImmutable('now'))->format('Y-m-d');
}

function isoYearWeek(?string $date = null): string
{
    $d = new DateTimeImmutable($date ?? 'now');
    return $d->format('o-\WW'); // ISO year + week, e.g. 2026-W21
}

function isoWeekBounds(?string $date = null): array
{
    $d = new DateTimeImmutable($date ?? 'now');
    $dow = (int) $d->format('N'); // 1=Mon..7=Sun
    $start = $d->modify('-' . ($dow - 1) . ' days')->format('Y-m-d');
    $end   = $d->modify('+' . (7 - $dow) . ' days')->format('Y-m-d');
    return [$start, $end];
}

function daysAgo(int $n): string
{
    return (new DateTimeImmutable('-' . $n . ' days'))->format('Y-m-d');
}

// --- presence_daily ---

function emptyDailyRow(string $date): array
{
    return [
        'entry_date'                  => $date,
        'good_morning'                => null,
        'good_night'                  => null,
        'voice_or_video'              => null,
        'unprompted_thinking_of_you'  => null,
        'present_when_we_talked'      => null,
        'silent_leaves'               => 0,
        'reflection'                  => '',
        'covert_contract_noticed'     => '',
        'where_i_showed_up'           => '',
    ];
}

function formatDailyRow(?array $row, string $date): array
{
    if (!$row) return emptyDailyRow($date);

    $behaviorKeys = ['good_morning','good_night','voice_or_video','unprompted_thinking_of_you','present_when_we_talked'];
    foreach ($behaviorKeys as $k) {
        $row[$k] = $row[$k] === null ? null : (int) $row[$k];
    }
    $row['silent_leaves'] = (int) $row['silent_leaves'];
    $row['reflection']               = $row['reflection']               ?? '';
    $row['covert_contract_noticed']  = $row['covert_contract_noticed']  ?? '';
    $row['where_i_showed_up']        = $row['where_i_showed_up']        ?? '';
    unset($row['id'], $row['created_at'], $row['updated_at']);
    return $row;
}

function fetchDaily(string $date): array
{
    $stmt = Database::read()->prepare('SELECT * FROM presence_daily WHERE entry_date = ?');
    $stmt->execute([$date]);
    return formatDailyRow($stmt->fetch() ?: null, $date);
}

function handleDaily(string $method, string $action): void
{
    if ($method === 'GET') {
        if ($action === 'range') {
            $days = max(1, min(365, (int) ($_GET['days'] ?? 30)));
            $stmt = Database::read()->prepare(
                'SELECT * FROM presence_daily WHERE entry_date >= ? ORDER BY entry_date ASC'
            );
            $stmt->execute([daysAgo($days - 1)]);
            $rows = array_map(fn($r) => formatDailyRow($r, $r['entry_date']), $stmt->fetchAll());
            sendJson($rows);
        }
        $date = $_GET['date'] ?? todayDate();
        sendJson(fetchDaily($date));
    }

    if ($method === 'POST') {
        $body = jsonBody();
        $date = $body['entry_date'] ?? todayDate();
        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) sendError('Invalid entry_date', 400);

        $behaviorKeys = ['good_morning','good_night','voice_or_video','unprompted_thinking_of_you','present_when_we_talked'];
        $textKeys     = ['reflection','covert_contract_noticed','where_i_showed_up'];

        $cols = ['entry_date'];
        $vals = [$date];
        $update = [];

        foreach ($behaviorKeys as $k) {
            if (!array_key_exists($k, $body)) continue;
            $v = $body[$k];
            if ($v !== null && $v !== 0 && $v !== 1 && $v !== '0' && $v !== '1') {
                sendError("Invalid value for $k", 400);
            }
            $cols[]   = $k;
            $vals[]   = $v === null ? null : (int) $v;
            $update[] = "$k = VALUES($k)";
        }
        if (array_key_exists('silent_leaves', $body)) {
            $cols[]   = 'silent_leaves';
            $vals[]   = max(0, (int) $body['silent_leaves']);
            $update[] = 'silent_leaves = VALUES(silent_leaves)';
        }
        foreach ($textKeys as $k) {
            if (!array_key_exists($k, $body)) continue;
            $cols[]   = $k;
            $vals[]   = is_string($body[$k]) ? sanitize($body[$k]) : '';
            $update[] = "$k = VALUES($k)";
        }

        if (count($cols) === 1) {
            // Nothing to upsert beyond the date — still ensure the row exists.
            $cols[]   = 'silent_leaves';
            $vals[]   = 0;
            $update[] = 'silent_leaves = silent_leaves';
        }

        $placeholders = implode(',', array_fill(0, count($cols), '?'));
        $sql = 'INSERT INTO presence_daily (' . implode(',', $cols) . ") VALUES ($placeholders) "
             . 'ON DUPLICATE KEY UPDATE ' . implode(', ', $update);
        $stmt = Database::write()->prepare($sql);
        $stmt->execute($vals);

        sendJson(fetchDaily($date));
    }

    sendError('Method not allowed', 405);
}

// --- presence_triggers ---

function formatTrigger(array $row): array
{
    return [
        'id'                          => (int) $row['id'],
        'entry_date'                  => $row['entry_date'],
        'occurred_at'                 => $row['occurred_at'],
        'situation'                   => $row['situation'],
        'what_i_did'                  => $row['what_i_did'],
        'what_i_could_do_next_time'   => $row['what_i_could_do_next_time'] ?? '',
    ];
}

function handleTriggers(string $method, ?int $id): void
{
    if ($method === 'GET') {
        $date = $_GET['date'] ?? todayDate();
        $stmt = Database::read()->prepare(
            'SELECT * FROM presence_triggers WHERE entry_date = ? ORDER BY occurred_at DESC'
        );
        $stmt->execute([$date]);
        sendJson(array_map('formatTrigger', $stmt->fetchAll()));
    }

    if ($method === 'POST') {
        $body = jsonBody();
        $situation = trim((string) ($body['situation'] ?? ''));
        $whatIDid  = trim((string) ($body['what_i_did'] ?? ''));
        if ($situation === '' || $whatIDid === '') sendError('situation and what_i_did are required', 400);

        $stmt = Database::write()->prepare(
            'INSERT INTO presence_triggers (entry_date, situation, what_i_did, what_i_could_do_next_time) VALUES (?, ?, ?, ?)'
        );
        $stmt->execute([
            todayDate(),
            sanitize($situation),
            sanitize($whatIDid),
            isset($body['what_i_could_do_next_time']) ? sanitize((string) $body['what_i_could_do_next_time']) : null,
        ]);
        sendJson(['id' => (int) Database::write()->lastInsertId()], 201);
    }

    if ($method === 'DELETE') {
        if (!$id) sendError('id is required', 400);
        $stmt = Database::write()->prepare('DELETE FROM presence_triggers WHERE id = ?');
        $stmt->execute([$id]);
        sendJson(['ok' => true]);
    }

    sendError('Method not allowed', 405);
}

// --- presence_she_mentioned ---

function formatMentioned(array $row): array
{
    return [
        'id'              => (int) $row['id'],
        'topic'           => $row['topic'],
        'detail'          => $row['detail'] ?? '',
        'mentioned_on'    => $row['mentioned_on'],
        'follow_up_by'    => $row['follow_up_by'],
        'followed_up'     => (int) $row['followed_up'],
        'followed_up_on'  => $row['followed_up_on'],
    ];
}

function handleMentioned(string $method, string $action, ?int $id): void
{
    if ($method === 'GET') {
        // Open items first (by follow_up_by ASC, NULLs last), then completed (by followed_up_on DESC).
        $stmt = Database::read()->query(
            'SELECT * FROM presence_she_mentioned
             ORDER BY followed_up ASC,
                      CASE WHEN follow_up_by IS NULL THEN 1 ELSE 0 END ASC,
                      follow_up_by ASC,
                      mentioned_on DESC'
        );
        sendJson(array_map('formatMentioned', $stmt->fetchAll()));
    }

    if ($method === 'POST') {
        if ($action === 'followup') {
            if (!$id) sendError('id is required', 400);
            $stmt = Database::write()->prepare(
                'UPDATE presence_she_mentioned SET followed_up = 1, followed_up_on = CURDATE() WHERE id = ?'
            );
            $stmt->execute([$id]);
            sendJson(['ok' => true]);
        }

        $body  = jsonBody();
        $topic = trim((string) ($body['topic'] ?? ''));
        if ($topic === '') sendError('topic is required', 400);

        $followUpBy = $body['follow_up_by'] ?? null;
        if ($followUpBy !== null && $followUpBy !== '' && !preg_match('/^\d{4}-\d{2}-\d{2}$/', $followUpBy)) {
            sendError('Invalid follow_up_by', 400);
        }
        if ($followUpBy === '') $followUpBy = null;

        $stmt = Database::write()->prepare(
            'INSERT INTO presence_she_mentioned (topic, detail, mentioned_on, follow_up_by) VALUES (?, ?, CURDATE(), ?)'
        );
        $stmt->execute([
            sanitize($topic),
            isset($body['detail']) ? sanitize((string) $body['detail']) : null,
            $followUpBy,
        ]);
        sendJson(['id' => (int) Database::write()->lastInsertId()], 201);
    }

    if ($method === 'DELETE') {
        if (!$id) sendError('id is required', 400);
        $stmt = Database::write()->prepare('DELETE FROM presence_she_mentioned WHERE id = ?');
        $stmt->execute([$id]);
        sendJson(['ok' => true]);
    }

    sendError('Method not allowed', 405);
}

// --- presence_weekly ---

function formatWeekly(?array $row, string $yearWeek): array
{
    if (!$row) {
        return [
            'year_week'                 => $yearWeek,
            'presence_score'            => null,
            'initiation_score'          => null,
            'consistency_score'         => null,
            'depth_score'               => null,
            'what_she_said_she_needed'  => '',
            'where_i_made_her_chase_me' => '',
            'next_week_one_thing'       => '',
        ];
    }
    foreach (['presence_score','initiation_score','consistency_score','depth_score'] as $k) {
        $row[$k] = $row[$k] === null ? null : (int) $row[$k];
    }
    foreach (['what_she_said_she_needed','where_i_made_her_chase_me','next_week_one_thing'] as $k) {
        $row[$k] = $row[$k] ?? '';
    }
    unset($row['id'], $row['created_at'], $row['updated_at']);
    return $row;
}

function handleWeekly(string $method, string $action): void
{
    if ($method === 'GET') {
        if ($action === 'range') {
            $weeks = max(1, min(52, (int) ($_GET['weeks'] ?? 12)));
            $stmt = Database::read()->prepare(
                'SELECT * FROM presence_weekly ORDER BY year_week DESC LIMIT ?'
            );
            $stmt->bindValue(1, $weeks, PDO::PARAM_INT);
            $stmt->execute();
            $rows = array_reverse(array_map(fn($r) => formatWeekly($r, $r['year_week']), $stmt->fetchAll()));
            sendJson($rows);
        }

        $yw = $_GET['year_week'] ?? isoYearWeek();
        if (!preg_match('/^\d{4}-W\d{2}$/', $yw)) sendError('Invalid year_week', 400);
        $stmt = Database::read()->prepare('SELECT * FROM presence_weekly WHERE year_week = ?');
        $stmt->execute([$yw]);
        sendJson(formatWeekly($stmt->fetch() ?: null, $yw));
    }

    if ($method === 'POST') {
        $body = jsonBody();
        $yw   = $body['year_week'] ?? isoYearWeek();
        if (!preg_match('/^\d{4}-W\d{2}$/', $yw)) sendError('Invalid year_week', 400);

        $scoreKeys = ['presence_score','initiation_score','consistency_score','depth_score'];
        $textKeys  = ['what_she_said_she_needed','where_i_made_her_chase_me','next_week_one_thing'];

        $cols = ['year_week'];
        $vals = [$yw];
        $update = [];

        foreach ($scoreKeys as $k) {
            if (!array_key_exists($k, $body)) continue;
            $v = $body[$k];
            if ($v !== null) {
                $v = (int) $v;
                if ($v < 1 || $v > 10) sendError("$k must be 1..10", 400);
            }
            $cols[]   = $k;
            $vals[]   = $v;
            $update[] = "$k = VALUES($k)";
        }
        foreach ($textKeys as $k) {
            if (!array_key_exists($k, $body)) continue;
            $cols[]   = $k;
            $vals[]   = is_string($body[$k]) ? sanitize($body[$k]) : '';
            $update[] = "$k = VALUES($k)";
        }

        if (count($cols) === 1) sendError('Nothing to update', 400);

        $placeholders = implode(',', array_fill(0, count($cols), '?'));
        $sql = 'INSERT INTO presence_weekly (' . implode(',', $cols) . ") VALUES ($placeholders) "
             . 'ON DUPLICATE KEY UPDATE ' . implode(', ', $update);
        $stmt = Database::write()->prepare($sql);
        $stmt->execute($vals);

        $fetch = Database::read()->prepare('SELECT * FROM presence_weekly WHERE year_week = ?');
        $fetch->execute([$yw]);
        sendJson(formatWeekly($fetch->fetch() ?: null, $yw));
    }

    sendError('Method not allowed', 405);
}

// --- presence_settings ---

function fetchSettings(): array
{
    $stmt = Database::read()->query('SELECT setting_key, setting_value FROM presence_settings');
    $out = [];
    foreach ($stmt->fetchAll() as $row) {
        $out[$row['setting_key']] = $row['setting_value'];
    }
    return $out;
}

function handleSettings(string $method): void
{
    if ($method === 'GET') sendJson(fetchSettings());

    if ($method === 'POST') {
        $body = jsonBody();
        $allowed = ['her_timezone', 'next_visit_date', 'last_visit_date'];
        $key   = (string) ($body['key']   ?? '');
        $value = (string) ($body['value'] ?? '');
        if (!in_array($key, $allowed, true)) sendError('Unknown setting key', 400);
        if ($key === 'next_visit_date' || $key === 'last_visit_date') {
            if ($value !== '' && !preg_match('/^\d{4}-\d{2}-\d{2}$/', $value)) sendError('Invalid date', 400);
        }

        $stmt = Database::write()->prepare(
            'INSERT INTO presence_settings (setting_key, setting_value) VALUES (?, ?)
             ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)'
        );
        $stmt->execute([$key, $value]);
        sendJson(fetchSettings());
    }

    sendError('Method not allowed', 405);
}

// --- metrics ---

function computeStreaks(array $rowsByDate): array
{
    $behaviorKeys = ['good_morning','good_night','voice_or_video','unprompted_thinking_of_you','present_when_we_talked'];
    $today = new DateTimeImmutable('today');

    // If today has no row, start from yesterday.
    $start = isset($rowsByDate[$today->format('Y-m-d')]) ? $today : $today->modify('-1 day');

    $streaks = [];
    foreach ($behaviorKeys as $key) {
        $count = 0;
        $cursor = $start;
        for ($i = 0; $i < 365; $i++) {
            $d = $cursor->format('Y-m-d');
            $row = $rowsByDate[$d] ?? null;
            if (!$row) break;
            $v = $row[$key] ?? null;
            if ($v === 1 || $v === '1') {
                $count++;
                $cursor = $cursor->modify('-1 day');
            } else {
                break;
            }
        }
        $streaks[$key] = $count;
    }

    // no_silent_leave streak: consecutive days ending today with silent_leaves=0 AND row exists.
    $count = 0;
    $cursor = $today;
    for ($i = 0; $i < 365; $i++) {
        $d = $cursor->format('Y-m-d');
        $row = $rowsByDate[$d] ?? null;
        if (!$row) break;
        if ((int) $row['silent_leaves'] === 0) {
            $count++;
            $cursor = $cursor->modify('-1 day');
        } else {
            break;
        }
    }
    $streaks['no_silent_leave'] = $count;

    return $streaks;
}

function computeWPI(string $weekStart, string $weekEnd): array
{
    // Sum of behavior=1 minus silent_leaves across the week's daily rows.
    $stmt = Database::read()->prepare(
        'SELECT
            SUM(IF(good_morning=1,1,0))                 AS gm,
            SUM(IF(good_night=1,1,0))                   AS gn,
            SUM(IF(voice_or_video=1,1,0))               AS vv,
            SUM(IF(unprompted_thinking_of_you=1,1,0))   AS ut,
            SUM(IF(present_when_we_talked=1,1,0))       AS pw,
            SUM(silent_leaves)                          AS sl
         FROM presence_daily
         WHERE entry_date BETWEEN ? AND ?'
    );
    $stmt->execute([$weekStart, $weekEnd]);
    $row = $stmt->fetch() ?: [];
    $gm = (int)($row['gm'] ?? 0);
    $gn = (int)($row['gn'] ?? 0);
    $vv = (int)($row['vv'] ?? 0);
    $ut = (int)($row['ut'] ?? 0);
    $pw = (int)($row['pw'] ?? 0);
    $sl = (int)($row['sl'] ?? 0);
    $behaviorTotal = $gm + $gn + $vv + $ut + $pw;

    // 2 × on-time follow-throughs this week.
    $stmt = Database::read()->prepare(
        'SELECT COUNT(*) AS c FROM presence_she_mentioned
         WHERE followed_up = 1
           AND followed_up_on BETWEEN ? AND ?
           AND (follow_up_by IS NULL OR followed_up_on <= follow_up_by)'
    );
    $stmt->execute([$weekStart, $weekEnd]);
    $followups = (int) ($stmt->fetch()['c'] ?? 0);

    $wpi = $behaviorTotal - $sl + 2 * $followups;
    return [
        'wpi'             => $wpi,
        'behavior_total'  => $behaviorTotal,
        'silent_leaves'   => $sl,
        'followups_bonus' => 2 * $followups,
        'week_start'      => $weekStart,
        'week_end'        => $weekEnd,
    ];
}

function lastContactDates(): array
{
    $stmt = Database::read()->query(
        "SELECT MAX(entry_date) AS d FROM presence_daily
         WHERE good_morning=1 OR good_night=1 OR voice_or_video=1
            OR unprompted_thinking_of_you=1 OR present_when_we_talked=1"
    );
    $last = $stmt->fetch()['d'] ?? null;

    $stmt = Database::read()->query(
        'SELECT MAX(entry_date) AS d FROM presence_daily WHERE voice_or_video=1'
    );
    $lastCall = $stmt->fetch()['d'] ?? null;

    return ['last_contact_date' => $last, 'last_call_date' => $lastCall];
}

function handleMetrics(string $method): void
{
    if ($method !== 'GET') sendError('Method not allowed', 405);

    $today = todayDate();
    $todayRow = fetchDaily($today);

    // Last 30 days as ordered list + indexed map for streak computation.
    $stmt = Database::read()->prepare(
        'SELECT * FROM presence_daily WHERE entry_date >= ? ORDER BY entry_date ASC'
    );
    $stmt->execute([daysAgo(60)]); // wider window so streaks can extend past 30 days
    $rows = $stmt->fetchAll();
    $rowsByDate = [];
    foreach ($rows as $r) {
        $rowsByDate[$r['entry_date']] = $r;
    }

    // Build the explicit 30-day ascending list for the heatmap.
    $last30 = [];
    for ($i = 29; $i >= 0; $i--) {
        $d = (new DateTimeImmutable('-' . $i . ' days'))->format('Y-m-d');
        $row = $rowsByDate[$d] ?? null;
        $last30[] = [
            'entry_date'                  => $d,
            'has_entry'                   => $row !== null,
            'good_morning'                => $row ? ($row['good_morning'] === null ? null : (int) $row['good_morning']) : null,
            'good_night'                  => $row ? ($row['good_night']   === null ? null : (int) $row['good_night'])   : null,
            'voice_or_video'              => $row ? ($row['voice_or_video'] === null ? null : (int) $row['voice_or_video']) : null,
            'unprompted_thinking_of_you'  => $row ? ($row['unprompted_thinking_of_you'] === null ? null : (int) $row['unprompted_thinking_of_you']) : null,
            'present_when_we_talked'      => $row ? ($row['present_when_we_talked'] === null ? null : (int) $row['present_when_we_talked']) : null,
            'silent_leaves'               => $row ? (int) $row['silent_leaves'] : 0,
        ];
    }

    // Last 12 weeks.
    $stmt = Database::read()->prepare('SELECT * FROM presence_weekly ORDER BY year_week DESC LIMIT 12');
    $stmt->execute();
    $weekRowsDesc = $stmt->fetchAll();
    $weeks = [];
    foreach (array_reverse($weekRowsDesc) as $w) {
        $weeks[] = formatWeekly($w, $w['year_week']);
    }

    $streaks = computeStreaks($rowsByDate);
    [$weekStart, $weekEnd] = isoWeekBounds();
    $wpi = computeWPI($weekStart, $weekEnd);

    // Mentioned counts.
    $stmt = Database::read()->query('SELECT COUNT(*) AS c FROM presence_she_mentioned WHERE followed_up = 0');
    $mentionedOpen = (int) ($stmt->fetch()['c'] ?? 0);
    $stmt = Database::read()->prepare(
        'SELECT COUNT(*) AS c FROM presence_she_mentioned
         WHERE followed_up = 0 AND follow_up_by IS NOT NULL AND follow_up_by < ?'
    );
    $stmt->execute([$today]);
    $mentionedOverdue = (int) ($stmt->fetch()['c'] ?? 0);

    // Triggers last 7 days.
    $stmt = Database::read()->prepare(
        'SELECT entry_date, COUNT(*) AS c FROM presence_triggers
         WHERE entry_date >= ? GROUP BY entry_date'
    );
    $stmt->execute([daysAgo(13)]);
    $triggerByDate = [];
    foreach ($stmt->fetchAll() as $r) {
        $triggerByDate[$r['entry_date']] = (int) $r['c'];
    }
    $last14Triggers = [];
    $triggerLast7 = 0;
    for ($i = 13; $i >= 0; $i--) {
        $d = (new DateTimeImmutable('-' . $i . ' days'))->format('Y-m-d');
        $c = $triggerByDate[$d] ?? 0;
        $last14Triggers[] = ['entry_date' => $d, 'count' => $c];
        if ($i < 7) $triggerLast7 += $c;
    }

    $contact = lastContactDates();

    sendJson([
        'today'                     => $todayRow,
        'today_date'                => $today,
        'last_30_days'              => $last30,
        'last_12_weeks'             => $weeks,
        'streaks'                   => $streaks,
        'weekly_presence_index'     => $wpi['wpi'],
        'wpi_breakdown'             => $wpi,
        'mentioned_open_count'      => $mentionedOpen,
        'mentioned_overdue_count'   => $mentionedOverdue,
        'trigger_count_last_7_days' => $triggerLast7,
        'triggers_last_14_days'     => $last14Triggers,
        'last_contact_date'         => $contact['last_contact_date'],
        'last_call_date'            => $contact['last_call_date'],
        'settings'                  => fetchSettings(),
        'iso_year_week'             => isoYearWeek(),
        'week_start'                => $weekStart,
        'week_end'                  => $weekEnd,
    ]);
}
