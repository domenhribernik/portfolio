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

// Membership gate: any role in the `list` project may use the app at all
// (site admins pass implicitly). Which collections a member actually sees is
// decided per row by list_collection_access on top of this.
$user = Auth::requireProjectRole('list');

/**
 * The starting vocabulary a collection gets from "Dodaj privzete oznake".
 * Sections are in STORE-WALK ORDER, and that order is also the order items are
 * drawn in, so the list reads like a route through the shop rather than like
 * the order things were typed. Nothing seeds these into a database: they are
 * applied per collection, on request, so a second grocery list gets them the
 * same way the first did.
 */
const DEFAULT_LABELS = [
    'section' => [
        'sadje', 'zelenjava', 'pekarna', 'mlečni izdelki', 'meso in ribe',
        'delikatesa', 'zamrznjeno', 'suha hrana', 'konzerve in omake',
        'prigrizki', 'pijača', 'gospodinjstvo', 'higiena',
    ],
    'shop' => ['Hofer', 'Lidl', 'Špar', 'Mercator', 'Tuš', 'DM'],
];

/** Checked items older than this are archived into history on the next read. */
const ARCHIVE_AFTER_HOURS = 24;

/** Purchases per history page. */
const HISTORY_PAGE = 30;

/** How far back "frequently bought" looks, and how many names it returns. */
const FREQUENT_DAYS  = 90;
const FREQUENT_LIMIT = 8;

