<?php
declare(strict_types=1);
define('SECURE_ACCESS', true);

// The house wish list (views/wishlist).
//
// Reads are public: the link is shared with friends who have no account.
// Anyone may claim an item ("I'll bring this"); the claim is proven by a token
// handed back once and stored only as a SHA-256, so undo works from the same
// browser and nothing personal is kept. Items themselves are written only by a
// site admin or a holder of the `write` role on the `wishlist` project.
//
// Held by tests/wishlist-controller.test.php.

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
// No Access-Control-Allow-Origin here: writes are gated by the session cookie,
// and wildcard CORS is incompatible with cookie auth. Consumers are same-origin.

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

require_once __DIR__ . '/../config/dev-mode.php';
require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../config/auth.php';
require_once __DIR__ . '/../services/image-service.php';
require_once __DIR__ . '/wishlist/fetch.php';

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

const PROJECT_KEY = 'wishlist';

// Field caps. Mirrored in views/wishlist/logic.js for the editor's form;
// tests/wishlist-logic.test.mjs fails if the two drift.
const NAME_MAX = 160;
const NOTE_MAX = 2000;
const URL_MAX  = 2048;
const QTY_MAX  = 20;

// Smaller than this on either side is a tracking pixel or a placeholder.
const MIN_PICTURE_PX = 40;

const NO_GD_WARNING = 'Saved without the picture: this server\'s PHP has no GD image extension. '
    . 'Turn on extension=gd in php.ini, restart the server, then run the import again to fill pictures in.';

// An item row with its picture, as every read selects it.
const ITEM_COLUMNS = 'i.id, i.name, i.url, i.note, i.quantity, i.image_id,
    im.uuid AS image_uuid, im.folder AS image_folder, im.mime_type AS image_mime,
    im.width AS image_width, im.height AS image_height';
const IMAGE_JOIN = 'LEFT JOIN images im ON im.id = i.image_id';

$method   = $_SERVER['REQUEST_METHOD'];
$resource = $_GET['resource'] ?? null;

