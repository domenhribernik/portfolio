<?php
declare(strict_types=1);
define('SECURE_ACCESS', true);

header('Content-Type: application/json; charset=utf-8');
// Responses are per-user, so they must never be cached by a shared cache.
header('Cache-Control: no-store');
// Deliberately no Access-Control-Allow-Origin: cookie auth is same-origin only.

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

require_once __DIR__ . '/../config/dev-mode.php';
require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../config/auth.php';

// Catch fatal errors (e.g. out-of-memory) that bypass try-catch
register_shutdown_function(function () {
    global $DEV_MODE;
    $err = error_get_last();
    if ($err && in_array($err['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true)) {
        http_response_code(500);
        $msg = ($DEV_MODE ?? false)
            ? 'Fatal error: ' . $err['message'] . ' [' . basename($err['file']) . ':' . $err['line'] . ']'
            : 'Internal server error';
        echo json_encode(['error' => $msg], JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    }
});

$method = $_SERVER['REQUEST_METHOD'];
$id     = isset($_GET['id']) ? (int) $_GET['id'] : null;

try {
    switch ($method) {
        case 'GET':
            if (isset($_GET['all'])) {
                // Admin dashboard list: every tile, incl. inactive, with project info.
                Auth::requireAdmin();
                listAllApps();
            } elseif (isset($_GET['manage'])) {
                // Picker list: every tile the caller MAY show, with on_shelf flags.
                listManageableApps(Auth::requireLogin());
            } else {
                $user = Auth::requireLogin();
                listVisibleApps($user);
            }
            break;
        case 'POST':
            if (isset($_GET['shelf'])) {
                addToShelf(Auth::requireLogin());
            } else {
                Auth::requireAdmin();
                createApp();
            }
            break;
        case 'PUT':
            Auth::requireAdmin();
            if (!$id) {
                sendError('Id is required', 400);
            }
            updateApp($id);
            break;
        case 'DELETE':
            if (isset($_GET['shelf'])) {
                removeFromShelf(Auth::requireLogin());
                break;
            }
            Auth::requireAdmin();
            if (!$id) {
                sendError('Id is required', 400);
            }
            deleteApp($id);
            break;
        default:
            sendError('Method not allowed', 405);
    }
} catch (InvalidArgumentException $e) {
    sendError($e->getMessage(), 400);
} catch (\Throwable $e) {
    global $DEV_MODE;
    error_log('Hub controller error: ' . $e->getMessage() . ' in ' . $e->getFile() . ':' . $e->getLine());
    $msg = ($DEV_MODE ?? false)
        ? get_class($e) . ': ' . $e->getMessage() . ' [' . basename($e->getFile()) . ':' . $e->getLine() . ']'
        : 'Internal server error';
    sendError($msg, 500);
}

// ------------------------------------------------------------------
//  Reads
// ------------------------------------------------------------------

function listVisibleApps(array $user): void
{
    // The shelf is personal: a tile shows only when the user picked it
    // (hub_user_apps row) AND is permitted to see it. Site admins skip the
    // permission branch (mirroring Auth::hasProjectRole's implicit pass) but
    // still curate their own shelf. p.active = 1 keeps semantics identical to
    // Auth::hasProjectRole: roles on disabled projects do not count. A tile
    // with project_id NULL is permitted to any signed-in user (this is also
    // what a tile degrades to via ON DELETE SET NULL if its project row is
    // ever deleted; the hub is navigation, not a security boundary). Picked
    // rows failing the permission branch lie dormant, never leak.
    $stmt = Database::read()->prepare(
        'SELECT h.id, h.name, h.icon, h.gradient, h.url
         FROM hub_apps h
         JOIN hub_user_apps s ON s.app_id = h.id AND s.user_id = ?
         WHERE h.active = 1
           AND (? = 1
                OR h.project_id IS NULL
                OR EXISTS (
                    SELECT 1
                    FROM user_project_roles r
                    JOIN projects p ON p.id = r.project_id
                    WHERE r.user_id = ? AND r.project_id = h.project_id AND p.active = 1))
         ORDER BY h.sort_order ASC, h.id ASC'
    );
    $stmt->execute([$user['id'], (int) $user['is_admin'], $user['id']]);
    sendJson(array_map(fn (array $r) => ['id' => (int) $r['id']] + $r, $stmt->fetchAll()));
}

function listAllApps(): void
{
    $stmt = Database::read()->query(
        'SELECT h.id, h.name, h.icon, h.gradient, h.url, h.sort_order, h.project_id, h.active, h.is_default,
                p.project_key, p.name AS project_name
         FROM hub_apps h
         LEFT JOIN projects p ON p.id = h.project_id
         ORDER BY h.sort_order ASC, h.id ASC'
    );
    $apps = $stmt->fetchAll();
    foreach ($apps as &$a) {
        $a['id']         = (int) $a['id'];
        $a['sort_order'] = (int) $a['sort_order'];
        $a['active']     = (int) $a['active'];
        $a['is_default'] = (int) $a['is_default'];
        $a['project_id'] = $a['project_id'] !== null ? (int) $a['project_id'] : null;
    }
    sendJson($apps);
}

// ------------------------------------------------------------------
//  Shelf (any signed-in user, own rows only)
// ------------------------------------------------------------------

function listManageableApps(array $user): void
{
    // Same permission branch as the shelf query, but WITHOUT the selection
    // join filter: this feeds the picker, so it lists everything addable
    // and flags what is already picked.
    $stmt = Database::read()->prepare(
        'SELECT h.id, h.name, h.icon, h.gradient, h.url,
                (s.id IS NOT NULL) AS on_shelf
         FROM hub_apps h
         LEFT JOIN hub_user_apps s ON s.app_id = h.id AND s.user_id = ?
         WHERE h.active = 1
           AND (? = 1
                OR h.project_id IS NULL
                OR EXISTS (
                    SELECT 1
                    FROM user_project_roles r
                    JOIN projects p ON p.id = r.project_id
                    WHERE r.user_id = ? AND r.project_id = h.project_id AND p.active = 1))
         ORDER BY h.sort_order ASC, h.id ASC'
    );
    $stmt->execute([$user['id'], (int) $user['is_admin'], $user['id']]);
    sendJson(array_map(fn (array $r) => [
        'id'       => (int) $r['id'],
        'name'     => $r['name'],
        'icon'     => $r['icon'],
        'gradient' => $r['gradient'],
        'url'      => $r['url'],
        'on_shelf' => (int) $r['on_shelf'] === 1,
    ], $stmt->fetchAll()));
}

/**
 * True when the user may see this tile: active, and (admin | no project |
 * role in the tile's active project). Same rule as the shelf query's
 * permission branch.
 */
function canSeeTile(array $user, array $tile): bool
{
    if ((int) $tile['active'] !== 1) {
        return false;
    }
    if ((int) $user['is_admin'] === 1 || $tile['project_id'] === null) {
        return true;
    }
    $stmt = Database::read()->prepare(
        'SELECT 1 FROM user_project_roles r
         JOIN projects p ON p.id = r.project_id
         WHERE r.user_id = ? AND r.project_id = ? AND p.active = 1'
    );
    $stmt->execute([$user['id'], (int) $tile['project_id']]);
    return $stmt->fetchColumn() !== false;
}

function addToShelf(array $user): void
{
    $body = jsonBody();
    if (!isset($body['app_id']) || !is_numeric($body['app_id'])) {
        sendError('app_id is required', 400);
    }
    $appId = (int) $body['app_id'];

    $stmt = Database::read()->prepare('SELECT id, project_id, active FROM hub_apps WHERE id = ?');
    $stmt->execute([$appId]);
    $tile = $stmt->fetch();
    if (!$tile || (int) $tile['active'] !== 1) {
        sendError('Tile not found', 404);
    }
    if (!canSeeTile($user, $tile)) {
        sendError('You do not have access to this app', 403);
    }

    // Idempotent: re-adding is a no-op, not an error.
    Database::write()->prepare(
        'INSERT INTO hub_user_apps (user_id, app_id) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE app_id = app_id'
    )->execute([$user['id'], $appId]);
    sendJson(['message' => 'Added to your shelf'], 201);
}

function removeFromShelf(array $user): void
{
    $appId = isset($_GET['app_id']) ? (int) $_GET['app_id'] : 0;
    if ($appId <= 0) {
        sendError('app_id is required', 400);
    }
    // Own row only; no permission check needed to drop something you picked
    // (dormant rows included, they are the user's own data).
    $stmt = Database::write()->prepare('DELETE FROM hub_user_apps WHERE user_id = ? AND app_id = ?');
    $stmt->execute([$user['id'], $appId]);
    if ($stmt->rowCount() === 0) {
        sendError('Tile is not on your shelf', 404);
    }
    sendJson(['message' => 'Removed from your shelf']);
}

// ------------------------------------------------------------------
//  Writes (admin only)
// ------------------------------------------------------------------

function createApp(): void
{
    $fields = validateAppFields(jsonBody(), false);
    try {
        Database::write()->prepare(
            'INSERT INTO hub_apps (name, icon, gradient, url, sort_order, project_id, active, is_default)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        )->execute([
            $fields['name'],
            $fields['icon']       ?? 'fa-solid fa-cube',
            $fields['gradient']   ?? 'linear-gradient(45deg, #d4451f 0%, #f2b705 100%)',
            $fields['url'],
            $fields['sort_order'] ?? 0,
            $fields['project_id'] ?? null,
            $fields['active']     ?? 1,
            $fields['is_default'] ?? 0,
        ]);
    } catch (PDOException $e) {
        if ((int) $e->errorInfo[1] === 1062) {
            sendError('A tile with that name already exists', 409);
        }
        throw $e;
    }
    sendJson(['message' => 'Tile created'], 201);
}

function updateApp(int $id): void
{
    $fields = validateAppFields(jsonBody(), true);
    if ($fields === []) {
        sendError('Nothing to update', 400);
    }

    $updates = [];
    $params = [];
    foreach ($fields as $column => $value) {
        $updates[] = $column . ' = ?';
        $params[] = $value;
    }
    $params[] = $id;

    try {
        $stmt = Database::write()->prepare(
            'UPDATE hub_apps SET ' . implode(', ', $updates) . ' WHERE id = ?'
        );
        $stmt->execute($params);
    } catch (PDOException $e) {
        if ((int) $e->errorInfo[1] === 1062) {
            sendError('A tile with that name already exists', 409);
        }
        throw $e;
    }
    sendJson(['message' => 'Tile updated']);
}

function deleteApp(int $id): void
{
    $stmt = Database::write()->prepare('DELETE FROM hub_apps WHERE id = ?');
    $stmt->execute([$id]);
    if ($stmt->rowCount() === 0) {
        sendError('Tile not found', 404);
    }
    sendJson(['message' => 'Tile deleted']);
}

// ------------------------------------------------------------------
//  Validation
// ------------------------------------------------------------------

/**
 * Validates tile fields from a JSON body and returns a column => value map.
 * When $partial is true (PUT), only the keys present are validated; otherwise
 * (POST) name and url are required.
 */
function validateAppFields(array $body, bool $partial): array
{
    $fields = [];

    if (isset($body['name']) || !$partial) {
        $name = isset($body['name']) && is_string($body['name']) ? trim($body['name']) : '';
        if ($name === '' || mb_strlen($name) > 100) {
            sendError('Name is required (max 100 chars)', 400);
        }
        $fields['name'] = $name;
    }

    if (isset($body['icon'])) {
        $icon = is_string($body['icon']) ? trim($body['icon']) : '';
        // FontAwesome class lists only; blocks markup.
        if (!preg_match('/^[a-z0-9 -]{1,100}$/', $icon)) {
            sendError('Icon must be a FontAwesome class list, e.g. "fa-solid fa-leaf"', 400);
        }
        $fields['icon'] = $icon;
    }

    if (isset($body['gradient'])) {
        $gradient = is_string($body['gradient']) ? trim($body['gradient']) : '';
        // Allows linear-gradient(...) and hex colors; blocks url(), quotes and
        // semicolons as defense in depth (the frontend assigns via style.background).
        if ($gradient === '' || mb_strlen($gradient) > 255
            || !preg_match('/^[a-zA-Z0-9#%(),.\s-]+$/', $gradient)) {
            sendError('Gradient must be a CSS color or linear-gradient(...)', 400);
        }
        $fields['gradient'] = $gradient;
    }

    if (isset($body['url']) || !$partial) {
        $url = isset($body['url']) && is_string($body['url']) ? trim($body['url']) : '';
        // Root-relative (resolved against the site root by the frontend) or https.
        $isRootRelative = str_starts_with($url, '/') && !str_starts_with($url, '//');
        $isHttps = str_starts_with($url, 'https://');
        if ($url === '' || mb_strlen($url) > 255 || (!$isRootRelative && !$isHttps)) {
            sendError('Url must be root-relative like /views/botaniq/ or start with https://', 400);
        }
        $fields['url'] = $url;
    }

    if (isset($body['sort_order'])) {
        if (!is_numeric($body['sort_order'])) {
            sendError('Sort order must be a number', 400);
        }
        $fields['sort_order'] = (int) $body['sort_order'];
    }

    if (isset($body['active'])) {
        $fields['active'] = (int) (bool) $body['active'];
    }

    if (isset($body['is_default'])) {
        $fields['is_default'] = (int) (bool) $body['is_default'];
    }

    if (array_key_exists('project_id', $body)) {
        if ($body['project_id'] === null || $body['project_id'] === '') {
            $fields['project_id'] = null;
        } else {
            if (!is_numeric($body['project_id'])) {
                sendError('Project id must be a number or null', 400);
            }
            $projectId = (int) $body['project_id'];
            $stmt = Database::read()->prepare('SELECT id FROM projects WHERE id = ?');
            $stmt->execute([$projectId]);
            if ($stmt->fetchColumn() === false) {
                sendError('Project not found', 400);
            }
            $fields['project_id'] = $projectId;
        }
    }

    return $fields;
}

// ------------------------------------------------------------------
//  Helpers
// ------------------------------------------------------------------

function jsonBody(): array
{
    // CSRF backstop: write endpoints only accept JSON bodies.
    $contentType = $_SERVER['CONTENT_TYPE'] ?? '';
    if (!str_contains($contentType, 'application/json')) {
        sendError('Expected application/json body', 415);
    }
    $raw = file_get_contents('php://input');
    $json = $raw ? json_decode($raw, true) : null;
    return is_array($json) ? $json : [];
}

function sendJson(mixed $data, int $code = 200): void
{
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

function sendError(string $message, int $code = 400): void
{
    http_response_code($code);
    echo json_encode(['error' => $message], JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}
