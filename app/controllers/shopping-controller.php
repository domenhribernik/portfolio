<?php
declare(strict_types=1);
define('SECURE_ACCESS', true);

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, PATCH, DELETE, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

require_once __DIR__ . '/../config/database.php';

$method     = $_SERVER['REQUEST_METHOD'];
$id         = isset($_GET['id']) ? (int) $_GET['id'] : null;
$collection = isset($_GET['collection']) ? trim((string) $_GET['collection']) : null;
$since      = $_GET['since'] ?? null;
$checked    = $_GET['checked'] ?? null;
$collectionsList     = isset($_GET['collections']);
$collectionRegister  = isset($_GET['collection_register']);

try {
    if ($method === 'GET' && $collectionsList) {
        listCollections();
    } elseif ($method === 'POST' && $collectionRegister) {
        registerCollection();
    } elseif ($method === 'GET') {
        if ($collection === null || $collection === '') {
            sendError('Missing collection parameter', 400);
        }
        listItems($collection, $since);
    } elseif ($method === 'POST') {
        createItem();
    } elseif ($method === 'PATCH') {
        if ($id === null) sendError('Missing id parameter', 400);
        patchItem($id);
    } elseif ($method === 'DELETE') {
        if ($id !== null) {
            deleteItem($id);
        } elseif ($collection !== null && $collection !== '' && $checked === '1') {
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

function validateAddedBy(mixed $value): ?string
{
    if ($value === null || $value === '') return null;
    if (!is_string($value)) sendError('added_by must be a string', 400);
    $value = trim($value);
    if (mb_strlen($value) > 64) sendError('added_by too long', 400);
    return $value;
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

function listCollections(): void
{
    $stmt = Database::read()->query(
        'SELECT name FROM shopping_collections ORDER BY name ASC'
    );
    $names = array_map(fn($r) => $r['name'], $stmt->fetchAll());
    sendJson(['collections' => $names]);
}

function registerCollection(): void
{
    $body = readBody();
    $name = validateCollection($body['name'] ?? null);
    Database::write()->prepare(
        'INSERT IGNORE INTO shopping_collections (name) VALUES (:name)'
    )->execute([':name' => $name]);
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

function createItem(): void
{
    $body = readBody();
    $collection = validateCollection($body['collection'] ?? null);
    $name       = validateName($body['name'] ?? null);
    $addedBy    = validateAddedBy($body['added_by'] ?? null);

    // ensure collection is persisted even if this is the first item
    Database::write()->prepare(
        'INSERT IGNORE INTO shopping_collections (name) VALUES (:name)'
    )->execute([':name' => $collection]);

    $stmt = Database::write()->prepare(
        'INSERT INTO shopping_items (collection, name, added_by)
         VALUES (:collection, :name, :added_by)'
    );
    $stmt->execute([
        ':collection' => $collection,
        ':name'       => $name,
        ':added_by'   => $addedBy,
    ]);
    $id = (int) Database::write()->lastInsertId();
    $item = fetchItem($id);
    sendJson(['item' => $item], 201);
}

function patchItem(int $id): void
{
    $body = readBody();
    if (!array_key_exists('checked', $body)) {
        sendError('Missing checked field', 400);
    }
    $checked = (int) (bool) $body['checked'];

    $stmt = Database::write()->prepare(
        'UPDATE shopping_items SET checked = :checked WHERE id = :id'
    );
    $stmt->execute([':checked' => $checked, ':id' => $id]);
    if ($stmt->rowCount() === 0) {
        $existing = fetchItem($id);
        if (!$existing) sendError('Item not found', 404);
    }
    $item = fetchItem($id);
    if (!$item) sendError('Item not found', 404);
    sendJson(['item' => $item]);
}

function deleteItem(int $id): void
{
    $stmt = Database::write()->prepare('DELETE FROM shopping_items WHERE id = :id');
    $stmt->execute([':id' => $id]);
    if ($stmt->rowCount() === 0) sendError('Item not found', 404);
    sendJson(['deleted' => $id]);
}

function clearBought(string $collection): void
{
    $stmt = Database::write()->prepare(
        'DELETE FROM shopping_items WHERE collection = :collection AND checked = 1'
    );
    $stmt->execute([':collection' => $collection]);
    sendJson(['cleared' => $stmt->rowCount()]);
}