try {
    switch ($method) {
        case 'GET':
            listItems();
            break;
        case 'POST':
            match ($resource) {
                'claim'   => claimItem(),
                'preview' => previewLink(requireEditor()),
                'image'   => uploadImage(requireEditor()),
                null      => createItem(requireEditor()),
                default   => sendError('Unknown resource', 404),
            };
            break;
        case 'PATCH':
            requireEditor();
            updateItem((int) ($_GET['id'] ?? 0));
            break;
        case 'DELETE':
            if ($resource === 'claim') {
                unclaimItem((int) ($_GET['id'] ?? 0));
            }
            requireEditor();
            deleteItem((int) ($_GET['id'] ?? 0));
            break;
        default:
            sendError('Method not allowed', 405);
    }
} catch (\Throwable $e) {
    global $DEV_MODE;
    error_log('Wishlist controller error: ' . $e->getMessage() . ' in ' . $e->getFile() . ':' . $e->getLine());
    $msg = ($DEV_MODE ?? false)
        ? get_class($e) . ': ' . $e->getMessage() . ' [' . basename($e->getFile()) . ':' . $e->getLine() . ']'
        : 'Internal server error';
    sendError($msg, 500);
}

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
    echo json_encode(['error' => $message], JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

function jsonBody(): array
{
    // CSRF backstop: every write endpoint only accepts a JSON body, which a
    // cross-site form cannot send without a CORS preflight.
    $contentType = $_SERVER['CONTENT_TYPE'] ?? '';
    if (!str_contains($contentType, 'application/json')) {
        sendError('Expected application/json body', 415);
    }
    $raw = file_get_contents('php://input');
    $json = $raw ? json_decode($raw, true) : null;
    return is_array($json) ? $json : [];
}

/** Site admins pass implicitly; otherwise the project role `write` or `admin`. */
function canEdit(): bool
{
    return Auth::hasProjectRole(PROJECT_KEY, 'write') || Auth::hasProjectRole(PROJECT_KEY, 'admin');
}

/** The gate on every item write: 401 signed out, 403 without an editing role. */
function requireEditor(): array
{
    $user = Auth::requireLogin();
    if (!canEdit()) {
        sendError('Only the list\'s editors can change it', 403);
    }
    return $user;
}

// ------------------------------------------------------------------
//  Reading
// ------------------------------------------------------------------

/**
 * A fingerprint of everything a guest can see change. Items count their rows
 * (removed ones included) and their newest updated_at, to the millisecond;
 * claims count their rows and their highest id, so an undo followed by a new
 * claim inside one poll interval still reads as a change.
 */
function listVersion(PDO $db): string
{
    $items  = $db->query('SELECT COUNT(*), COALESCE(MAX(updated_at), 0) FROM wishlist_items')->fetch(PDO::FETCH_NUM);
    $claims = $db->query('SELECT COUNT(*), COALESCE(MAX(id), 0) FROM wishlist_claims')->fetch(PDO::FETCH_NUM);
    return substr(hash('sha256', implode('|', array_merge($items, $claims))), 0, 16);
}

function listItems(): void
{
    $db = Database::read();
    $version = listVersion($db);
    if (($_GET['since'] ?? null) === $version) {
        sendJson(['changed' => false, 'version' => $version]);
    }

    $items = $db->query(
        'SELECT ' . ITEM_COLUMNS . ' FROM wishlist_items i ' . IMAGE_JOIN . '
         WHERE i.deleted_at IS NULL
         ORDER BY i.position, i.id'
    )->fetchAll(PDO::FETCH_ASSOC);

    $claims = claimsByItem($db);

    sendJson([
        'items'    => array_map(fn ($row) => formatItem($row, $claims[(int) $row['id']] ?? []), $items),
        'can_edit' => canEdit(),
        'version'  => $version,
    ]);
}

/**
 * Claim ids per item. Only the ids travel: the token hash stays here, so the
 * holder of a claim is whoever kept the token, and nobody else can learn it.
 *
 * @return array<int, int[]>
 */
function claimsByItem(PDO $db, ?int $itemId = null): array
{
    $sql = 'SELECT id, item_id FROM wishlist_claims' . ($itemId !== null ? ' WHERE item_id = ?' : '') . ' ORDER BY id';
    $stmt = $db->prepare($sql);
    $stmt->execute($itemId !== null ? [$itemId] : []);
    $out = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $out[(int) $row['item_id']][] = (int) $row['id'];
    }
    return $out;
}

function formatItem(array $row, array $claims): array
{
    return [
        'id'       => (int) $row['id'],
        'name'     => $row['name'],
        'url'      => $row['url'],
        'note'     => $row['note'],
        'quantity' => (int) $row['quantity'],
        'claims'   => $claims,
        'image'    => $row['image_uuid'] !== null ? formatImage([
            'id'        => $row['image_id'],
            'uuid'      => $row['image_uuid'],
            'folder'    => $row['image_folder'],
            'mime_type' => $row['image_mime'],
            'width'     => $row['image_width'],
            'height'    => $row['image_height'],
        ]) : null,
    ];
}

/**
 * A stored picture as the page needs it. `url` is relative to the site root,
 * because the site is served from a subfolder locally; the page prefixes it.
 */
function formatImage(array $row): array
{
    $ext = match ($row['mime_type']) {
        'image/png' => 'png',
        'image/gif' => 'gif',
        default     => 'jpg',
    };
    return [
        'id'     => (int) $row['id'],
        'url'    => "assets/uploads/{$row['folder']}/{$row['uuid']}.$ext",
        'width'  => $row['width'] !== null ? (int) $row['width'] : null,
        'height' => $row['height'] !== null ? (int) $row['height'] : null,
    ];
}

