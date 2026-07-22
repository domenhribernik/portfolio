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
                // The personal shelf: the caller's folders + the tiles they picked.
                sendJson(buildShelfPayload(Auth::requireLogin()));
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
            // Per-user arrangement (order + folders); runs before the admin gate.
            if (isset($_GET['layout'])) {
                saveLayout(Auth::requireLogin());
                break;
            }
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
    error_log('Dashboard controller error: ' . $e->getMessage() . ' in ' . $e->getFile() . ':' . $e->getLine());
    $msg = ($DEV_MODE ?? false)
        ? get_class($e) . ': ' . $e->getMessage() . ' [' . basename($e->getFile()) . ':' . $e->getLine() . ']'
        : 'Internal server error';
    sendError($msg, 500);
}

// ------------------------------------------------------------------
//  Reads
// ------------------------------------------------------------------

/**
 * The personal shelf, shared by the shelf GET and the layout PUT response:
 * { folders: [{id, name, position}], apps: [{id, name, icon, gradient, url,
 * folder_id, position}] }. Same permission branch as the picker: a tile shows
 * only when the user picked it (dashboard_user_apps row) AND is permitted to
 * see it. Site admins skip the permission branch but still curate their own
 * shelf. Picked rows failing the permission branch lie dormant, never leak.
 * Apps are pre-sorted by position, then catalog sort_order, then id, so a
 * never-arranged shelf (all positions 0) matches the old admin ordering and
 * the client can rely on a stable sort by position alone.
 */
function buildShelfPayload(array $user): array
{
    $stmt = Database::read()->prepare(
        'SELECT h.id, h.name, h.icon, h.gradient, h.url, s.folder_id, s.position
         FROM dashboard_apps h
         JOIN dashboard_user_apps s ON s.app_id = h.id AND s.user_id = ?
         WHERE h.active = 1
           AND (? = 1
                OR h.project_id IS NULL
                OR EXISTS (
                    SELECT 1
                    FROM user_project_roles r
                    JOIN projects p ON p.id = r.project_id
                    WHERE r.user_id = ? AND r.project_id = h.project_id AND p.active = 1))
         ORDER BY s.position ASC, h.sort_order ASC, h.id ASC'
    );
    $stmt->execute([$user['id'], (int) $user['is_admin'], $user['id']]);
    $apps = array_map(fn (array $r) => [
        'id'        => (int) $r['id'],
        'name'      => $r['name'],
        'icon'      => $r['icon'],
        'gradient'  => $r['gradient'],
        'url'       => $r['url'],
        'folder_id' => $r['folder_id'] !== null ? (int) $r['folder_id'] : null,
        'position'  => (int) $r['position'],
    ], $stmt->fetchAll());

    $fstmt = Database::read()->prepare(
        'SELECT id, name, position FROM dashboard_folders WHERE user_id = ? ORDER BY position ASC, id ASC'
    );
    $fstmt->execute([$user['id']]);
    $folders = array_map(fn (array $r) => [
        'id'       => (int) $r['id'],
        'name'     => $r['name'],
        'position' => (int) $r['position'],
    ], $fstmt->fetchAll());

    return ['folders' => $folders, 'apps' => $apps];
}

