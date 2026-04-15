<?php
declare(strict_types=1);
define('SECURE_ACCESS', true);

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../services/image-service.php';

$method = $_SERVER['REQUEST_METHOD'];
$uuid   = isset($_GET['uuid']) ? trim($_GET['uuid']) : null;
$folder = isset($_GET['folder']) ? trim($_GET['folder']) : null;

try {
    switch ($method) {
        case 'GET':
            if ($uuid) {
                getImage($uuid);
            } elseif ($folder) {
                getImagesByFolder($folder);
            } else {
                getAllImages();
            }
            break;
        case 'POST':
            uploadImage();
            break;
        case 'PUT':
            if (!$uuid) {
                sendError('UUID is required', 400);
            }
            updateImage($uuid);
            break;
        case 'DELETE':
            if (!$uuid) {
                sendError('UUID is required', 400);
            }
            deleteImage($uuid);
            break;
        default:
            sendError('Method not allowed', 405);
    }
} catch (InvalidArgumentException $e) {
    sendError($e->getMessage(), 400);
} catch (Exception $e) {
    error_log('Images controller error: ' . $e->getMessage());
    sendError('Internal server error', 500);
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
    echo json_encode(['error' => $message], JSON_UNESCAPED_UNICODE);
    exit;
}

function formatImage(array $row): array
{
    $row['id']        = (int) $row['id'];
    $row['width']     = $row['width']     !== null ? (int) $row['width']     : null;
    $row['height']    = $row['height']    !== null ? (int) $row['height']    : null;
    $row['file_size'] = $row['file_size'] !== null ? (int) $row['file_size'] : null;
    return $row;
}

// ------------------------------------------------------------------
//  CRUD
// ------------------------------------------------------------------

function getAllImages(): void
{
    $stmt = Database::read()->query(
        'SELECT id, uuid, folder, original_name, mime_type, width, height, file_size, uploaded_at
         FROM images ORDER BY uploaded_at DESC'
    );
    sendJson(array_map('formatImage', $stmt->fetchAll()));
}

function getImagesByFolder(string $folder): void
{
    $stmt = Database::read()->prepare(
        'SELECT id, uuid, folder, original_name, mime_type, width, height, file_size, uploaded_at
         FROM images WHERE folder = ? ORDER BY uploaded_at DESC'
    );
    $stmt->execute([$folder]);
    sendJson(array_map('formatImage', $stmt->fetchAll()));
}

function getImage(string $uuid): void
{
    $row = fetchByUuid($uuid);
    if (!$row) {
        sendError('Image not found', 404);
    }
    sendJson(formatImage($row));
}

function uploadImage(): void
{
    if (!isset($_FILES['image'])) {
        sendError('No image file provided', 400);
    }

    $folder = isset($_POST['folder']) ? trim($_POST['folder']) : 'general';

    // Let the service validate, process, and write to disk
    $processed = ImageService::prepareFromUpload($_FILES['image'], [
        'size'       => $_POST['size']       ?? 'medium',
        'format'     => $_POST['format']     ?? 'webp',
        'strip_exif' => ($_POST['strip_exif'] ?? '1') !== '0',
        'quality'    => isset($_POST['quality']) ? (int) $_POST['quality'] : 80,
    ]);

    $stored = ImageService::store($processed, $folder);

    $stmt = Database::write()->prepare(
        'INSERT INTO images (uuid, folder, original_name, mime_type, width, height, file_size)
         VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    $stmt->execute([
        $stored['uuid'],
        $stored['folder'],
        $_FILES['image']['name'] ?? null,
        $stored['mime'],
        $stored['width'],
        $stored['height'],
        $stored['file_size'],
    ]);

    $id = (int) Database::write()->lastInsertId();
    getImage($stored['uuid']);
}

function updateImage(string $uuid): void
{
    $row = fetchByUuid($uuid);
    if (!$row) {
        sendError('Image not found', 404);
    }

    $contentType = $_SERVER['CONTENT_TYPE'] ?? '';
    if (str_contains($contentType, 'application/json')) {
        $data = json_decode(file_get_contents('php://input'), true) ?? [];
    } else {
        parse_str(file_get_contents('php://input'), $data);
    }

    // Only the folder label is updatable — the file itself is immutable after upload
    $newFolder = isset($data['folder']) ? trim($data['folder']) : $row['folder'];
    $newFolder = ImageService::sanitizeFolder($newFolder);

    $stmt = Database::write()->prepare('UPDATE images SET folder = ? WHERE uuid = ?');
    $stmt->execute([$newFolder, $uuid]);

    getImage($uuid);
}

function deleteImage(string $uuid): void
{
    $row = fetchByUuid($uuid);
    if (!$row) {
        sendError('Image not found', 404);
    }

    // Remove the file from disk first, then the DB row
    ImageService::remove($row['uuid'], $row['folder'], $row['mime_type']);

    $stmt = Database::write()->prepare('DELETE FROM images WHERE uuid = ?');
    $stmt->execute([$uuid]);

    sendJson(['message' => 'Image deleted']);
}

function fetchByUuid(string $uuid): array|false
{
    $stmt = Database::read()->prepare(
        'SELECT id, uuid, folder, original_name, mime_type, width, height, file_size, uploaded_at
         FROM images WHERE uuid = ?'
    );
    $stmt->execute([$uuid]);
    return $stmt->fetch();
}