/** One live item with its claims, as the list sends it, or null. */
function loadItem(PDO $db, int $id): ?array
{
    $stmt = $db->prepare(
        'SELECT ' . ITEM_COLUMNS . ' FROM wishlist_items i ' . IMAGE_JOIN . ' WHERE i.id = ? AND i.deleted_at IS NULL'
    );
    $stmt->execute([$id]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ? formatItem($row, claimsByItem($db, $id)[$id] ?? []) : null;
}

// ------------------------------------------------------------------
//  Claiming: anyone, no account
// ------------------------------------------------------------------

/**
 * "I'll bring this." Open to anyone with the link, so the request is checked
 * the way the login endpoints check theirs: same origin, JSON only. The token
 * is returned exactly once; only its SHA-256 is kept.
 */
function claimItem(): void
{
    Auth::assertSameOrigin();
    $body = jsonBody();
    $itemId = (int) ($body['item_id'] ?? 0);

    // Honeypot: a field no person can see. A bot that fills it is told all is
    // well and nothing is stored, so it learns nothing to adapt to.
    if (trim((string) ($body['website'] ?? '')) !== '') {
        sendJson(['claim' => null], 202);
    }

    $db = Database::write();
    $db->beginTransaction();
    // Lock the item row, so two guests racing for the last unit cannot both win.
    $stmt = $db->prepare('SELECT quantity FROM wishlist_items WHERE id = ? AND deleted_at IS NULL FOR UPDATE');
    $stmt->execute([$itemId]);
    $quantity = $stmt->fetchColumn();
    if ($quantity === false) {
        $db->rollBack();
        sendError('That item is no longer on the list', 404);
    }
    $count = $db->prepare('SELECT COUNT(*) FROM wishlist_claims WHERE item_id = ?');
    $count->execute([$itemId]);
    if ((int) $count->fetchColumn() >= (int) $quantity) {
        $db->rollBack();
        sendError('Someone is already bringing this', 409);
    }

    $token = bin2hex(random_bytes(32));
    $db->prepare('INSERT INTO wishlist_claims (item_id, token_hash) VALUES (?, ?)')
        ->execute([$itemId, hash('sha256', $token)]);
    $claimId = (int) $db->lastInsertId();
    $db->commit();

    sendJson(['claim' => ['id' => $claimId, 'token' => $token], 'item' => loadItem($db, $itemId)], 201);
}

/**
 * Undo. The browser that claimed proves it with its token; an editor may
 * reset any claim without one (a guest who changed their mind on another
 * phone asks the owner).
 */
function unclaimItem(int $claimId): void
{
    Auth::assertSameOrigin();
    $body = jsonBody();
    $token = (string) ($body['token'] ?? '');

    $db = Database::write();
    $stmt = $db->prepare('SELECT item_id, token_hash FROM wishlist_claims WHERE id = ?');
    $stmt->execute([$claimId]);
    $claim = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$claim) {
        sendError('That claim is already gone', 404);
    }

    $holder = $token !== '' && hash_equals($claim['token_hash'], hash('sha256', $token));
    if (!$holder && !canEdit()) {
        sendError('Only the person who claimed this can undo it', 403);
    }

    $db->prepare('DELETE FROM wishlist_claims WHERE id = ?')->execute([$claimId]);
    sendJson(['item' => loadItem($db, (int) $claim['item_id'])]);
}

// ------------------------------------------------------------------
//  Editing the list
// ------------------------------------------------------------------

/**
 * The rules of a savable item, applied to the merged result of an edit, so a
 * PATCH that touches one field still cannot leave the row invalid. Mirrors
 * validateDraft() in views/wishlist/logic.js. Answers 422 on the first problem.
 *
 * A link becomes a tappable href for every guest, so anything but http(s) is
 * refused rather than escaped; "shop.de/thing" is read as https.
 */
function validatedFields(array $draft): array
{
    $name = trim((string) ($draft['name'] ?? ''));
    if ($name === '') {
        sendError('Give it a name.', 422);
    }
    if (mb_strlen($name) > NAME_MAX) {
        sendError('Keep the name under ' . NAME_MAX . ' characters.', 422);
    }

    $url = trim((string) ($draft['url'] ?? ''));
    if ($url === '') {
        $url = null;
    } else {
        if (!preg_match('/^[a-z][a-z0-9+.-]*:/i', $url)) {
            $url = 'https://' . $url;
        }
        $scheme = strtolower((string) parse_url($url, PHP_URL_SCHEME));
        $host   = (string) parse_url($url, PHP_URL_HOST);
        if (!in_array($scheme, ['http', 'https'], true) || !str_contains($host, '.')
            || preg_match('/\s/', $url) || filter_var($url, FILTER_VALIDATE_URL) === false) {
            sendError('That doesn\'t look like a web link.', 422);
        }
        if (strlen($url) > URL_MAX) {
            sendError('That link is too long.', 422);
        }
    }

    $note = trim((string) ($draft['note'] ?? ''));
    $note = $note === '' ? null : $note;
    if ($note !== null && mb_strlen($note) > NOTE_MAX) {
        sendError('Keep the note under ' . NOTE_MAX . ' characters.', 422);
    }

    $qty = $draft['quantity'] ?? 1;
    if (is_string($qty) && ctype_digit($qty)) {
        $qty = (int) $qty;
    }
    if (!is_int($qty) || $qty < 1 || $qty > QTY_MAX) {
        sendError('Quantity is between 1 and ' . QTY_MAX . '.', 422);
    }

    return ['name' => $name, 'url' => $url, 'note' => $note, 'quantity' => $qty];
}

