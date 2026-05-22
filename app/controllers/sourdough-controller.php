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

const PHASE_ORDER = ['bulk_fermentation', 'cold_proof', 'bench_rest', 'bake_lid', 'bake_no_lid', 'finished'];

$method   = $_SERVER['REQUEST_METHOD'];
$resource = $_GET['resource'] ?? null;
$action   = $_GET['action']   ?? null;
$id       = isset($_GET['id']) ? (int) $_GET['id'] : null;

try {
    if ($resource === 'starter') {
        handleStarter($method, $action);
    } elseif ($resource === 'bread') {
        handleBread($method, $action, $id);
    } else {
        sendError('Unknown resource. Use ?resource=starter or ?resource=bread', 400);
    }
} catch (Exception $e) {
    error_log('Sourdough controller error: ' . $e->getMessage());
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

function sanitize(string $value): string
{
    return htmlspecialchars(trim($value), ENT_QUOTES, 'UTF-8');
}

function readBody(): array
{
    if (!empty($_POST)) return $_POST;
    $raw = file_get_contents('php://input');
    if (!$raw) return [];
    $json = json_decode($raw, true);
    if (is_array($json)) return $json;
    parse_str($raw, $parsed);
    return is_array($parsed) ? $parsed : [];
}

// --- Starter ---

function handleStarter(string $method, ?string $action): void
{
    if ($method === 'GET') {
        getStarter();
        return;
    }
    if ($method === 'POST') {
        if ($action === 'feed')     { feedStarter();     return; }
        if ($action === 'fridge')   { fridgeStarter();   return; }
        if ($action === 'unfridge') { unfridgeStarter(); return; }
        sendError('Unknown starter action', 400);
    }
    sendError('Method not allowed', 405);
}

function getStarter(): void
{
    $stmt = Database::read()->query(
        'SELECT id, name, last_fed_at, in_fridge, created_at, updated_at
         FROM sourdough_starter
         ORDER BY id ASC
         LIMIT 1'
    );
    $starter = $stmt->fetch();
    if (!$starter) {
        sendError('Starter not found. Seed the table first.', 404);
    }
    $starter['id']        = (int) $starter['id'];
    $starter['in_fridge'] = (int) $starter['in_fridge'];
    sendJson($starter);
}

function feedStarter(): void
{
    $stmt = Database::write()->prepare(
        'UPDATE sourdough_starter
         SET last_fed_at = NOW(), in_fridge = 0
         ORDER BY id ASC
         LIMIT 1'
    );
    $stmt->execute();
    getStarter();
}

function fridgeStarter(): void
{
    $stmt = Database::write()->prepare(
        'UPDATE sourdough_starter
         SET in_fridge = 1
         ORDER BY id ASC
         LIMIT 1'
    );
    $stmt->execute();
    getStarter();
}

function unfridgeStarter(): void
{
    $stmt = Database::write()->prepare(
        'UPDATE sourdough_starter
         SET in_fridge = 0
         ORDER BY id ASC
         LIMIT 1'
    );
    $stmt->execute();
    getStarter();
}

// --- Bread ---

function handleBread(string $method, ?string $action, ?int $id): void
{
    switch ($method) {
        case 'GET':
            if ($id) { getBread($id); return; }
            listBreads();
            return;

        case 'POST':
            if (!$id) { createBread(); return; }
            if ($action === 'fold')       { logFold($id);       return; }
            if ($action === 'folds_done') { markFoldsDone($id); return; }
            if ($action === 'advance')    { advanceBread($id);  return; }
            if ($action === 'back')       { goBackBread($id);   return; }
            sendError('Unknown bread action', 400);

        case 'DELETE':
            if (!$id) sendError('Bread ID is required', 400);
            deleteBread($id);
            return;

        default:
            sendError('Method not allowed', 405);
    }
}

function formatBread(array $row): array
{
    $row['id']    = (int) $row['id'];
    $row['folds'] = json_decode($row['folds'] ?? '[]', true) ?: [];
    return $row;
}

function listBreads(): void
{
    $sql = 'SELECT id, name, phase, mixed_at, folds, folds_done_at, cold_proof_at,
            bench_rest_at, bake_lid_at, bake_no_lid_at, finished_at, created_at, updated_at
            FROM sourdough_breads
            ORDER BY created_at DESC';
    $stmt = Database::read()->query($sql);
    sendJson(array_map('formatBread', $stmt->fetchAll()));
}

function getBread(int $id): void
{
    $sql = 'SELECT id, name, phase, mixed_at, folds, folds_done_at, cold_proof_at,
            bench_rest_at, bake_lid_at, bake_no_lid_at, finished_at, created_at, updated_at
            FROM sourdough_breads WHERE id = ?';
    $stmt = Database::read()->prepare($sql);
    $stmt->execute([$id]);
    $bread = $stmt->fetch();
    if (!$bread) sendError('Bread not found', 404);
    sendJson(formatBread($bread));
}

function fetchPhase(int $id): string
{
    $stmt = Database::read()->prepare('SELECT phase FROM sourdough_breads WHERE id = ?');
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    if (!$row) sendError('Bread not found', 404);
    return $row['phase'];
}

function createBread(): void
{
    $data = readBody();
    $name = isset($data['name']) ? trim((string) $data['name']) : '';
    if ($name === '')                 sendError('Name is required', 400);
    if (mb_strlen($name) > 100)       sendError('Name must be 100 characters or less', 400);

    $stmt = Database::write()->prepare(
        "INSERT INTO sourdough_breads (name, phase, mixed_at, folds)
         VALUES (?, 'bulk_fermentation', NOW(), '[]')"
    );
    $stmt->execute([sanitize($name)]);

    $id = (int) Database::write()->lastInsertId();
    getBread($id);
}

function logFold(int $id): void
{
    $phase = fetchPhase($id);
    if ($phase !== 'bulk_fermentation') {
        sendError('Folds can only be logged during bulk fermentation', 400);
    }

    $db = Database::write();
    $stmt = $db->prepare('SELECT folds FROM sourdough_breads WHERE id = ?');
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    $folds = json_decode($row['folds'] ?? '[]', true) ?: [];
    $folds[] = date('Y-m-d H:i:s');

    $upd = $db->prepare('UPDATE sourdough_breads SET folds = ? WHERE id = ?');
    $upd->execute([json_encode($folds, JSON_UNESCAPED_UNICODE), $id]);

    getBread($id);
}

function markFoldsDone(int $id): void
{
    $phase = fetchPhase($id);
    if ($phase !== 'bulk_fermentation') {
        sendError('Folds can only be marked done during bulk fermentation', 400);
    }

    $stmt = Database::write()->prepare(
        'UPDATE sourdough_breads SET folds_done_at = NOW() WHERE id = ?'
    );
    $stmt->execute([$id]);

    getBread($id);
}

function advanceBread(int $id): void
{
    $phase = fetchPhase($id);
    $idx   = array_search($phase, PHASE_ORDER, true);
    if ($idx === false || $idx === count(PHASE_ORDER) - 1) {
        sendError('Bread is already finished', 400);
    }

    $nextPhase = PHASE_ORDER[$idx + 1];
    $stampColumn = match ($nextPhase) {
        'cold_proof'   => 'cold_proof_at',
        'bench_rest'   => 'bench_rest_at',
        'bake_lid'     => 'bake_lid_at',
        'bake_no_lid'  => 'bake_no_lid_at',
        'finished'     => 'finished_at',
    };

    $sql = "UPDATE sourdough_breads SET phase = ?, {$stampColumn} = NOW() WHERE id = ?";
    $stmt = Database::write()->prepare($sql);
    $stmt->execute([$nextPhase, $id]);

    getBread($id);
}

function goBackBread(int $id): void
{
    $phase = fetchPhase($id);
    $idx   = array_search($phase, PHASE_ORDER, true);
    if ($idx === false || $idx === 0) {
        sendError('Cannot go back from this phase', 400);
    }

    $stampColumn = match ($phase) {
        'cold_proof'   => 'cold_proof_at',
        'bench_rest'   => 'bench_rest_at',
        'bake_lid'     => 'bake_lid_at',
        'bake_no_lid'  => 'bake_no_lid_at',
        'finished'     => 'finished_at',
    };

    $prevPhase = PHASE_ORDER[$idx - 1];
    $sql = "UPDATE sourdough_breads SET phase = ?, {$stampColumn} = NULL WHERE id = ?";
    $stmt = Database::write()->prepare($sql);
    $stmt->execute([$prevPhase, $id]);

    getBread($id);
}

function deleteBread(int $id): void
{
    $stmt = Database::read()->prepare('SELECT id FROM sourdough_breads WHERE id = ?');
    $stmt->execute([$id]);
    if (!$stmt->fetch()) sendError('Bread not found', 404);

    $del = Database::write()->prepare('DELETE FROM sourdough_breads WHERE id = ?');
    $del->execute([$id]);

    sendJson(['message' => 'Bread deleted']);
}
