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

$method = $_SERVER['REQUEST_METHOD'];
$id = isset($_GET['id']) ? (int) $_GET['id'] : null;
$action = $_GET['action'] ?? null;

try {
    switch ($method) {
        case 'GET':
            if ($action === 'image' && $id) {
                getPlantImage($id);
            } elseif ($id) {
                getPlant($id);
            } else {
                getAllPlants();
            }
            break;
        case 'POST':
            if ($action === 'water' && $id) {
                waterPlant($id);
            } else {
                createPlant();
            }
            break;
        case 'PUT':
            if (!$id) {
                sendError('Plant ID is required', 400);
            }
            updatePlant($id);
            break;
        case 'DELETE':
            if (!$id) {
                sendError('Plant ID is required', 400);
            }
            deletePlant($id);
            break;
        default:
            sendError('Method not allowed', 405);
    }
} catch (Exception $e) {
    error_log('Plants controller error: ' . $e->getMessage());
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

function validatePlantInput(array $data): array
{
    $errors = [];

    $required = ['name', 'type', 'description', 'watering_frequency_text',
                 'watering_min_days', 'watering_max_days', 'light',
                 'humidity', 'temperature', 'soil'];

    foreach ($required as $field) {
        if (empty($data[$field]) && $data[$field] !== '0') {
            $errors[] = "Field '$field' is required";
        }
    }

    if (!empty($data['watering_min_days']) && !empty($data['watering_max_days'])) {
        $min = (int) $data['watering_min_days'];
        $max = (int) $data['watering_max_days'];
        if ($min < 1) $errors[] = 'Minimum watering days must be at least 1';
        if ($max < $min) $errors[] = 'Maximum watering days must be >= minimum';
    }

    if (!empty($data['name']) && mb_strlen($data['name']) > 255) {
        $errors[] = 'Name must be 255 characters or less';
    }

    return $errors;
}

function handleImageUpload(): ?array
{
    if (!isset($_FILES['image']) || $_FILES['image']['error'] === UPLOAD_ERR_NO_FILE) {
        return null;
    }

    $file = $_FILES['image'];

    if ($file['error'] !== UPLOAD_ERR_OK) {
        sendError('Image upload failed', 400);
    }

    $allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    $finfo = finfo_open(FILEINFO_MIME_TYPE);
    $mimeType = finfo_file($finfo, $file['tmp_name']);
    finfo_close($finfo);

    if (!in_array($mimeType, $allowedTypes, true)) {
        sendError('Invalid image type. Allowed: JPEG, PNG, WebP, GIF', 400);
    }

    $maxSize = 5 * 1024 * 1024; // 5MB
    if ($file['size'] > $maxSize) {
        sendError('Image must be under 5MB', 400);
    }

    $imageData = file_get_contents($file['tmp_name']);
    if ($imageData === false) {
        sendError('Failed to read image', 500);
    }

    return ['data' => $imageData, 'mime' => $mimeType];
}

function formatPlant(array $row): array
{
    $row['id'] = (int) $row['id'];
    $row['watering_min_days'] = (int) $row['watering_min_days'];
    $row['watering_max_days'] = (int) $row['watering_max_days'];
    $row['common_issues'] = json_decode($row['common_issues'], true) ?? [];
    $row['useful_tips'] = json_decode($row['useful_tips'], true) ?? [];
    $row['has_image'] = !empty($row['image_data']);
    $row['image_url'] = $row['has_image']
        ? 'app/controllers/plants-controller.php?action=image&id=' . $row['id']
        : null;
    unset($row['image_data'], $row['image_mime']);
    return $row;
}

// --- Image endpoint ---

function getPlantImage(int $id): void
{
    $stmt = Database::read()->prepare('SELECT image_data, image_mime FROM plants WHERE id = ?');
    $stmt->execute([$id]);
    $plant = $stmt->fetch();

    if (!$plant || empty($plant['image_data'])) {
        http_response_code(404);
        exit;
    }

    header('Content-Type: ' . $plant['image_mime']);
    header('Content-Length: ' . strlen($plant['image_data']));
    header('Cache-Control: public, max-age=86400');
    echo $plant['image_data'];
    exit;
}

// --- CRUD Operations ---

function getAllPlants(): void
{
    $sql = 'SELECT id, name, nickname, type, description, watering_frequency_text,
            watering_min_days, watering_max_days, light, humidity, temperature, soil,
            common_issues, useful_tips, IF(image_data IS NOT NULL, 1, 0) AS image_data,
            image_mime, last_watered, created_at, updated_at
            FROM plants ORDER BY created_at DESC';
    $stmt = Database::read()->query($sql);
    $plants = array_map('formatPlant', $stmt->fetchAll());
    sendJson($plants);
}

function getPlant(int $id): void
{
    $sql = 'SELECT id, name, nickname, type, description, watering_frequency_text,
            watering_min_days, watering_max_days, light, humidity, temperature, soil,
            common_issues, useful_tips, IF(image_data IS NOT NULL, 1, 0) AS image_data,
            image_mime, last_watered, created_at, updated_at
            FROM plants WHERE id = ?';
    $stmt = Database::read()->prepare($sql);
    $stmt->execute([$id]);
    $plant = $stmt->fetch();

    if (!$plant) {
        sendError('Plant not found', 404);
    }

    sendJson(formatPlant($plant));
}

function createPlant(): void
{
    $data = $_POST;

    $errors = validatePlantInput($data);
    if (!empty($errors)) {
        sendError(implode('; ', $errors), 400);
    }

    $image = handleImageUpload();

    $commonIssues = isset($data['common_issues'])
        ? json_encode(array_map('sanitize', json_decode($data['common_issues'], true) ?? []), JSON_UNESCAPED_UNICODE)
        : '[]';
    $usefulTips = isset($data['useful_tips'])
        ? json_encode(array_map('sanitize', json_decode($data['useful_tips'], true) ?? []), JSON_UNESCAPED_UNICODE)
        : '[]';

    $sql = 'INSERT INTO plants (name, nickname, type, description, watering_frequency_text,
            watering_min_days, watering_max_days, light, humidity, temperature, soil,
            common_issues, useful_tips, image_data, image_mime, last_watered)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())';

    $stmt = Database::write()->prepare($sql);
    $stmt->execute([
        sanitize($data['name']),
        !empty($data['nickname']) ? sanitize($data['nickname']) : null,
        sanitize($data['type']),
        sanitize($data['description']),
        sanitize($data['watering_frequency_text']),
        (int) $data['watering_min_days'],
        (int) $data['watering_max_days'],
        sanitize($data['light']),
        sanitize($data['humidity']),
        sanitize($data['temperature']),
        sanitize($data['soil']),
        $commonIssues,
        $usefulTips,
        $image ? $image['data'] : null,
        $image ? $image['mime'] : null,
    ]);

    $id = (int) Database::write()->lastInsertId();
    getPlant($id);
}

