<?php
declare(strict_types=1);
define('SECURE_ACCESS', true);

header('Content-Type: application/json; charset=utf-8');
// Responses vary with the session cookie, so they must never be cached.
header('Cache-Control: no-store');
// No Access-Control-Allow-Origin here: writes are gated by the session
// cookie, and wildcard CORS is incompatible with cookie auth.

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

require_once __DIR__ . '/../config/dev-mode.php';
require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../config/auth.php';

// One portal per user (read-only demo plus per-user rows, same shape as
// plants-controller.php). Reads are public: signed out you get the site
// owner's starter + loaves as a demo, signed in you get your own. Writes
// require login and are always scoped to the caller's own rows.

const PHASE_ORDER = ['bulk_fermentation', 'cold_proof', 'bench_rest', 'bake_lid', 'bake_no_lid', 'finished'];

$method   = $_SERVER['REQUEST_METHOD'];
$resource = $_GET['resource'] ?? null;
$action   = $_GET['action']   ?? null;
$id       = isset($_GET['id']) ? (int) $_GET['id'] : null;

try {
    if ($resource === 'session') {
        if ($method !== 'GET') sendError('Method not allowed', 405);
        getSession();
    } elseif ($resource === 'starter') {
        handleStarter($method, $action);
    } elseif ($resource === 'bread') {
        handleBread($method, $action, $id);
    } else {
        sendError('Unknown resource. Use ?resource=session, starter or bread', 400);
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

/** The user whose portal backs the public demo: the first active site admin. */
function showcaseUserId(): ?int
{
    static $resolved = false;
    static $id = null;
    if (!$resolved) {
        $resolved = true;
        $found = Database::read()
            ->query('SELECT id FROM users WHERE is_admin = 1 AND is_active = 1 ORDER BY id LIMIT 1')
            ->fetchColumn();
        $id = $found === false ? null : (int) $found;
    }
    return $id;
}

/** Whose portal the current request reads: the viewer's own, or the demo one. */
function shelfUserId(): ?int
{
    $viewer = Auth::currentUser();
    return $viewer !== null ? (int) $viewer['id'] : showcaseUserId();
}

// --- Session ---

function getSession(): void
{
    $viewer = Auth::currentUser();
    sendJson([
        'demo' => $viewer === null,
        'viewer' => $viewer !== null ? [
            'id' => (int) $viewer['id'],
            'display_name' => $viewer['display_name'],
            'avatar_url' => $viewer['avatar_url'],
        ] : null,
    ]);
}

// --- Starter ---

function handleStarter(string $method, ?string $action): void
{
    if ($method === 'GET') {
        getStarter();
        return;
    }
    if ($method === 'POST') {
        $user = Auth::requireLogin();
        if ($action === 'feed')     { feedStarter($user);     return; }
        if ($action === 'fridge')   { fridgeStarter($user);   return; }
        if ($action === 'unfridge') { unfridgeStarter($user); return; }
        sendError('Unknown starter action', 400);
    }
    sendError('Method not allowed', 405);
}

function formatStarter(array $row): array
{
    $row['id']        = (int) $row['id'];
    $row['in_fridge'] = (int) $row['in_fridge'];
    unset($row['user_id']);
    return $row;
}

/** Read a user's starter, or null if they don't have one yet. */
function fetchStarter(int $userId): ?array
{
    $stmt = Database::read()->prepare(
        'SELECT id, user_id, name, last_fed_at, in_fridge, created_at, updated_at
         FROM sourdough_starter WHERE user_id = ?'
    );
    $stmt->execute([$userId]);
    $row = $stmt->fetch();
    return $row ?: null;
}

/** Lazily create the signed-in user's starter, then return it. */
function ensureStarter(int $userId): array
{
    $existing = fetchStarter($userId);
    if ($existing !== null) {
        return $existing;
    }
    $stmt = Database::write()->prepare(
        "INSERT INTO sourdough_starter (user_id, name) VALUES (?, 'Starter')"
    );
    $stmt->execute([$userId]);
    return fetchStarter($userId);
}

function getStarter(): void
{
    $viewer = Auth::currentUser();
    if ($viewer !== null) {
        // Signed in: auto-create their starter so the portal is never empty.
        sendJson(formatStarter(ensureStarter((int) $viewer['id'])));
    }
    // Signed out: show the demo starter read-only, or null if the owner has none.
    $ownerId = showcaseUserId();
    $starter = $ownerId !== null ? fetchStarter($ownerId) : null;
    sendJson($starter !== null ? formatStarter($starter) : null);
}

function feedStarter(array $user): void
{
    ensureStarter((int) $user['id']);
    $stmt = Database::write()->prepare(
        'UPDATE sourdough_starter SET last_fed_at = NOW(), in_fridge = 0 WHERE user_id = ?'
    );
    $stmt->execute([(int) $user['id']]);
    sendJson(formatStarter(fetchStarter((int) $user['id'])));
}

function fridgeStarter(array $user): void
{
    ensureStarter((int) $user['id']);
    $stmt = Database::write()->prepare(
        'UPDATE sourdough_starter SET in_fridge = 1 WHERE user_id = ?'
    );
    $stmt->execute([(int) $user['id']]);
    sendJson(formatStarter(fetchStarter((int) $user['id'])));
}

function unfridgeStarter(array $user): void
{
    ensureStarter((int) $user['id']);
    $stmt = Database::write()->prepare(
        'UPDATE sourdough_starter SET in_fridge = 0 WHERE user_id = ?'
    );
    $stmt->execute([(int) $user['id']]);
    sendJson(formatStarter(fetchStarter((int) $user['id'])));
}

// --- Bread ---

function handleBread(string $method, ?string $action, ?int $id): void
{
    switch ($method) {
        case 'GET':
            if ($id) { getBread($id, shelfUserId()); return; }
            listBreads();
            return;

        case 'POST':
            $user = Auth::requireLogin();
            if (!$id) { createBread($user); return; }
            if ($action === 'fold')       { logFold($id, $user);       return; }
            if ($action === 'folds_done') { markFoldsDone($id, $user); return; }
            if ($action === 'advance')    { advanceBread($id, $user);  return; }
            if ($action === 'back')       { goBackBread($id, $user);   return; }
            sendError('Unknown bread action', 400);

        case 'DELETE':
            $user = Auth::requireLogin();
            if (!$id) sendError('Bread ID is required', 400);
            deleteBread($id, $user);
            return;

        default:
            sendError('Method not allowed', 405);
    }
}

function formatBread(array $row): array
{
    $row['id']    = (int) $row['id'];
    $row['folds'] = json_decode($row['folds'] ?? '[]', true) ?: [];
    unset($row['user_id']);
    return $row;
}

function listBreads(): void
{
    $ownerId = shelfUserId();
    if ($ownerId === null) {
        sendJson([]);
    }
    $sql = 'SELECT id, user_id, name, phase, mixed_at, folds, folds_done_at, cold_proof_at,
            bench_rest_at, bake_lid_at, bake_no_lid_at, finished_at, created_at, updated_at
            FROM sourdough_breads WHERE user_id = ?
            ORDER BY created_at DESC';
    $stmt = Database::read()->prepare($sql);
    $stmt->execute([$ownerId]);
    sendJson(array_map('formatBread', $stmt->fetchAll()));
}

function getBread(int $id, ?int $ownerId): void
{
    if ($ownerId === null) sendError('Bread not found', 404);
    $sql = 'SELECT id, user_id, name, phase, mixed_at, folds, folds_done_at, cold_proof_at,
            bench_rest_at, bake_lid_at, bake_no_lid_at, finished_at, created_at, updated_at
            FROM sourdough_breads WHERE id = ? AND user_id = ?';
    $stmt = Database::read()->prepare($sql);
    $stmt->execute([$id, $ownerId]);
    $bread = $stmt->fetch();
    if (!$bread) sendError('Bread not found', 404);
    sendJson(formatBread($bread));
}

/** Phase of a bread the caller owns; 404s otherwise. */
function fetchOwnPhase(int $id, array $user): string
{
    $stmt = Database::read()->prepare('SELECT phase FROM sourdough_breads WHERE id = ? AND user_id = ?');
    $stmt->execute([$id, (int) $user['id']]);
    $row = $stmt->fetch();
    if (!$row) sendError('Bread not found', 404);
    return $row['phase'];
}

function createBread(array $user): void
{
    $data = readBody();
    $name = isset($data['name']) ? trim((string) $data['name']) : '';
    if ($name === '')                 sendError('Name is required', 400);
    if (mb_strlen($name) > 100)       sendError('Name must be 100 characters or less', 400);

    $stmt = Database::write()->prepare(
        "INSERT INTO sourdough_breads (user_id, name, phase, mixed_at, folds)
         VALUES (?, ?, 'bulk_fermentation', NOW(), '[]')"
    );
    $stmt->execute([(int) $user['id'], sanitize($name)]);

    $id = (int) Database::write()->lastInsertId();
    getBread($id, (int) $user['id']);
}

function logFold(int $id, array $user): void
{
    $phase = fetchOwnPhase($id, $user);
    if ($phase !== 'bulk_fermentation') {
        sendError('Folds can only be logged during bulk fermentation', 400);
    }

    $db = Database::write();
    $stmt = $db->prepare('SELECT folds FROM sourdough_breads WHERE id = ? AND user_id = ?');
    $stmt->execute([$id, (int) $user['id']]);
    $row = $stmt->fetch();
    $folds = json_decode($row['folds'] ?? '[]', true) ?: [];
    $folds[] = date('Y-m-d H:i:s');

    $upd = $db->prepare('UPDATE sourdough_breads SET folds = ? WHERE id = ? AND user_id = ?');
    $upd->execute([json_encode($folds, JSON_UNESCAPED_UNICODE), $id, (int) $user['id']]);

    getBread($id, (int) $user['id']);
}

function markFoldsDone(int $id, array $user): void
{
    $phase = fetchOwnPhase($id, $user);
    if ($phase !== 'bulk_fermentation') {
        sendError('Folds can only be marked done during bulk fermentation', 400);
    }

    $stmt = Database::write()->prepare(
        'UPDATE sourdough_breads SET folds_done_at = NOW() WHERE id = ? AND user_id = ?'
    );
    $stmt->execute([$id, (int) $user['id']]);

    getBread($id, (int) $user['id']);
}

function advanceBread(int $id, array $user): void
{
    $phase = fetchOwnPhase($id, $user);
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

    $sql = "UPDATE sourdough_breads SET phase = ?, {$stampColumn} = NOW() WHERE id = ? AND user_id = ?";
    $stmt = Database::write()->prepare($sql);
    $stmt->execute([$nextPhase, $id, (int) $user['id']]);

    getBread($id, (int) $user['id']);
}

function goBackBread(int $id, array $user): void
{
    $phase = fetchOwnPhase($id, $user);
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
    $sql = "UPDATE sourdough_breads SET phase = ?, {$stampColumn} = NULL WHERE id = ? AND user_id = ?";
    $stmt = Database::write()->prepare($sql);
    $stmt->execute([$prevPhase, $id, (int) $user['id']]);

    getBread($id, (int) $user['id']);
}

function deleteBread(int $id, array $user): void
{
    $stmt = Database::read()->prepare('SELECT id FROM sourdough_breads WHERE id = ? AND user_id = ?');
    $stmt->execute([$id, (int) $user['id']]);
    if (!$stmt->fetch()) sendError('Bread not found', 404);

    $del = Database::write()->prepare('DELETE FROM sourdough_breads WHERE id = ? AND user_id = ?');
    $del->execute([$id, (int) $user['id']]);

    sendJson(['message' => 'Bread deleted']);
}