function createItem(array $user): void
{
    $body = jsonBody();
    $fields = validatedFields($body);
    $db = Database::write();

    // The registry import tags each row with where it came from, so running it
    // twice returns what is already there instead of a second copy.
    $sourceKey = trim((string) ($body['source_key'] ?? '')) ?: null;
    if ($sourceKey !== null) {
        $stmt = $db->prepare('SELECT id FROM wishlist_items WHERE source_key = ?');
        $stmt->execute([$sourceKey]);
        $existing = $stmt->fetchColumn();
        if ($existing !== false) {
            // Already imported. If its picture failed last time, try again,
            // but never replace a picture the item already has.
            $warning = null;
            $current = $db->prepare('SELECT image_id FROM wishlist_items WHERE id = ?');
            $current->execute([(int) $existing]);
            if ($current->fetchColumn() === null && trim((string) ($body['image_url'] ?? '')) !== '') {
                [$imageId, $changed, $warning] = pictureFor($db, ['image_url' => $body['image_url']], null);
                if ($changed) {
                    $db->prepare('UPDATE wishlist_items SET image_id = ? WHERE id = ?')->execute([$imageId, (int) $existing]);
                }
            }
            sendJson(array_filter(['item' => loadItem($db, (int) $existing), 'warning' => $warning], fn ($v) => $v !== null));
        }
    }

    [$imageId, , $warning] = pictureFor($db, $body, null);

    $position = (int) $db->query('SELECT COALESCE(MAX(position), 0) + 1 FROM wishlist_items')->fetchColumn();
    $db->prepare(
        'INSERT INTO wishlist_items (name, url, note, quantity, image_id, position, source_key, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )->execute([
        $fields['name'], $fields['url'], $fields['note'], $fields['quantity'],
        $imageId, $position, $sourceKey, (int) $user['id'],
    ]);
    sendJson(array_filter([
        'item'    => loadItem($db, (int) $db->lastInsertId()),
        'warning' => $warning,
    ], fn ($v) => $v !== null), 201);
}

/**
 * The picture an item should end up with: [image_id, changed, warning].
 *
 *   image_id: null   removes the picture
 *   image_id: n      an upload from ?resource=image
 *   image_url: "…"   a remote picture, fetched now and stored as a local copy,
 *                    so no guest's browser ever asks a shop for it
 *
 * A remote picture that cannot be fetched does not fail the save: the item
 * keeps what it had, and the warning tells the editor to upload one instead.
 */
function pictureFor(PDO $db, array $body, ?int $current): array
{
    if (array_key_exists('image_id', $body)) {
        if ($body['image_id'] === null) {
            return [null, true, null];
        }
        $id = (int) $body['image_id'];
        $stmt = $db->prepare('SELECT id FROM images WHERE id = ? AND folder = ?');
        $stmt->execute([$id, PROJECT_KEY]);
        if ($stmt->fetchColumn() === false) {
            sendError('That picture is not available.', 422);
        }
        return [$id, true, null];
    }

    $url = trim((string) ($body['image_url'] ?? ''));
    if ($url === '') {
        return [$current, false, null];
    }
    if (!imagesSupported()) {
        return [$current, false, NO_GD_WARNING];
    }
    try {
        $fetched = WishlistFetch::get($url, WishlistFetch::IMAGE_MAX_BYTES, 'image/');
        return [storePicture($db, $fetched['body'], basename((string) parse_url($url, PHP_URL_PATH))), true, null];
    } catch (\Throwable $e) {
        // Whatever went wrong with the picture, the item itself still saves.
        error_log('Wishlist picture failed for ' . $url . ': ' . $e->getMessage());
        return [$current, false, 'Saved without the picture: it could not be fetched. Upload one instead.'];
    }
}

