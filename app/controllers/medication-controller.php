<?php
declare(strict_types=1);
define('SECURE_ACCESS', true);

// Backend for views/medication, the private medication tracker.
//
// Single-owner tool: every branch sits behind Auth::requireAdmin(), reads
// included, so rows carry no user_id (the same shape as compass-controller).
// A public read here would expose a personal medical record.
//
// Schema: app/models/medication-model.sql

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

Auth::requireAdmin();

// Mirrors FORMS in views/medication/logic.js and the comment on the `form`
// column in medication-model.sql. Edit the three together.
const FORMS = ['tablet', 'capsule', 'drops', 'spray', 'injection', 'other'];

const MAX_NAME  = 100;
const MIN_DOSES = 1;
const MAX_DOSES = 12;

// The Today view's history strip. Capped so a hand-typed ?days= cannot ask for
// an unbounded scan.
const DEFAULT_HISTORY_DAYS = 14;
const MAX_HISTORY_DAYS     = 400;

const MED_SELECT = '
    SELECT id, name, form, doses_per_day, starts_on, ends_on, DATE(created_at) AS created_on
    FROM medication_meds';

// ------------------------------------------------------------------
//  Helpers
// ------------------------------------------------------------------

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

function sanitize(string $value): string
{
    return htmlspecialchars(trim($value), ENT_QUOTES, 'UTF-8');
}

function readBody(): array
{
    $raw = file_get_contents('php://input');
    if (!$raw) return [];
    $json = json_decode($raw, true);
    return is_array($json) ? $json : [];
}

/** A yyyy-mm-dd string, or null when it is not a real day. */
function parseIsoDate(mixed $value): ?string
{
    $raw = trim((string) $value);
    if ($raw === '' || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $raw)) return null;
    [$y, $m, $d] = array_map('intval', explode('-', $raw));
    return checkdate($m, $d, $y) ? $raw : null;
}

// ------------------------------------------------------------------
//  Dispatch
// ------------------------------------------------------------------

$method   = $_SERVER['REQUEST_METHOD'];
$resource = $_GET['resource'] ?? null;
$id       = isset($_GET['id']) ? (int) $_GET['id'] : null;

try {
    if ($resource === 'state') {
        if ($method !== 'GET') sendError('Method not allowed', 405);
        getState();
    } elseif ($resource === 'med') {
        handleMed($method, $id);
    } elseif ($resource === 'dose') {
        if ($method !== 'PUT') sendError('Method not allowed', 405);
        setDose();
    } else {
        sendError('Unknown resource. Use ?resource=state, med or dose', 400);
    }
} catch (Exception $e) {
    error_log('Medication controller error: ' . $e->getMessage());
    sendError('Internal server error', 500);
}

// ------------------------------------------------------------------
//  State: everything the page needs to draw a day
// ------------------------------------------------------------------

