<?php
declare(strict_types=1);
define('SECURE_ACCESS', true);

header('Content-Type: application/json; charset=utf-8');
// Responses are filtered per user, so they must never be cached by a shared cache.
header('Cache-Control: no-store');
// Deliberately no Access-Control-Allow-Origin: cookie auth is same-origin only.

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

require_once __DIR__ . '/../config/dev-mode.php';
require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../config/auth.php';

// Membership gate: any role in the `shopping` project may use the app at all
// (site admins pass implicitly). Which collections a member actually sees is
// decided per row by shopping_collection_access on top of this.
$user = Auth::requireProjectRole('shopping');

$method     = $_SERVER['REQUEST_METHOD'];
$id         = isset($_GET['id']) ? (int) $_GET['id'] : null;
$collection = isset($_GET['collection']) ? trim((string) $_GET['collection']) : null;
$since      = $_GET['since'] ?? null;
$checked    = $_GET['checked'] ?? null;
$collectionsList     = isset($_GET['collections']);
$collectionRegister  = isset($_GET['collection_register']);
$collectionDelete    = isset($_GET['collection_delete']);
$access              = isset($_GET['access']);

try {
    if ($access) {
        // Grant management is admin only.
        Auth::requireAdmin();
        if ($method === 'GET') {
            if ($collection === null || $collection === '') {
                sendError('Missing collection parameter', 400);
            }
            listAccess($collection);
        } elseif ($method === 'POST') {
            grantAccess($user);
        } elseif ($method === 'DELETE') {
            if ($collection === null || $collection === '') {
                sendError('Missing collection parameter', 400);
            }
            revokeAccess($collection);
        } else {
            sendError('Method not allowed', 405);
        }
    } elseif ($method === 'GET' && $collectionsList) {
        listCollections($user);
    } elseif ($method === 'POST' && $collectionRegister) {
        registerCollection($user);
    } elseif ($method === 'GET') {
        if ($collection === null || $collection === '') {
            sendError('Missing collection parameter', 400);
        }
        requireCollectionAccess($user, $collection);
        listItems($collection, $since);
    } elseif ($method === 'POST') {
        createItem($user);
    } elseif ($method === 'PATCH') {
        if ($id === null) sendError('Missing id parameter', 400);
        patchItem($user, $id);
    } elseif ($method === 'DELETE') {
        if ($collectionDelete) {
            // Deleting a whole list lives in the admin access sheet.
            Auth::requireAdmin();
            if ($collection === null || $collection === '') {
                sendError('Missing collection parameter', 400);
            }
            deleteCollection($collection);
        } elseif ($id !== null) {
            deleteItem($user, $id);
        } elseif ($collection !== null && $collection !== '' && $checked === '1') {
            requireCollectionAccess($user, $collection);
            clearBought($collection);
        } else {
            sendError('DELETE requires ?id= or ?collection=&checked=1', 400);
        }
    } else {
        sendError('Method not allowed', 405);
    }
} catch (Exception $e) {
    error_log('Shopping controller error: ' . $e->getMessage());
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

function jsonBody(): array
{
    // CSRF backstop: cookie-authed write endpoints only accept JSON bodies.
    $contentType = $_SERVER['CONTENT_TYPE'] ?? '';
    if (!str_contains($contentType, 'application/json')) {
        sendError('Expected application/json body', 415);
    }
    $raw = file_get_contents('php://input');
    $json = $raw ? json_decode($raw, true) : null;
    return is_array($json) ? $json : [];
}

function validateCollection(mixed $value): string
{
    if (!is_string($value)) sendError('collection must be a string', 400);
    $value = trim($value);
    if ($value === '' || mb_strlen($value) > 100) {
        sendError('collection must be 1-100 characters', 400);
    }
    return $value;
}

function validateName(mixed $value): string
{
    if (!is_string($value)) sendError('name must be a string', 400);
    $value = trim($value);
    if ($value === '' || mb_strlen($value) > 255) {
        sendError('name must be 1-255 characters', 400);
    }
    return $value;
}

function isAdmin(array $user): bool
{
    return (int) $user['is_admin'] === 1;
}

/** Label stored in added_by; the session user is the source of truth now. */
function addedByLabel(array $user): string
{
    $label = is_string($user['display_name'] ?? null) && trim($user['display_name']) !== ''
        ? trim($user['display_name'])
        : (string) $user['email'];
    return mb_substr($label, 0, 64);
}

function collectionIdByName(string $name): ?int
{
    $stmt = Database::read()->prepare('SELECT id FROM shopping_collections WHERE name = :name');
    $stmt->execute([':name' => $name]);
    $id = $stmt->fetchColumn();
    return $id === false ? null : (int) $id;
}

/** Denies with 403 unless the user is an admin or holds a grant row. */
function requireCollectionAccess(array $user, string $collection): void
{
    if (isAdmin($user)) return;
    $stmt = Database::read()->prepare(
        'SELECT 1
         FROM shopping_collection_access a
         JOIN shopping_collections c ON c.id = a.collection_id
         WHERE c.name = :name AND a.user_id = :user_id'
    );
    $stmt->execute([':name' => $collection, ':user_id' => $user['id']]);
    if ($stmt->fetchColumn() === false) {
        sendError('Forbidden', 403);
    }
}

function insertGrant(int $collectionId, int $userId, ?int $grantedBy): void
{
    Database::write()->prepare(
        'INSERT IGNORE INTO shopping_collection_access (collection_id, user_id, granted_by)
         VALUES (:collection_id, :user_id, :granted_by)'
    )->execute([
        ':collection_id' => $collectionId,
        ':user_id'       => $userId,
        ':granted_by'    => $grantedBy,
    ]);
}

/**
 * Resolves a collection for a write, creating it on first use. A non-admin
 * creator is auto-granted access to their new collection; using an existing
 * collection requires a prior grant.
 */
function ensureCollectionAccess(array $user, string $name): void
{
    if (collectionIdByName($name) !== null) {
        requireCollectionAccess($user, $name);
        return;
    }
    Database::write()->prepare(
        'INSERT IGNORE INTO shopping_collections (name) VALUES (:name)'
    )->execute([':name' => $name]);
    $id = collectionIdByName($name);
    if ($id !== null && !isAdmin($user)) {
        insertGrant($id, (int) $user['id'], (int) $user['id']);
    }
}

function collectionVersion(string $collection): string
{
    $stmt = Database::read()->prepare(
        'SELECT COUNT(*) AS c, COALESCE(UNIX_TIMESTAMP(MAX(updated_at)), 0) AS m
         FROM shopping_items
         WHERE collection = :collection'
    );
    $stmt->execute([':collection' => $collection]);
    $row = $stmt->fetch();
    return ((int) $row['c']) . ':' . ((int) $row['m']);
}

function fetchItem(int $id): ?array
{
    $stmt = Database::read()->prepare(
        'SELECT id, collection, name, checked, added_by, created_at, updated_at
         FROM shopping_items
         WHERE id = :id'
    );
    $stmt->execute([':id' => $id]);
    $row = $stmt->fetch();
    if (!$row) return null;
    $row['id']      = (int) $row['id'];
    $row['checked'] = (int) $row['checked'];
    return $row;
}

// --- Handlers ---

function listCollections(array $user): void
{
    if (isAdmin($user)) {
        $stmt = Database::read()->query(
            'SELECT name FROM shopping_collections ORDER BY name ASC'
        );
    } else {
        $stmt = Database::read()->prepare(
            'SELECT c.name
             FROM shopping_collections c
             JOIN shopping_collection_access a ON a.collection_id = c.id
             WHERE a.user_id = :user_id
             ORDER BY c.name ASC'
        );
        $stmt->execute([':user_id' => $user['id']]);
    }
    $names = array_map(fn($r) => $r['name'], $stmt->fetchAll());
    sendJson(['collections' => $names]);
}

function registerCollection(array $user): void
{
    $body = jsonBody();
    $name = validateCollection($body['name'] ?? null);
    ensureCollectionAccess($user, $name);
    sendJson(['collection' => $name]);
}

function listItems(string $collection, ?string $since): void
{
    $current = collectionVersion($collection);
    if ($since !== null && $since === $current) {
        sendJson(['changed' => false, 'version' => $current]);
    }
    $stmt = Database::read()->prepare(
        'SELECT id, collection, name, checked, added_by, created_at, updated_at
         FROM shopping_items
         WHERE collection = :collection
         ORDER BY checked ASC, created_at ASC, id ASC'
    );
    $stmt->execute([':collection' => $collection]);
    $items = array_map(function ($r) {
        $r['id']      = (int) $r['id'];
        $r['checked'] = (int) $r['checked'];
        return $r;
    }, $stmt->fetchAll());
    sendJson(['items' => $items, 'version' => $current]);
}

function createItem(array $user): void
{
    $body = jsonBody();
    $collection = validateCollection($body['collection'] ?? null);
    $name       = validateName($body['name'] ?? null);

    ensureCollectionAccess($user, $collection);

    $stmt = Database::write()->prepare(
        'INSERT INTO shopping_items (collection, name, added_by)
         VALUES (:collection, :name, :added_by)'
    );
    $stmt->execute([
        ':collection' => $collection,
        ':name'       => $name,
        ':added_by'   => addedByLabel($user),
    ]);
    $id = (int) Database::write()->lastInsertId();
    $item = fetchItem($id);
    sendJson(['item' => $item], 201);
}

function patchItem(array $user, int $id): void
{
    $body = jsonBody();
    if (!array_key_exists('checked', $body)) {
        sendError('Missing checked field', 400);
    }
    $checked = (int) (bool) $body['checked'];

    $item = fetchItem($id);
    if (!$item) sendError('Item not found', 404);
    requireCollectionAccess($user, $item['collection']);

    Database::write()->prepare(
        'UPDATE shopping_items SET checked = :checked WHERE id = :id'
    )->execute([':checked' => $checked, ':id' => $id]);

    $item = fetchItem($id);
    if (!$item) sendError('Item not found', 404);
    sendJson(['item' => $item]);
}

function deleteItem(array $user, int $id): void
{
    $item = fetchItem($id);
    if (!$item) sendError('Item not found', 404);
    requireCollectionAccess($user, $item['collection']);

    $stmt = Database::write()->prepare('DELETE FROM shopping_items WHERE id = :id');
    $stmt->execute([':id' => $id]);
    sendJson(['deleted' => $id]);
}

/**
 * Admin only (gated in the router): drops the collection, its items, and its
 * grants. Grants cascade via FK; items reference by name, so delete them here.
 */
function deleteCollection(string $collection): void
{
    $collectionId = collectionIdByName($collection);
    if ($collectionId === null) sendError('Collection not found', 404);

    $write = Database::write();
    $write->beginTransaction();
    try {
        $write->prepare('DELETE FROM shopping_items WHERE collection = :collection')
            ->execute([':collection' => $collection]);
        $write->prepare('DELETE FROM shopping_collections WHERE id = :id')
            ->execute([':id' => $collectionId]);
        $write->commit();
    } catch (Exception $e) {
        $write->rollBack();
        throw $e;
    }
    sendJson(['deleted' => $collection]);
}

function clearBought(string $collection): void
{
    $stmt = Database::write()->prepare(
        'DELETE FROM shopping_items WHERE collection = :collection AND checked = 1'
    );
    $stmt->execute([':collection' => $collection]);
    sendJson(['cleared' => $stmt->rowCount()]);
}

// --- Access management (admin only, gated above) ---

/** All active users with a `granted` flag for the given collection. */
function listAccess(string $collection): void
{
    $collectionId = collectionIdByName($collection);
    if ($collectionId === null) sendError('Collection not found', 404);

    $stmt = Database::read()->prepare(
        'SELECT u.id, u.display_name, u.email, u.avatar_url, u.is_admin,
                (a.id IS NOT NULL) AS granted
         FROM users u
         LEFT JOIN shopping_collection_access a
             ON a.user_id = u.id AND a.collection_id = :collection_id
         WHERE u.is_active = 1
         ORDER BY u.is_admin DESC, COALESCE(u.display_name, u.email) ASC'
    );
    $stmt->execute([':collection_id' => $collectionId]);
    $users = array_map(function ($r) {
        $r['id']       = (int) $r['id'];
        $r['is_admin'] = (int) $r['is_admin'] === 1;
        $r['granted']  = (int) $r['granted'] === 1;
        return $r;
    }, $stmt->fetchAll());

    sendJson(['collection' => $collection, 'users' => $users]);
}

function grantAccess(array $admin): void
{
    $body = jsonBody();
    $name = validateCollection($body['collection'] ?? null);
    $userId = (int) ($body['user_id'] ?? 0);

    $stmt = Database::read()->prepare('SELECT id FROM users WHERE id = ? AND is_active = 1');
    $stmt->execute([$userId]);
    if ($stmt->fetchColumn() === false) sendError('User not found', 404);

    $collectionId = collectionIdByName($name);
    if ($collectionId === null) sendError('Collection not found', 404);

    insertGrant($collectionId, $userId, (int) $admin['id']);

    // One-stop admin flow: a grant is useless if the user cannot pass the
    // membership gate, so ensure a shopping role exists (never overwrite one).
    Database::write()->prepare(
        'INSERT INTO user_project_roles (user_id, project_id, role, granted_by)
         SELECT :user_id, p.id, :role, :granted_by
         FROM projects p WHERE p.project_key = :project_key
         ON DUPLICATE KEY UPDATE role = role'
    )->execute([
        ':user_id'     => $userId,
        ':role'        => 'member',
        ':granted_by'  => $admin['id'],
        ':project_key' => 'shopping',
    ]);

    sendJson(['granted' => true]);
}

function revokeAccess(string $collection): void
{
    $userId = isset($_GET['user_id']) ? (int) $_GET['user_id'] : 0;
    if ($userId <= 0) sendError('Missing user_id parameter', 400);

    $collectionId = collectionIdByName($collection);
    if ($collectionId === null) sendError('Collection not found', 404);

    Database::write()->prepare(
        'DELETE FROM shopping_collection_access WHERE collection_id = ? AND user_id = ?'
    )->execute([$collectionId, $userId]);

    sendJson(['revoked' => true]);
}