/**
 * Pictures are resized and re-encoded with GD. A stock XAMPP ships with
 * extension=gd commented out in php.ini, and without it every picture would
 * die mid-save; checking first turns that into a plain warning.
 */
function imagesSupported(): bool
{
    return function_exists('imagecreatefromstring');
}

/**
 * Resize, re-encode as JPEG (which also strips metadata), store, register.
 * Anything under MIN_PICTURE_PX on a side is a tracking pixel or a
 * placeholder, never a product, and is refused.
 */
function storePicture(PDO $db, string $bytes, string $originalName): int
{
    $size = @getimagesizefromstring($bytes);
    if ($size === false || $size[0] < MIN_PICTURE_PX || $size[1] < MIN_PICTURE_PX) {
        throw new InvalidArgumentException('Not a usable picture');
    }
    $prepared = ImageService::prepare($bytes, ['size' => 'medium', 'format' => 'jpeg']);
    $stored = ImageService::store($prepared, PROJECT_KEY);
    $db->prepare(
        'INSERT INTO images (uuid, folder, original_name, mime_type, width, height, file_size)
         VALUES (?, ?, ?, ?, ?, ?, ?)'
    )->execute([
        $stored['uuid'], $stored['folder'], mb_substr($originalName, 0, 255) ?: null,
        $stored['mime'], $stored['width'], $stored['height'], $stored['file_size'],
    ]);
    return (int) $db->lastInsertId();
}

/** A picture no live or removed item points at any more goes, file and row. */
function dropPictureIfUnused(PDO $db, ?int $imageId): void
{
    if ($imageId === null) return;
    $stmt = $db->prepare('SELECT COUNT(*) FROM wishlist_items WHERE image_id = ?');
    $stmt->execute([$imageId]);
    if ((int) $stmt->fetchColumn() > 0) return;

    $stmt = $db->prepare('SELECT uuid, folder, mime_type FROM images WHERE id = ? AND folder = ?');
    $stmt->execute([$imageId, PROJECT_KEY]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row) return;
    try {
        ImageService::remove($row['uuid'], $row['folder'], (string) $row['mime_type']);
    } catch (RuntimeException $e) {
        // The file is already gone; the row still should be.
    }
    $db->prepare('DELETE FROM images WHERE id = ?')->execute([$imageId]);
}

/** A photo from the editor's phone, stored and returned for the next save. */
function uploadImage(array $user): void
{
    if (!isset($_FILES['image'])) {
        sendError('Choose a photo to upload.', 400);
    }
    if (!imagesSupported()) {
        sendError('This server\'s PHP has no GD image extension, so photos can\'t be processed. Turn on extension=gd in php.ini.', 503);
    }
    try {
        $prepared = ImageService::prepareFromUpload($_FILES['image'], ['size' => 'medium', 'format' => 'jpeg']);
    } catch (InvalidArgumentException $e) {
        sendError($e->getMessage(), 422);
    }
    $stored = ImageService::store($prepared, PROJECT_KEY);
    $db = Database::write();
    $db->prepare(
        'INSERT INTO images (uuid, folder, original_name, mime_type, width, height, file_size)
         VALUES (?, ?, ?, ?, ?, ?, ?)'
    )->execute([
        $stored['uuid'], $stored['folder'], mb_substr((string) ($_FILES['image']['name'] ?? ''), 0, 255) ?: null,
        $stored['mime'], $stored['width'], $stored['height'], $stored['file_size'],
    ]);
    $id = (int) $db->lastInsertId();
    sendJson([
        'image_id' => $id,
        'image'    => formatImage(['id' => $id, 'mime_type' => $stored['mime']] + $stored),
    ], 201);
}