function getState(): void
{
    $day = parseIsoDate($_GET['day'] ?? '');
    if ($day === null) sendError('A valid ?day=yyyy-mm-dd is required', 400);

    $days = isset($_GET['days']) ? (int) $_GET['days'] : DEFAULT_HISTORY_DAYS;
    $days = max(1, min($days, MAX_HISTORY_DAYS));

    $db = Database::read();

    $meds = $db->query(MED_SELECT . ' WHERE deleted_at IS NULL ORDER BY name ASC')->fetchAll();

    // The loaded day's doses. Deleted medications are excluded on both sides of
    // the ledger, so a day's taken count can never outrun what was planned.
    $stmt = $db->prepare('
        SELECT d.med_id, d.slot, d.taken_at
        FROM medication_doses d
        JOIN medication_meds m ON m.id = d.med_id AND m.deleted_at IS NULL
        WHERE d.day = ?
        ORDER BY d.slot ASC');
    $stmt->execute([$day]);
    $taken = $stmt->fetchAll();

    // The history strip, grouped one row per day per medication. The capping
    // and the denominator are worked out in logic.js so the active-course rules
    // are not restated in SQL, where the two would quietly drift apart.
    $from = (new DateTimeImmutable($day))->modify('-' . ($days - 1) . ' days')->format('Y-m-d');
    $stmt = $db->prepare('
        SELECT d.day, d.med_id, COUNT(*) AS taken
        FROM medication_doses d
        JOIN medication_meds m ON m.id = d.med_id AND m.deleted_at IS NULL
        WHERE d.day BETWEEN ? AND ?
        GROUP BY d.day, d.med_id');
    $stmt->execute([$from, $day]);
    $history = $stmt->fetchAll();

    sendJson([
        'day'     => $day,
        'meds'    => array_map('formatMed', $meds),
        'taken'   => array_map(static fn (array $r): array => [
            'med_id'   => (int) $r['med_id'],
            'slot'     => (int) $r['slot'],
            'taken_at' => $r['taken_at'],
        ], $taken),
        'history' => array_map(static fn (array $r): array => [
            'day'    => $r['day'],
            'med_id' => (int) $r['med_id'],
            'taken'  => (int) $r['taken'],
        ], $history),
    ]);
}

function formatMed(array $row): array
{
    return [
        'id'            => (int) $row['id'],
        'name'          => $row['name'],
        'form'          => $row['form'],
        'doses_per_day' => (int) $row['doses_per_day'],
        'starts_on'     => $row['starts_on'],
        'ends_on'       => $row['ends_on'],
        'created_on'    => $row['created_on'],
    ];
}

// ------------------------------------------------------------------
//  Medications
// ------------------------------------------------------------------

function handleMed(string $method, ?int $id): void
{
    switch ($method) {
        case 'POST':
            createMed();
            return;
        case 'PUT':
            if (!$id) sendError('Medication ID is required', 400);
            updateMed($id);
            return;
        case 'DELETE':
            if (!$id) sendError('Medication ID is required', 400);
            deleteMed($id);
            return;
        default:
            sendError('Method not allowed', 405);
    }
}

/**
 * The same rules as validateMed() in views/medication/logic.js. The client-side
 * check is a courtesy so the form can fail fast; this one is the gate. Edit the
 * two together.
 *
 * @return array{name:string, form:string, doses_per_day:int, starts_on:?string, ends_on:?string}
 */
function validateMed(array $data): array
{
    $name = isset($data['name']) ? trim((string) $data['name']) : '';
    if ($name === '') sendError('Give it a name.', 422);
    if (mb_strlen($name) > MAX_NAME) sendError('Keep the name under ' . MAX_NAME . ' characters.', 422);

    $form = isset($data['form']) && $data['form'] !== '' ? (string) $data['form'] : 'tablet';
    if (!in_array($form, FORMS, true)) sendError('Pick a form from the list.', 422);

    $raw = $data['doses_per_day'] ?? 1;
    if (!is_numeric($raw) || (int) $raw != $raw) {
        sendError('Doses a day has to be a whole number between ' . MIN_DOSES . ' and ' . MAX_DOSES . '.', 422);
    }
    $doses = (int) $raw;
    if ($doses < MIN_DOSES || $doses > MAX_DOSES) {
        sendError('Doses a day has to be a whole number between ' . MIN_DOSES . ' and ' . MAX_DOSES . '.', 422);
    }

    // An unreadable date is rejected, never stored as null: a silent null reads
    // as "no end date" and keeps a finished course on the list for ever.
    $dates = [];
    foreach (['starts_on', 'ends_on'] as $field) {
        $value = trim((string) ($data[$field] ?? ''));
        if ($value === '') {
            $dates[$field] = null;
            continue;
        }
        $iso = parseIsoDate($value);
        if ($iso === null) sendError('Dates must be sent as yyyy-mm-dd.', 422);
        $dates[$field] = $iso;
    }
    if ($dates['starts_on'] !== null && $dates['ends_on'] !== null && $dates['ends_on'] < $dates['starts_on']) {
        sendError('The course cannot end before it starts.', 422);
    }

    return [
        'name'          => sanitize($name),
        'form'          => $form,
        'doses_per_day' => $doses,
        'starts_on'     => $dates['starts_on'],
        'ends_on'       => $dates['ends_on'],
    ];
}

/** The medication by id, or 404. A soft-deleted row is indistinguishable from a missing one. */
function fetchMed(int $id): array
{
    $stmt = Database::read()->prepare(MED_SELECT . ' WHERE id = ? AND deleted_at IS NULL');
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    if (!$row) sendError('Medication not found', 404);
    return $row;
}

function createMed(): void
{
    $v = validateMed(readBody());
    $stmt = Database::write()->prepare(
        'INSERT INTO medication_meds (name, form, doses_per_day, starts_on, ends_on) VALUES (?, ?, ?, ?, ?)'
    );
    $stmt->execute([$v['name'], $v['form'], $v['doses_per_day'], $v['starts_on'], $v['ends_on']]);
    sendJson(formatMed(fetchMed((int) Database::write()->lastInsertId())), 201);
}

function updateMed(int $id): void
{
    fetchMed($id);
    $v = validateMed(readBody());
    $stmt = Database::write()->prepare(
        'UPDATE medication_meds SET name = ?, form = ?, doses_per_day = ?, starts_on = ?, ends_on = ?
         WHERE id = ? AND deleted_at IS NULL'
    );
    $stmt->execute([$v['name'], $v['form'], $v['doses_per_day'], $v['starts_on'], $v['ends_on'], $id]);
    sendJson(formatMed(fetchMed($id)));
}

/**
 * Soft delete. The medication leaves every view, history included, which is
 * what keeps a day's taken count from outrunning what was planned. To stop a
 * course but keep its history, set ends_on instead.
 */
function deleteMed(int $id): void
{
    $stmt = Database::write()->prepare(
        'UPDATE medication_meds SET deleted_at = NOW() WHERE id = ? AND deleted_at IS NULL'
    );
    $stmt->execute([$id]);
    if ($stmt->rowCount() === 0) sendError('Medication not found', 404);
    sendJson(['message' => 'Medication deleted']);
}

// ------------------------------------------------------------------
//  Doses
// ------------------------------------------------------------------

/**
 * Set one slot's state. PUT rather than POST/DELETE because it is idempotent by
 * construction: the unique key absorbs a repeat take and a repeat release is a
 * no-op, so a tap retried on a bad connection can never double-count.
 */
function setDose(): void
{
    $data = readBody();

    $medId = isset($data['med_id']) ? (int) $data['med_id'] : 0;
    if ($medId <= 0) sendError('med_id is required', 400);
    $med = fetchMed($medId);

    $day = parseIsoDate($data['day'] ?? '');
    if ($day === null) sendError('A valid day (yyyy-mm-dd) is required', 400);

    $raw = $data['slot'] ?? null;
    if (!is_numeric($raw) || (int) $raw != $raw) sendError('slot is required', 400);
    $slot = (int) $raw;
    if ($slot < 0 || $slot >= (int) $med['doses_per_day']) {
        sendError('That slot is outside the medication\'s schedule', 422);
    }

    $taken = !empty($data['taken']);

    if ($taken) {
        $stmt = Database::write()->prepare(
            'INSERT INTO medication_doses (med_id, day, slot, taken_at) VALUES (?, ?, ?, NOW())
             ON DUPLICATE KEY UPDATE taken_at = taken_at'
        );
        $stmt->execute([$medId, $day, $slot]);

        $stmt = Database::read()->prepare(
            'SELECT taken_at FROM medication_doses WHERE med_id = ? AND day = ? AND slot = ?'
        );
        $stmt->execute([$medId, $day, $slot]);
        sendJson(['med_id' => $medId, 'day' => $day, 'slot' => $slot, 'taken' => true, 'taken_at' => $stmt->fetchColumn()]);
    }

    $stmt = Database::write()->prepare('DELETE FROM medication_doses WHERE med_id = ? AND day = ? AND slot = ?');
    $stmt->execute([$medId, $day, $slot]);
    sendJson(['med_id' => $medId, 'day' => $day, 'slot' => $slot, 'taken' => false, 'taken_at' => null]);
}