function updatePlant(int $id): void
{
    // For PUT, read raw input since it might be multipart or JSON
    $contentType = $_SERVER['CONTENT_TYPE'] ?? '';

    if (str_contains($contentType, 'multipart/form-data')) {
        $data = $_POST;
    } else {
        parse_str(file_get_contents('php://input'), $data);
    }

    $errors = validatePlantInput($data);
    if (!empty($errors)) {
        sendError(implode('; ', $errors), 400);
    }

    // Check plant exists
    $checkStmt = Database::read()->prepare('SELECT id FROM plants WHERE id = ?');
    $checkStmt->execute([$id]);
    if (!$checkStmt->fetch()) {
        sendError('Plant not found', 404);
    }

    $image = handleImageUpload();
    $removeImage = isset($data['remove_image']) && $data['remove_image'] === '1';

    $commonIssues = isset($data['common_issues'])
        ? json_encode(array_map('sanitize', json_decode($data['common_issues'], true) ?? []), JSON_UNESCAPED_UNICODE)
        : '[]';
    $usefulTips = isset($data['useful_tips'])
        ? json_encode(array_map('sanitize', json_decode($data['useful_tips'], true) ?? []), JSON_UNESCAPED_UNICODE)
        : '[]';

    if ($image) {
        $sql = 'UPDATE plants SET name = ?, nickname = ?, type = ?, description = ?,
                watering_frequency_text = ?, watering_min_days = ?, watering_max_days = ?,
                light = ?, humidity = ?, temperature = ?, soil = ?, common_issues = ?,
                useful_tips = ?, image_data = ?, image_mime = ? WHERE id = ?';
        $params = [
            sanitize($data['name']),
            !empty($data['nickname']) ? sanitize($data['nickname']) : null,
            sanitize($data['type']),
            sanitize($data['description']),
            sanitize($data['watering_frequency_text']),
            (int) $data['watering_min_days'],
            (int) $data['watering_max_days'],
            sanitize($data['light']),
            sanitize($data['humidity']),
            sanitize($data['temperature']),
            sanitize($data['soil']),
            $commonIssues,
            $usefulTips,
            $image['data'],
            $image['mime'],
            $id,
        ];
    } elseif ($removeImage) {
        $sql = 'UPDATE plants SET name = ?, nickname = ?, type = ?, description = ?,
                watering_frequency_text = ?, watering_min_days = ?, watering_max_days = ?,
                light = ?, humidity = ?, temperature = ?, soil = ?, common_issues = ?,
                useful_tips = ?, image_data = NULL, image_mime = NULL WHERE id = ?';
        $params = [
            sanitize($data['name']),
            !empty($data['nickname']) ? sanitize($data['nickname']) : null,
            sanitize($data['type']),
            sanitize($data['description']),
            sanitize($data['watering_frequency_text']),
            (int) $data['watering_min_days'],
            (int) $data['watering_max_days'],
            sanitize($data['light']),
            sanitize($data['humidity']),
            sanitize($data['temperature']),
            sanitize($data['soil']),
            $commonIssues,
            $usefulTips,
            $id,
        ];
    } else {
        $sql = 'UPDATE plants SET name = ?, nickname = ?, type = ?, description = ?,
                watering_frequency_text = ?, watering_min_days = ?, watering_max_days = ?,
                light = ?, humidity = ?, temperature = ?, soil = ?, common_issues = ?,
                useful_tips = ? WHERE id = ?';
        $params = [
            sanitize($data['name']),
            !empty($data['nickname']) ? sanitize($data['nickname']) : null,
            sanitize($data['type']),
            sanitize($data['description']),
            sanitize($data['watering_frequency_text']),
            (int) $data['watering_min_days'],
            (int) $data['watering_max_days'],
            sanitize($data['light']),
            sanitize($data['humidity']),
            sanitize($data['temperature']),
            sanitize($data['soil']),
            $commonIssues,
            $usefulTips,
            $id,
        ];
    }

    $stmt = Database::write()->prepare($sql);
    $stmt->execute($params);

    getPlant($id);
}

function waterPlant(int $id): void
{
    $checkStmt = Database::read()->prepare('SELECT id FROM plants WHERE id = ?');
    $checkStmt->execute([$id]);
    if (!$checkStmt->fetch()) {
        sendError('Plant not found', 404);
    }

    $stmt = Database::write()->prepare('UPDATE plants SET last_watered = NOW() WHERE id = ?');
    $stmt->execute([$id]);

    getPlant($id);
}

function deletePlant(int $id): void
{
    $checkStmt = Database::read()->prepare('SELECT id FROM plants WHERE id = ?');
    $checkStmt->execute([$id]);
    if (!$checkStmt->fetch()) {
        sendError('Plant not found', 404);
    }

    $stmt = Database::write()->prepare('DELETE FROM plants WHERE id = ?');
    $stmt->execute([$id]);

    sendJson(['message' => 'Plant deleted']);
}