function listAllApps(): void
{
    $stmt = Database::read()->query(
        'SELECT h.id, h.name, h.icon, h.gradient, h.url, h.sort_order, h.project_id, h.active, h.is_default,
                p.project_key, p.name AS project_name
         FROM dashboard_apps h
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
         FROM dashboard_apps h
         LEFT JOIN dashboard_user_apps s ON s.app_id = h.id AND s.user_id = ?
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

    $stmt = Database::read()->prepare('SELECT id, project_id, active FROM dashboard_apps WHERE id = ?');
    $stmt->execute([$appId]);
    $tile = $stmt->fetch();
    if (!$tile || (int) $tile['active'] !== 1) {
        sendError('Tile not found', 404);
    }
    if (!canSeeTile($user, $tile)) {
        sendError('You do not have access to this app', 403);
    }

    // A newly picked tile lands at the end of the root grid: one past the
    // highest position among the caller's current root items (folders + root
    // apps). Re-adding is idempotent and leaves the existing placement alone.
    $posStmt = Database::read()->prepare(
        'SELECT COALESCE(MAX(pos), -1) + 1 FROM (
             SELECT position AS pos FROM dashboard_user_apps WHERE user_id = ? AND folder_id IS NULL
             UNION ALL
             SELECT position AS pos FROM dashboard_folders WHERE user_id = ?
         ) t'
    );
    $posStmt->execute([$user['id'], $user['id']]);
    $nextPos = (int) $posStmt->fetchColumn();

    Database::write()->prepare(
        'INSERT INTO dashboard_user_apps (user_id, app_id, position) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE app_id = app_id'
    )->execute([$user['id'], $appId, $nextPos]);
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
    $stmt = Database::write()->prepare('DELETE FROM dashboard_user_apps WHERE user_id = ? AND app_id = ?');
    $stmt->execute([$user['id'], $appId]);
    if ($stmt->rowCount() === 0) {
        sendError('Tile is not on your shelf', 404);
    }
    sendJson(['message' => 'Removed from your shelf']);
}

// ------------------------------------------------------------------
//  Layout (any signed-in user, own arrangement only)
// ------------------------------------------------------------------

/**
 * Saves the caller's full shelf arrangement in one transaction: creates the
 * payload's new folders (temp string ids -> real ids), renames/repositions the
 * caller's existing folders, moves each shelf app into a folder (or the root)
 * at its position, then dissolves the caller's folders that are absent from
 * the payload and hold no member rows. Folders holding dormant members (rows
 * the client never saw because the tile is not currently permitted) survive.
 * Apps not on the caller's shelf are ignored; an unknown folder ref is a 400.
 * Responds with the canonical shelf payload plus a `created` map of every temp
 * id -> real id so the client rewrites its temp folder ids in place.
 */
