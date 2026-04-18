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
$id     = isset($_GET['id']) ? (int) $_GET['id'] : null;

try {
    switch ($method) {
        case 'GET':
            $id ? getPhoto($id) : getAllPhotos();
            break;
        case 'POST':
            $id ? updatePhoto($id) : createPhoto();
            break;
        case 'PUT':
            if (!$id) sendError('Photo ID is required', 400);
            updatePhoto($id);
            break;
        case 'DELETE':
            if (!$id) sendError('Photo ID is required', 400);
            deletePhoto($id);
            break;
        default:
            sendError('Method not allowed', 405);
    }
} catch (InvalidArgumentException $e) {
    error_log('Iliana photos controller: ' . $e->getMessage());
    sendError($e->getMessage(), 400);
} catch (\Throwable $e) {
    error_log('Iliana photos controller: ' . $e->getMessage());
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

function mimeToExt(string $mime): string
{
    return match ($mime) {
        'image/jpeg' => 'jpg',
        'image/png'  => 'png',
        default      => 'jpg',
    };
}

function formatPhoto(array $row): array
{
    $row['id']        = (int) $row['id'];
    $row['image_id']  = (int) $row['image_id'];
    $row['width']     = $row['width']     !== null ? (int) $row['width']     : null;
    $row['height']    = $row['height']    !== null ? (int) $row['height']    : null;
    $row['file_size'] = $row['file_size'] !== null ? (int) $row['file_size'] : null;
    $ext = mimeToExt($row['mime_type']);
    $row['image_url'] = 'assets/uploads/iliana/' . $row['uuid'] . '.' . $ext;
    return $row;
}

function fetchById(int $id): array
{
    $sql = 'SELECT p.id, p.image_id, p.caption, p.photo_date, p.added_by, p.created_at, p.updated_at,
                   i.uuid, i.mime_type, i.width, i.height, i.file_size
            FROM iliana_photos p
            JOIN images i ON i.id = p.image_id
            WHERE p.id = ?';
    $stmt = Database::read()->prepare($sql);
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    if (!$row) sendError('Photo not found', 404);
    return $row;
}

function validateInput(array $data): array
{
    $errors = [];

    if (empty(trim($data['caption'] ?? ''))) {
        $errors[] = 'Caption is required';
    } elseif (mb_strlen($data['caption']) > 500) {
        $errors[] = 'Caption must be 500 characters or less';
    }

    if (empty(trim($data['photo_date'] ?? ''))) {
        $errors[] = 'Date is required';
    } else {
        $d = DateTime::createFromFormat('Y-m-d', $data['photo_date']);
        if (!$d || $d->format('Y-m-d') !== $data['photo_date']) {
            $errors[] = 'Date must be in YYYY-MM-DD format';
        }
    }

    if (!in_array($data['added_by'] ?? '', ['Domen', 'Iliana'], true)) {
        $errors[] = 'Added by must be Domen or Iliana';
    }

    return $errors;
}

// --- CRUD ---

function getAllPhotos(): void
{
    $sql = 'SELECT p.id, p.image_id, p.caption, p.photo_date, p.added_by, p.created_at, p.updated_at,
                   i.uuid, i.mime_type, i.width, i.height, i.file_size
            FROM iliana_photos p
            JOIN images i ON i.id = p.image_id
            ORDER BY p.photo_date ASC, p.created_at ASC';
    $stmt = Database::read()->query($sql);
    $photos = array_map('formatPhoto', $stmt->fetchAll());
    sendJson($photos);
}

function getPhoto(int $id): void
{
    sendJson(formatPhoto(fetchById($id)));
}

function createPhoto(): void
{
    $data   = $_POST;
    $errors = validateInput($data);
    if (!empty($errors)) sendError(implode('; ', $errors), 400);

    if (!isset($_FILES['image']) || $_FILES['image']['error'] === UPLOAD_ERR_NO_FILE) {
        sendError('Photo image is required', 400);
    }
    if ($_FILES['image']['error'] !== UPLOAD_ERR_OK) {
        sendError('Image upload failed with error code ' . $_FILES['image']['error'], 400);
    }

    $finfo = finfo_open(FILEINFO_MIME_TYPE);
    $detectedMime = finfo_file($finfo, $_FILES['image']['tmp_name']);
    finfo_close($finfo);
    error_log('Iliana upload: mime=' . $detectedMime . ' size=' . $_FILES['image']['size'] . ' name=' . $_FILES['image']['name']);

    $prepared = ImageService::prepareFromUpload($_FILES['image'], ['size' => 'large', 'format' => 'jpeg']);
    $stored   = ImageService::store($prepared, 'iliana');

    $imgSql = 'INSERT INTO images (uuid, folder, mime_type, width, height, file_size)
               VALUES (?, ?, ?, ?, ?, ?)';
    $imgStmt = Database::write()->prepare($imgSql);
    $imgStmt->execute([
        $stored['uuid'],
        $stored['folder'],
        $stored['mime'],
        $stored['width'],
        $stored['height'],
        $stored['file_size'],
    ]);
    $imageId = (int) Database::write()->lastInsertId();

    $sql = 'INSERT INTO iliana_photos (image_id, caption, photo_date, added_by)
            VALUES (?, ?, ?, ?)';
    $stmt = Database::write()->prepare($sql);
    $stmt->execute([
        $imageId,
        trim($data['caption']),
        $data['photo_date'],
        $data['added_by'],
    ]);

    $id = (int) Database::write()->lastInsertId();
    getPhoto($id);
}

function updatePhoto(int $id): void
{
    $data   = $_POST;
    $errors = validateInput($data);
    if (!empty($errors)) sendError(implode('; ', $errors), 400);

    $existing = fetchById($id);

    if (isset($_FILES['image']) && $_FILES['image']['error'] === UPLOAD_ERR_OK) {
        try {
            ImageService::remove($existing['uuid'], 'iliana', $existing['mime_type']);
        } catch (RuntimeException $e) {
            error_log('Failed to remove old iliana photo file: ' . $e->getMessage());
        }

        $prepared = ImageService::prepareFromUpload($_FILES['image'], ['size' => 'large', 'format' => 'jpeg']);
        $stored   = ImageService::store($prepared, 'iliana');

        $imgSql = 'UPDATE images SET uuid = ?, mime_type = ?, width = ?, height = ?, file_size = ? WHERE id = ?';
        $imgStmt = Database::write()->prepare($imgSql);
        $imgStmt->execute([
            $stored['uuid'],
            $stored['mime'],
            $stored['width'],
            $stored['height'],
            $stored['file_size'],
            $existing['image_id'],
        ]);
    }

    $sql = 'UPDATE iliana_photos SET caption = ?, photo_date = ?, added_by = ? WHERE id = ?';
    $stmt = Database::write()->prepare($sql);
    $stmt->execute([
        trim($data['caption']),
        $data['photo_date'],
        $data['added_by'],
        $id,
    ]);

    getPhoto($id);
}

function deletePhoto(int $id): void
{
    $existing = fetchById($id);

    $stmt = Database::write()->prepare('DELETE FROM iliana_photos WHERE id = ?');
    $stmt->execute([$id]);

    $stmt = Database::write()->prepare('DELETE FROM images WHERE id = ?');
    $stmt->execute([$existing['image_id']]);

    try {
        ImageService::remove($existing['uuid'], 'iliana', $existing['mime_type']);
    } catch (RuntimeException $e) {
        error_log('Failed to remove iliana photo file: ' . $e->getMessage());
    }

    sendJson(['message' => 'Photo deleted']);
}