/**
 * Auto-fill: a pasted link read for a name and a picture. The picture URL is
 * returned for the editor's own preview only; it is fetched and copied here
 * when the item is saved.
 */
function previewLink(array $user): void
{
    $body = jsonBody();
    $url = trim((string) ($body['url'] ?? ''));
    if ($url !== '' && !preg_match('/^[a-z][a-z0-9+.-]*:/i', $url)) {
        $url = 'https://' . $url;
    }
    $fallback = WishlistFetch::amazonFallback($url);
    try {
        $page = WishlistFetch::get($url, WishlistFetch::PAGE_MAX_BYTES);
        $found = WishlistFetch::parse($page['body'], $page['url']);
        // A share link from the Amazon app (amzn.eu/d/…) only becomes an
        // Amazon product URL after its redirect.
        $fallback ??= WishlistFetch::amazonFallback($page['url']);
    } catch (WishlistFetchRefused $e) {
        sendError($e->getMessage(), 422);
    } catch (WishlistFetchFailed $e) {
        if ($fallback === null) {
            sendError($e->getMessage(), 502);
        }
        $found = ['title' => null, 'image_url' => null];
    }

    // Amazon walls its pages off from servers; the link itself still names
    // the product and addresses its picture.
    if ($fallback !== null) {
        $found['title'] ??= $fallback['title'];
        if ($found['image_url'] === null && isPicture($fallback['image_url'])) {
            $found['image_url'] = $fallback['image_url'];
        }
    }
    sendJson($found);
}

/** True when a URL serves a real picture, not an error page or a 1x1 pixel. */
function isPicture(string $url): bool
{
    try {
        $fetched = WishlistFetch::get($url, WishlistFetch::IMAGE_MAX_BYTES, 'image/');
    } catch (WishlistFetchRefused | WishlistFetchFailed $e) {
        return false;
    }
    $size = @getimagesizefromstring($fetched['body']);
    return $size !== false && $size[0] >= MIN_PICTURE_PX && $size[1] >= MIN_PICTURE_PX;
}

function updateItem(int $id): void
{
    $body = jsonBody();
    $db = Database::write();
    $stmt = $db->prepare('SELECT name, url, note, quantity, image_id, deleted_at FROM wishlist_items WHERE id = ?');
    $stmt->execute([$id]);
    $current = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$current) {
        sendError('That item is no longer on the list', 404);
    }

    // Undo of a removal.
    if (!empty($body['restore'])) {
        $db->prepare('UPDATE wishlist_items SET deleted_at = NULL WHERE id = ?')->execute([$id]);
        sendJson(['item' => loadItem($db, $id)]);
    }
    if ($current['deleted_at'] !== null) {
        sendError('That item is no longer on the list', 404);
    }

    $merged = array_merge(
        ['name' => $current['name'], 'url' => $current['url'], 'note' => $current['note'], 'quantity' => (int) $current['quantity']],
        array_intersect_key($body, array_flip(['name', 'url', 'note', 'quantity']))
    );
    $fields = validatedFields($merged);
    $oldImage = $current['image_id'] !== null ? (int) $current['image_id'] : null;
    [$imageId, $changed, $warning] = pictureFor($db, $body, $oldImage);

    $db->prepare('UPDATE wishlist_items SET name = ?, url = ?, note = ?, quantity = ?, image_id = ? WHERE id = ?')
        ->execute([$fields['name'], $fields['url'], $fields['note'], $fields['quantity'], $imageId, $id]);
    if ($changed && $oldImage !== $imageId) {
        dropPictureIfUnused($db, $oldImage);
    }
    sendJson(array_filter(['item' => loadItem($db, $id), 'warning' => $warning], fn ($v) => $v !== null));
}

/** Soft delete, so the editor's Undo can bring the item back. */
function deleteItem(int $id): void
{
    $db = Database::write();
    $stmt = $db->prepare('UPDATE wishlist_items SET deleted_at = NOW() WHERE id = ? AND deleted_at IS NULL');
    $stmt->execute([$id]);
    if ($stmt->rowCount() === 0) {
        sendError('That item is no longer on the list', 404);
    }
    sendJson(['deleted' => $id]);
}