$method     = $_SERVER['REQUEST_METHOD'];
$id         = isset($_GET['id']) ? (int) $_GET['id'] : null;
$collection = isset($_GET['collection']) ? trim((string) $_GET['collection']) : null;
$since      = $_GET['since'] ?? null;
$checked    = $_GET['checked'] ?? null;
$collectionsList     = isset($_GET['collections']);
$collectionRegister  = isset($_GET['collection_register']);
$collectionDelete    = isset($_GET['collection_delete']);
$access              = isset($_GET['access']);
$labels              = isset($_GET['labels']);
$history             = isset($_GET['history']);

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
    } elseif ($labels) {
        // Labels belong to whoever can see the collection: any member may
        // curate the vocabulary of a list they are in.
        if ($method === 'GET') {
            $collectionId = requireCollectionByName($user, $collection);
            sendJson(['labels' => fetchLabels($collectionId)]);
        } elseif ($method === 'POST') {
            createLabel($user, isset($_GET['defaults']));
        } elseif ($method === 'PATCH') {
            if ($id === null) sendError('Missing id parameter', 400);
            patchLabel($user, $id);
        } elseif ($method === 'DELETE') {
            if ($id === null) sendError('Missing id parameter', 400);
            deleteLabel($user, $id);
        } else {
            sendError('Method not allowed', 405);
        }
    } elseif ($history) {
        if ($method !== 'GET') sendError('Method not allowed', 405);
        $collectionId = requireCollectionByName($user, $collection);
        listHistory($collectionId);
    } elseif ($method === 'GET' && $collectionsList) {
        listCollections($user);
    } elseif ($method === 'POST' && $collectionRegister) {
        registerCollection($user);
    } elseif ($method === 'GET') {
        $collectionId = requireCollectionByName($user, $collection);
        listItems($collectionId, (string) $collection, $since);
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
            $collectionId = requireCollectionByName($user, $collection);
            archiveChecked($user, $collectionId);
        } else {
            sendError('DELETE requires ?id= or ?collection=&checked=1', 400);
        }
    } else {
        sendError('Method not allowed', 405);
    }
} catch (Exception $e) {
    error_log('List controller error: ' . $e->getMessage());
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

function validateLabelName(mixed $value): string
{
    if (!is_string($value)) sendError('name must be a string', 400);
    $value = trim(preg_replace('/\s+/u', ' ', $value) ?? '');
    if ($value === '' || mb_strlen($value) > 40) {
        sendError('label name must be 1-40 characters', 400);
    }
    return $value;
}

function validateKind(mixed $value): string
{
    if ($value !== 'section' && $value !== 'shop') {
        sendError('kind must be section or shop', 400);
    }
    return $value;
}

/**
 * The identity of a name: lowercased and whitespace-collapsed, diacritics kept
 * (mleko and mléko are different words; "Mleko" and "mleko " are not).
 * MIRRORED in views/list/logic.js as nameKey(); tests/list-logic.test.mjs reads
 * this file and fails if the two implementations drift apart.
 */
function nameKey(string $value): string
{
    return mb_strtolower(trim(preg_replace('/\s+/u', ' ', $value) ?? ''), 'UTF-8');
}

function isAdmin(array $user): bool
{
    return (int) $user['is_admin'] === 1;
}

/** Label stored in added_by/checked_by; the session user is the source of truth. */
function userLabel(array $user): string
{
    $label = is_string($user['display_name'] ?? null) && trim($user['display_name']) !== ''
        ? trim($user['display_name'])
        : (string) $user['email'];
    return mb_substr($label, 0, 64);
}

function collectionIdByName(string $name): ?int
{
    $stmt = Database::read()->prepare('SELECT id FROM list_collections WHERE name = :name');
    $stmt->execute([':name' => $name]);
    $id = $stmt->fetchColumn();
    return $id === false ? null : (int) $id;
}

function collectionNameById(int $id): ?string
{
    $stmt = Database::read()->prepare('SELECT name FROM list_collections WHERE id = :id');
    $stmt->execute([':id' => $id]);
    $name = $stmt->fetchColumn();
    return $name === false ? null : (string) $name;
}

/** Denies with 403 unless the user is an admin or holds a grant row. */
function requireCollectionAccess(array $user, int $collectionId): void
{
    if (isAdmin($user)) return;
    $stmt = Database::read()->prepare(
        'SELECT 1 FROM list_collection_access
         WHERE collection_id = :collection_id AND user_id = :user_id'
    );
    $stmt->execute([':collection_id' => $collectionId, ':user_id' => $user['id']]);
    if ($stmt->fetchColumn() === false) {
        sendError('Forbidden', 403);
    }
}

/**
 * Resolves a client-sent collection NAME to its id and checks the grant.
 * A missing collection is 403, not 404: whether a list exists is itself
 * private, and a 404 would let a member probe for other people's list names.
 */
function requireCollectionByName(array $user, ?string $name): int
{
    if ($name === null || $name === '') {
        sendError('Missing collection parameter', 400);
    }
    $collectionId = collectionIdByName($name);
    if ($collectionId === null) sendError('Forbidden', 403);
    requireCollectionAccess($user, $collectionId);
    return $collectionId;
}

function insertGrant(int $collectionId, int $userId, ?int $grantedBy): void
{
    Database::write()->prepare(
        'INSERT IGNORE INTO list_collection_access (collection_id, user_id, granted_by)
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
function ensureCollectionAccess(array $user, string $name): int
{
    $id = collectionIdByName($name);
    if ($id !== null) {
        requireCollectionAccess($user, $id);
        return $id;
    }
    Database::write()->prepare(
        'INSERT IGNORE INTO list_collections (name) VALUES (:name)'
    )->execute([':name' => $name]);
    $id = collectionIdByName($name);
    if ($id === null) sendError('Could not create collection', 500);
    if (!isAdmin($user)) {
        insertGrant($id, (int) $user['id'], (int) $user['id']);
    }
    return $id;
}

/**
 * The poll token. Counts plus the newest timestamp, over BOTH items and labels,
 * so renaming a label invalidates every open client the same way adding an item
 * does. The timestamps are millisecond-precision on purpose: at one-second
 * granularity a check landing in the same second as the previous write left
 * this string byte-identical and the change never reached the other phone.
 */
function collectionVersion(int $collectionId): string
{
    $stmt = Database::read()->prepare(
        'SELECT
            (SELECT COUNT(*) FROM list_items WHERE collection_id = :c1) AS ic,
            (SELECT COALESCE(MAX(updated_at), 0) FROM list_items WHERE collection_id = :c2) AS im,
            (SELECT COUNT(*) FROM list_labels WHERE collection_id = :c3) AS lc,
            (SELECT COALESCE(MAX(updated_at), 0) FROM list_labels WHERE collection_id = :c4) AS lm'
    );
    $stmt->execute([':c1' => $collectionId, ':c2' => $collectionId, ':c3' => $collectionId, ':c4' => $collectionId]);
    $row = $stmt->fetch();
    return implode(':', [
        (int) $row['ic'],
        (string) $row['im'],
        (int) $row['lc'],
        (string) $row['lm'],
    ]);
}

function fetchLabels(int $collectionId): array
{
    $stmt = Database::read()->prepare(
        'SELECT id, kind, name, sort_order
         FROM list_labels
         WHERE collection_id = :collection_id
         ORDER BY kind ASC, sort_order ASC, id ASC'
    );
    $stmt->execute([':collection_id' => $collectionId]);
    return array_map(function ($r) {
        $r['id']         = (int) $r['id'];
        $r['sort_order'] = (int) $r['sort_order'];
        return $r;
    }, $stmt->fetchAll());
}

/** id => ['kind' => ..., 'name' => ...] for every label of a collection. */
function labelMap(int $collectionId): array
{
    $out = [];
    foreach (fetchLabels($collectionId) as $label) {
        $out[$label['id']] = $label;
    }
    return $out;
}

/**
 * Validates a label selection against the item's own collection and writes it.
 * Two rules, both enforced here rather than in the client: a label from another
 * collection is never attachable, and an item has at most one section.
 */
function applyItemLabels(int $itemId, int $collectionId, ?int $sectionId, ?array $shopIds): void
{
    if ($sectionId === null && $shopIds === null) return;

    $known = labelMap($collectionId);
    $wanted = [];

    if ($sectionId !== null && $sectionId !== 0) {
        if (!isset($known[$sectionId]) || $known[$sectionId]['kind'] !== 'section') {
            sendError('Unknown section label for this collection', 400);
        }
        $wanted[] = $sectionId;
    }
    if ($shopIds !== null) {
        $seen = [];
        foreach ($shopIds as $raw) {
            $shopId = (int) $raw;
            if (!isset($known[$shopId]) || $known[$shopId]['kind'] !== 'shop') {
                sendError('Unknown shop label for this collection', 400);
            }
            if (isset($seen[$shopId])) continue;
            $seen[$shopId] = true;
            $wanted[] = $shopId;
        }
    }

    $write = Database::write();
    // Replace only the kinds this request actually addressed, so a PATCH that
    // sets shops alone does not silently drop the section.
    $kinds = [];
    if ($sectionId !== null) $kinds[] = 'section';
    if ($shopIds !== null)   $kinds[] = 'shop';
    if ($kinds) {
        $in = implode(',', array_fill(0, count($kinds), '?'));
        $stmt = $write->prepare(
            "DELETE il FROM list_item_labels il
             JOIN list_labels l ON l.id = il.label_id
             WHERE il.item_id = ? AND l.kind IN ($in)"
        );
        $stmt->execute(array_merge([$itemId], $kinds));
    }
    if ($wanted) {
        $stmt = $write->prepare(
            'INSERT IGNORE INTO list_item_labels (item_id, label_id) VALUES (:item_id, :label_id)'
        );
        foreach ($wanted as $labelId) {
            $stmt->execute([':item_id' => $itemId, ':label_id' => $labelId]);
        }
    }
    // A label change is a change to the item, and the poll version is built
    // from list_items.updated_at, so touch the row or the other phone never
    // learns that this item moved to another aisle.
    $write->prepare('UPDATE list_items SET updated_at = CURRENT_TIMESTAMP(3) WHERE id = :id')
        ->execute([':id' => $itemId]);
}

/** item_id => ['section' => ?['id','name'], 'shops' => [...]] */
function itemLabels(int $collectionId, array $itemIds): array
{
    $out = [];
    foreach ($itemIds as $itemId) {
        $out[$itemId] = ['section' => null, 'shops' => []];
    }
    if (!$itemIds) return $out;

    $in = implode(',', array_fill(0, count($itemIds), '?'));
    $stmt = Database::read()->prepare(
        "SELECT il.item_id, l.id, l.kind, l.name, l.sort_order
         FROM list_item_labels il
         JOIN list_labels l ON l.id = il.label_id
         WHERE il.item_id IN ($in)
         ORDER BY l.sort_order ASC, l.id ASC"
    );
    $stmt->execute($itemIds);
    foreach ($stmt->fetchAll() as $row) {
        $itemId = (int) $row['item_id'];
        $label = ['id' => (int) $row['id'], 'name' => $row['name'], 'sort_order' => (int) $row['sort_order']];
        if ($row['kind'] === 'section') {
            $out[$itemId]['section'] = $label;
        } else {
            $out[$itemId]['shops'][] = $label;
        }
    }
    return $out;
}

function shapeItem(array $row, string $collectionName, array $labels): array
{
    return [
        'id'                 => (int) $row['id'],
        // The client still addresses lists by name; keep it on the payload.
        'collection'         => $collectionName,
        'name'               => $row['name'],
        'checked'            => (int) $row['checked'],
        'checked_at'         => $row['checked_at'],
        'checked_by'         => $row['checked_by'],
        'checked_by_user_id' => $row['checked_by_user_id'] === null ? null : (int) $row['checked_by_user_id'],
        'added_by'           => $row['added_by'],
        'added_by_user_id'   => $row['added_by_user_id'] === null ? null : (int) $row['added_by_user_id'],
        'section'            => $labels['section'],
        'shops'              => $labels['shops'],
        'created_at'         => $row['created_at'],
        'updated_at'         => $row['updated_at'],
    ];
}

function fetchItem(int $id): ?array
{
    $stmt = Database::read()->prepare(
        'SELECT i.*, c.name AS collection_name
         FROM list_items i
         JOIN list_collections c ON c.id = i.collection_id
         WHERE i.id = :id'
    );
    $stmt->execute([':id' => $id]);
    $row = $stmt->fetch();
    if (!$row) return null;
    $labels = itemLabels((int) $row['collection_id'], [(int) $row['id']]);
    $item = shapeItem($row, (string) $row['collection_name'], $labels[(int) $row['id']]);
    $item['collection_id'] = (int) $row['collection_id'];
    return $item;
}

/**
 * Moves checked items into history. Called with an explicit id list by
 * "počisti", and with null by the read path for anything checked longer than
 * ARCHIVE_AFTER_HOURS ago.
 *
 * The label columns on a purchase are TEXT SNAPSHOTS, so a trip still reads
 * correctly after someone renames or deletes the label it was filed under.
 */
function archiveItems(int $collectionId, ?array $itemIds, ?array $user): int
{
    $write = Database::write();

    $where = 'collection_id = :collection_id AND checked = 1';
    $params = [':collection_id' => $collectionId];
    if ($itemIds !== null) {
        if (!$itemIds) return 0;
        $in = [];
        foreach (array_values($itemIds) as $i => $itemId) {
            $in[] = ':id' . $i;
            $params[':id' . $i] = (int) $itemId;
        }
        $where .= ' AND id IN (' . implode(',', $in) . ')';
    } else {
        $where .= ' AND checked_at IS NOT NULL AND checked_at < (NOW(3) - INTERVAL ' . ARCHIVE_AFTER_HOURS . ' HOUR)';
    }

    $stmt = Database::read()->prepare("SELECT * FROM list_items WHERE $where");
    $stmt->execute($params);
    $rows = $stmt->fetchAll();
    if (!$rows) return 0;

    $ids = array_map(fn($r) => (int) $r['id'], $rows);
    $labels = itemLabels($collectionId, $ids);

    $write->beginTransaction();
    try {
        $insert = $write->prepare(
            'INSERT INTO list_purchases
                (collection_id, name, name_key, section, shops,
                 added_by, added_by_user_id, bought_by, bought_by_user_id,
                 added_at, bought_at)
             VALUES
                (:collection_id, :name, :name_key, :section, :shops,
                 :added_by, :added_by_user_id, :bought_by, :bought_by_user_id,
                 :added_at, :bought_at)'
        );
        foreach ($rows as $row) {
            $itemId = (int) $row['id'];
            $shops = array_map(fn($s) => $s['name'], $labels[$itemId]['shops']);
            // Who bought it is whoever checked it. On an auto-archive nobody is
            // "doing" anything now, so the stored checker stands; falling back
            // to the current reader would credit whoever happened to open the
            // app next.
            $boughtBy = $row['checked_by'] ?? ($user !== null && $itemIds !== null ? userLabel($user) : null);
            $boughtById = $row['checked_by_user_id'] ?? ($user !== null && $itemIds !== null ? (int) $user['id'] : null);
            $insert->execute([
                ':collection_id'     => $collectionId,
                ':name'              => $row['name'],
                ':name_key'          => nameKey((string) $row['name']),
                ':section'           => $labels[$itemId]['section']['name'] ?? null,
                ':shops'             => $shops ? json_encode($shops, JSON_UNESCAPED_UNICODE) : null,
                ':added_by'          => $row['added_by'],
                ':added_by_user_id'  => $row['added_by_user_id'],
                ':bought_by'         => $boughtBy,
                ':bought_by_user_id' => $boughtById,
                ':added_at'          => $row['created_at'],
                ':bought_at'         => $row['checked_at'] ?? $row['updated_at'],
            ]);
        }
        $delIn = implode(',', array_fill(0, count($ids), '?'));
        $write->prepare("DELETE FROM list_items WHERE id IN ($delIn)")->execute($ids);
        $write->commit();
    } catch (Exception $e) {
        $write->rollBack();
        throw $e;
    }
    return count($rows);
}

/**
 * Housekeeping rides the poll path: production has no cron, so anything checked
 * more than a day ago is filed into history the next time somebody opens the
 * list. The cheap SELECT first keeps a 2-second poll from writing every tick.
 */
function sweepStaleChecked(int $collectionId): void
{
    $stmt = Database::read()->prepare(
        'SELECT COUNT(*) FROM list_items
         WHERE collection_id = :collection_id AND checked = 1
           AND checked_at IS NOT NULL
           AND checked_at < (NOW(3) - INTERVAL ' . ARCHIVE_AFTER_HOURS . ' HOUR)'
    );
    $stmt->execute([':collection_id' => $collectionId]);
    if ((int) $stmt->fetchColumn() === 0) return;
    archiveItems($collectionId, null, null);
}

// --- Handlers ---

function listCollections(array $user): void
{
    if (isAdmin($user)) {
        $stmt = Database::read()->query(
            'SELECT name FROM list_collections ORDER BY name ASC'
        );
    } else {
        $stmt = Database::read()->prepare(
            'SELECT c.name
             FROM list_collections c
             JOIN list_collection_access a ON a.collection_id = c.id
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

function listItems(int $collectionId, string $collectionName, ?string $since): void
{
    sweepStaleChecked($collectionId);

    $current = collectionVersion($collectionId);
    if ($since !== null && $since === $current) {
        sendJson(['changed' => false, 'version' => $current]);
    }
    $stmt = Database::read()->prepare(
        'SELECT * FROM list_items
         WHERE collection_id = :collection_id
         ORDER BY checked ASC, created_at ASC, id ASC'
    );
    $stmt->execute([':collection_id' => $collectionId]);
    $rows = $stmt->fetchAll();
    $labels = itemLabels($collectionId, array_map(fn($r) => (int) $r['id'], $rows));
    $items = array_map(fn($r) => shapeItem($r, $collectionName, $labels[(int) $r['id']]), $rows);

    sendJson([
        'items'   => $items,
        'labels'  => fetchLabels($collectionId),
        'version' => $current,
    ]);
}

function createItem(array $user): void
{
    $body = jsonBody();
    $collection = validateCollection($body['collection'] ?? null);
    $name       = validateName($body['name'] ?? null);

    $collectionId = ensureCollectionAccess($user, $collection);

    $stmt = Database::write()->prepare(
        'INSERT INTO list_items (collection_id, name, added_by, added_by_user_id)
         VALUES (:collection_id, :name, :added_by, :added_by_user_id)'
    );
    $stmt->execute([
        ':collection_id'    => $collectionId,
        ':name'             => $name,
        ':added_by'         => userLabel($user),
        ':added_by_user_id' => (int) $user['id'],
    ]);
    $id = (int) Database::write()->lastInsertId();

    applyItemLabels(
        $id,
        $collectionId,
        array_key_exists('section_id', $body) ? normaliseId($body['section_id']) : null,
        array_key_exists('shop_ids', $body) ? normaliseIdList($body['shop_ids']) : null
    );

    $item = fetchItem($id);
    unset($item['collection_id']);
    sendJson(['item' => $item], 201);
}

function normaliseId(mixed $value): ?int
{
    if ($value === null || $value === '' || $value === false) return 0; // explicit clear
    if (!is_numeric($value)) sendError('section_id must be a number or null', 400);
    return (int) $value;
}

function normaliseIdList(mixed $value): array
{
    if ($value === null) return [];
    if (!is_array($value)) sendError('shop_ids must be an array', 400);
    return $value;
}

function patchItem(array $user, int $id): void
{
    $body = jsonBody();
    $touchesChecked = array_key_exists('checked', $body);
    $touchesName    = array_key_exists('name', $body);
    $touchesSection = array_key_exists('section_id', $body);
    $touchesShops   = array_key_exists('shop_ids', $body);
    if (!$touchesChecked && !$touchesName && !$touchesSection && !$touchesShops) {
        sendError('Nothing to update', 400);
    }

    $item = fetchItem($id);
    if (!$item) sendError('Item not found', 404);
    $collectionId = $item['collection_id'];
    requireCollectionAccess($user, $collectionId);

    if ($touchesChecked) {
        $checked = (int) (bool) $body['checked'];
        // Who bought it is whoever ticked it, from the session. Unchecking
        // clears the stamp so an item that comes back onto the list carries no
        // stale claim that somebody already bought it.
        Database::write()->prepare(
            'UPDATE list_items
             SET checked = :checked,
                 checked_at = ' . ($checked ? 'CURRENT_TIMESTAMP(3)' : 'NULL') . ',
                 checked_by = :checked_by,
                 checked_by_user_id = :checked_by_user_id
             WHERE id = :id'
        )->execute([
            ':checked'            => $checked,
            ':checked_by'         => $checked ? userLabel($user) : null,
            ':checked_by_user_id' => $checked ? (int) $user['id'] : null,
            ':id'                 => $id,
        ]);
    }

    if ($touchesName) {
        $name = validateName($body['name']);
        Database::write()->prepare('UPDATE list_items SET name = :name WHERE id = :id')
            ->execute([':name' => $name, ':id' => $id]);
    }

    applyItemLabels(
        $id,
        $collectionId,
        $touchesSection ? normaliseId($body['section_id']) : null,
        $touchesShops ? normaliseIdList($body['shop_ids']) : null
    );

    $item = fetchItem($id);
    if (!$item) sendError('Item not found', 404);
    unset($item['collection_id']);
    sendJson(['item' => $item]);
}

function deleteItem(array $user, int $id): void
{
    $item = fetchItem($id);
    if (!$item) sendError('Item not found', 404);
    requireCollectionAccess($user, $item['collection_id']);

    // Deleting is not buying: a removed item records no purchase. Its label
    // links go with it through the foreign key.
    $stmt = Database::write()->prepare('DELETE FROM list_items WHERE id = :id');
    $stmt->execute([':id' => $id]);
    sendJson(['deleted' => $id]);
}

/**
 * Admin only (gated in the router): drops the collection. Items, labels,
 * purchases and grants all cascade off the collection row.
 */
function deleteCollection(string $collection): void
{
    $collectionId = collectionIdByName($collection);
    if ($collectionId === null) sendError('Collection not found', 404);

    Database::write()->prepare('DELETE FROM list_collections WHERE id = :id')
        ->execute([':id' => $collectionId]);
    sendJson(['deleted' => $collection]);
}

/** "počisti": the checked half becomes a trip in the history. */
function archiveChecked(array $user, int $collectionId): void
{
    $stmt = Database::read()->prepare(
        'SELECT id FROM list_items WHERE collection_id = :collection_id AND checked = 1'
    );
    $stmt->execute([':collection_id' => $collectionId]);
    $ids = array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN));

    $count = archiveItems($collectionId, $ids, $user);
    sendJson(['cleared' => $count, 'archived' => $count]);
}

function listHistory(int $collectionId): void
{
    $before = isset($_GET['before']) ? (int) $_GET['before'] : 0;

    $sql = 'SELECT * FROM list_purchases WHERE collection_id = :collection_id';
    $params = [':collection_id' => $collectionId];
    if ($before > 0) {
        // The cursor has to be the same shape as the sort. Paging on id alone
        // while ordering by bought_at silently repeats rows as soon as the two
        // disagree, which they do the moment an item is auto-archived: its
        // purchase is written now but dated when it was ticked, a day earlier.
        $stmt = Database::read()->prepare(
            'SELECT bought_at FROM list_purchases WHERE id = :id AND collection_id = :collection_id'
        );
        $stmt->execute([':id' => $before, ':collection_id' => $collectionId]);
        $cursor = $stmt->fetchColumn();
        if ($cursor === false) sendError('Unknown history cursor', 400);
        $sql .= ' AND (bought_at, id) < (:cursor_at, :cursor_id)';
        $params[':cursor_at'] = $cursor;
        $params[':cursor_id'] = $before;
    }
    $sql .= ' ORDER BY bought_at DESC, id DESC LIMIT ' . (HISTORY_PAGE + 1);

    $stmt = Database::read()->prepare($sql);
    $stmt->execute($params);
    $rows = $stmt->fetchAll();

    $hasMore = count($rows) > HISTORY_PAGE;
    if ($hasMore) array_pop($rows);

    $purchases = array_map(function ($r) {
        return [
            'id'         => (int) $r['id'],
            'name'       => $r['name'],
            'section'    => $r['section'],
            'shops'      => $r['shops'] ? (json_decode($r['shops'], true) ?: []) : [],
            'added_by'   => $r['added_by'],
            'bought_by'  => $r['bought_by'],
            'bought_at'  => $r['bought_at'],
        ];
    }, $rows);

    sendJson([
        'purchases' => $purchases,
        'has_more'  => $hasMore,
        'frequent'  => frequentPurchases($collectionId),
    ]);
}

/**
 * The names this list buys most often, newest labels attached, for the
 * quick-add row on an empty list. Grouped by name_key so "Mleko" and "mleko "
 * are one entry.
 */
function frequentPurchases(int $collectionId): array
{
    $stmt = Database::read()->prepare(
        'SELECT name_key, COUNT(*) AS times, MAX(id) AS last_id
         FROM list_purchases
         WHERE collection_id = :collection_id
           AND bought_at > (NOW(3) - INTERVAL ' . FREQUENT_DAYS . ' DAY)
         GROUP BY name_key
         ORDER BY times DESC, last_id DESC
         LIMIT ' . FREQUENT_LIMIT
    );
    $stmt->execute([':collection_id' => $collectionId]);
    $groups = $stmt->fetchAll();
    if (!$groups) return [];

    $ids = array_map(fn($g) => (int) $g['last_id'], $groups);
    $in = implode(',', array_fill(0, count($ids), '?'));
    $stmt = Database::read()->prepare("SELECT id, name, section, shops FROM list_purchases WHERE id IN ($in)");
    $stmt->execute($ids);
    $latest = [];
    foreach ($stmt->fetchAll() as $row) {
        $latest[(int) $row['id']] = $row;
    }

    $out = [];
    foreach ($groups as $group) {
        $row = $latest[(int) $group['last_id']] ?? null;
        if (!$row) continue;
        $out[] = [
            'name'    => $row['name'],
            'times'   => (int) $group['times'],
            'section' => $row['section'],
            'shops'   => $row['shops'] ? (json_decode($row['shops'], true) ?: []) : [],
        ];
    }
    return $out;
}

// --- Labels (any member of the collection) ---

function createLabel(array $user, bool $defaults): void
{
    $body = jsonBody();
    $collectionId = requireCollectionByName($user, validateCollection($body['collection'] ?? null));

    if ($defaults) {
        $added = 0;
        $write = Database::write();
        $stmt = $write->prepare(
            'INSERT IGNORE INTO list_labels (collection_id, kind, name, name_key, sort_order, created_by)
             VALUES (:collection_id, :kind, :name, :name_key, :sort_order, :created_by)'
        );
        foreach (DEFAULT_LABELS as $kind => $names) {
            foreach (array_values($names) as $i => $name) {
                $stmt->execute([
                    ':collection_id' => $collectionId,
                    ':kind'          => $kind,
                    ':name'          => $name,
                    ':name_key'      => nameKey($name),
                    ':sort_order'    => $i,
                    ':created_by'    => (int) $user['id'],
                ]);
                $added += $stmt->rowCount();
            }
        }
        sendJson(['labels' => fetchLabels($collectionId), 'added' => $added]);
    }

    $kind = validateKind($body['kind'] ?? null);
    $name = validateLabelName($body['name'] ?? null);
    $key  = nameKey($name);

    $stmt = Database::read()->prepare(
        'SELECT id FROM list_labels
         WHERE collection_id = :collection_id AND kind = :kind AND name_key = :name_key'
    );
    $stmt->execute([':collection_id' => $collectionId, ':kind' => $kind, ':name_key' => $key]);
    $existing = $stmt->fetchColumn();
    if ($existing !== false) {
        // Adding a label that already exists is not an error in a shared list:
        // two people reaching for "mesnica" at once both meant the same thing.
        sendJson(['label' => labelById((int) $existing), 'existed' => true]);
    }

    $stmt = Database::read()->prepare(
        'SELECT COALESCE(MAX(sort_order), -1) + 1 FROM list_labels
         WHERE collection_id = :collection_id AND kind = :kind'
    );
    $stmt->execute([':collection_id' => $collectionId, ':kind' => $kind]);
    $sortOrder = (int) $stmt->fetchColumn();

    Database::write()->prepare(
        'INSERT INTO list_labels (collection_id, kind, name, name_key, sort_order, created_by)
         VALUES (:collection_id, :kind, :name, :name_key, :sort_order, :created_by)'
    )->execute([
        ':collection_id' => $collectionId,
        ':kind'          => $kind,
        ':name'          => $name,
        ':name_key'      => $key,
        ':sort_order'    => $sortOrder,
        ':created_by'    => (int) $user['id'],
    ]);
    sendJson(['label' => labelById((int) Database::write()->lastInsertId())], 201);
}

function labelById(int $id): ?array
{
    $stmt = Database::read()->prepare(
        'SELECT id, collection_id, kind, name, sort_order FROM list_labels WHERE id = :id'
    );
    $stmt->execute([':id' => $id]);
    $row = $stmt->fetch();
    if (!$row) return null;
    return [
        'id'            => (int) $row['id'],
        'collection_id' => (int) $row['collection_id'],
        'kind'          => $row['kind'],
        'name'          => $row['name'],
        'sort_order'    => (int) $row['sort_order'],
    ];
}

function patchLabel(array $user, int $id): void
{
    $body = jsonBody();
    $label = labelById($id);
    if (!$label) sendError('Label not found', 404);
    requireCollectionAccess($user, $label['collection_id']);

    $touchesName = array_key_exists('name', $body);
    $touchesSort = array_key_exists('sort_order', $body);
    if (!$touchesName && !$touchesSort) sendError('Nothing to update', 400);

    if ($touchesName) {
        $name = validateLabelName($body['name']);
        $key  = nameKey($name);
        $stmt = Database::read()->prepare(
            'SELECT id FROM list_labels
             WHERE collection_id = :collection_id AND kind = :kind AND name_key = :name_key AND id <> :id'
        );
        $stmt->execute([
            ':collection_id' => $label['collection_id'],
            ':kind'          => $label['kind'],
            ':name_key'      => $key,
            ':id'            => $id,
        ]);
        if ($stmt->fetchColumn() !== false) {
            sendError('A label with that name already exists', 409);
        }
        Database::write()->prepare(
            'UPDATE list_labels SET name = :name, name_key = :name_key WHERE id = :id'
        )->execute([':name' => $name, ':name_key' => $key, ':id' => $id]);
    }

    if ($touchesSort) {
        Database::write()->prepare('UPDATE list_labels SET sort_order = :sort_order WHERE id = :id')
            ->execute([':sort_order' => (int) $body['sort_order'], ':id' => $id]);
    }

    sendJson(['label' => labelById($id)]);
}

function deleteLabel(array $user, int $id): void
{
    $label = labelById($id);
    if (!$label) sendError('Label not found', 404);
    requireCollectionAccess($user, $label['collection_id']);

    // The links go with it (FK cascade), but the items stay. History keeps its
    // own text snapshot, so past trips still read correctly afterwards.
    Database::write()->prepare('DELETE FROM list_labels WHERE id = :id')->execute([':id' => $id]);
    sendJson(['deleted' => $id]);
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
         LEFT JOIN list_collection_access a
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
    // membership gate, so ensure a list role exists (never overwrite one).
    Database::write()->prepare(
        'INSERT INTO user_project_roles (user_id, project_id, role, granted_by)
         SELECT :user_id, p.id, :role, :granted_by
         FROM projects p WHERE p.project_key = :project_key
         ON DUPLICATE KEY UPDATE role = role'
    )->execute([
        ':user_id'     => $userId,
        ':role'        => 'member',
        ':granted_by'  => $admin['id'],
        ':project_key' => 'list',
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
        'DELETE FROM list_collection_access WHERE collection_id = ? AND user_id = ?'
    )->execute([$collectionId, $userId]);

    sendJson(['revoked' => true]);
}