function saveLayout(array $user): void
{
    $body      = jsonBody();
    $foldersIn = isset($body['folders']) && is_array($body['folders']) ? $body['folders'] : [];
    $appsIn    = isset($body['apps']) && is_array($body['apps']) ? $body['apps'] : [];

    if (count($foldersIn) > 100 || count($appsIn) > 500) {
        throw new InvalidArgumentException('Layout is too large');
    }

    $db = Database::write();
    $db->beginTransaction();
    try {
        // Folders the caller currently owns (before this save).
        $stmt = $db->prepare('SELECT id FROM dashboard_folders WHERE user_id = ?');
        $stmt->execute([$user['id']]);
        $ownFolderSet = array_flip(array_map('intval', array_column($stmt->fetchAll(), 'id')));

        $tempMap    = [];   // "new-1" => real id (folders created this request)
        $keepFolder = [];   // real id => true (folders present in the payload)

        foreach ($foldersIn as $f) {
            if (!is_array($f) || !array_key_exists('id', $f)) {
                throw new InvalidArgumentException('Folder entry is missing an id');
            }
            $name = isset($f['name']) && is_string($f['name']) ? trim($f['name']) : '';
            if ($name === '' || mb_strlen($name) > 60) {
                throw new InvalidArgumentException('Folder name is required (max 60 chars)');
            }
            $position = isset($f['position']) && is_numeric($f['position']) ? max(0, (int) $f['position']) : 0;

            $ref = $f['id'];
            if (is_string($ref) && !is_numeric($ref)) {
                $ins = $db->prepare('INSERT INTO dashboard_folders (user_id, name, position) VALUES (?, ?, ?)');
                $ins->execute([$user['id'], $name, $position]);
                $realId = (int) $db->lastInsertId();
                $tempMap[$ref]        = $realId;
                $keepFolder[$realId]  = true;
            } elseif (is_numeric($ref)) {
                $realId = (int) $ref;
                if (!isset($ownFolderSet[$realId])) {
                    throw new InvalidArgumentException('Folder not found');
                }
                $upd = $db->prepare('UPDATE dashboard_folders SET name = ?, position = ? WHERE id = ? AND user_id = ?');
                $upd->execute([$name, $position, $realId, $user['id']]);
                $keepFolder[$realId] = true;
            } else {
                throw new InvalidArgumentException('Folder id must be an integer or a new-folder string');
            }
        }

        // Apps currently on the caller's shelf (own rows).
        $stmt = $db->prepare('SELECT app_id FROM dashboard_user_apps WHERE user_id = ?');
        $stmt->execute([$user['id']]);
        $shelfAppSet = array_flip(array_map('intval', array_column($stmt->fetchAll(), 'app_id')));

        $updApp = $db->prepare(
            'UPDATE dashboard_user_apps SET folder_id = ?, position = ? WHERE user_id = ? AND app_id = ?'
        );
        foreach ($appsIn as $a) {
            if (!is_array($a) || !isset($a['app_id']) || !is_numeric($a['app_id'])) {
                throw new InvalidArgumentException('App entry is missing an app_id');
            }
            $appId = (int) $a['app_id'];
            if (!isset($shelfAppSet[$appId])) {
                continue; // not on the shelf: silently ignore
            }
            $position = isset($a['position']) && is_numeric($a['position']) ? max(0, (int) $a['position']) : 0;

            $folderId = null;
            if (array_key_exists('folder_id', $a) && $a['folder_id'] !== null) {
                $fref = $a['folder_id'];
                if (is_string($fref) && !is_numeric($fref)) {
                    if (!isset($tempMap[$fref])) {
                        throw new InvalidArgumentException('App references an unknown folder');
                    }
                    $folderId = $tempMap[$fref];
                } elseif (is_numeric($fref)) {
                    $rid = (int) $fref;
                    if (!isset($keepFolder[$rid])) {
                        throw new InvalidArgumentException('App references an unknown folder');
                    }
                    $folderId = $rid;
                } else {
                    throw new InvalidArgumentException('App references an unknown folder');
                }
            }
            $updApp->execute([$folderId, $position, $user['id'], $appId]);
        }

        // Dissolve: drop the caller's folders that this payload omitted, but
        // only when no member rows remain. A folder still holding dormant rows
        // (apps the client could not see) survives and reappears with them.
        $countStmt = $db->prepare('SELECT COUNT(*) FROM dashboard_user_apps WHERE user_id = ? AND folder_id = ?');
        $delStmt   = $db->prepare('DELETE FROM dashboard_folders WHERE id = ? AND user_id = ?');
        foreach (array_keys($ownFolderSet) as $fid) {
            if (isset($keepFolder[$fid])) {
                continue;
            }
            $countStmt->execute([$user['id'], $fid]);
            if ((int) $countStmt->fetchColumn() === 0) {
                $delStmt->execute([$fid, $user['id']]);
            }
        }

        $db->commit();
    } catch (\Throwable $e) {
        $db->rollBack();
        throw $e;
    }

    // Cast the created-folder map to string keys so json_encode emits an object.
    $created = [];
    foreach ($tempMap as $temp => $realId) {
        $created[(string) $temp] = $realId;
    }
    sendJson(buildShelfPayload($user) + ['created' => (object) $created]);
}

// ------------------------------------------------------------------
//  Writes (admin only)
// ------------------------------------------------------------------

function createApp(): void
{
    $fields = validateAppFields(jsonBody(), false);
    try {
        Database::write()->prepare(
            'INSERT INTO dashboard_apps (name, icon, gradient, url, sort_order, project_id, active, is_default)
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
            'UPDATE dashboard_apps SET ' . implode(', ', $updates) . ' WHERE id = ?'
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
    $stmt = Database::write()->prepare('DELETE FROM dashboard_apps WHERE id = ?');
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
