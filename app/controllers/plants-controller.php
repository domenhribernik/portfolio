<?php
declare(strict_types=1);
define('SECURE_ACCESS', true);

header('Content-Type: application/json; charset=utf-8');
// Responses vary with the session cookie, so they must never be cached.
// The image endpoint overrides this with its own Cache-Control.
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

// One shelf per user. Reads are public: signed-out visitors get a read-only
// demo of the site owner's shelf, signed-in users get their own rows. Writes
// require login and are always scoped to the caller's own plants. This is the
// third backend shape next to images-controller.php (public reads, role-gated
// writes) and shopping-controller.php (project gate + row ACL); no project
// role is involved, an account is the only requirement.

$method = $_SERVER['REQUEST_METHOD'];
$id = isset($_GET['id']) ? (int) $_GET['id'] : null;
$action = $_GET['action'] ?? null;

try {
    switch ($method) {
        case 'GET':
            if ($action === 'image' && $id) {
                getPlantImage($id);
            } elseif ($id) {
                getPlant($id, shelfUserId());
            } else {
                getAllPlants();
            }
            break;
        case 'POST':
            $user = Auth::requireLogin();
            if ($action === 'water' && $id) {
                waterPlant($id, $user);
            } elseif ($id) {
                updatePlant($id, $user);
            } else {
                createPlant($user);
            }
            break;
        case 'PUT':
            $user = Auth::requireLogin();
            if (!$id) {
                sendError('Plant ID is required', 400);
            }
            updatePlant($id, $user);
            break;
        case 'DELETE':
            $user = Auth::requireLogin();
            if (!$id) {
                sendError('Plant ID is required', 400);
            }
            deletePlant($id, $user);
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

/** The user whose plants back the public demo: the first active site admin. */
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

/** Whose shelf the current request reads: the viewer's own, or the demo one. */
function shelfUserId(): ?int
{
    $viewer = Auth::currentUser();
    return $viewer !== null ? (int) $viewer['id'] : showcaseUserId();
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
    unset($row['image_data'], $row['image_mime'], $row['user_id']);
    return $row;
}

// --- Image endpoint ---

function getPlantImage(int $id): void
{
    $stmt = Database::read()->prepare('SELECT image_data, image_mime, user_id FROM plants WHERE id = ?');
    $stmt->execute([$id]);
    $plant = $stmt->fetch();

    if (!$plant || empty($plant['image_data'])) {
        http_response_code(404);
        exit;
    }

    // Demo images are public; anyone else's are visible to their owner only.
    $ownerId = (int) $plant['user_id'];
    $isDemoPlant = $ownerId === showcaseUserId();
    $viewer = Auth::currentUser();
    if (!$isDemoPlant && ($viewer === null || (int) $viewer['id'] !== $ownerId)) {
        http_response_code(404);
        exit;
    }

    header('Content-Type: ' . $plant['image_mime']);
    header('Content-Length: ' . strlen($plant['image_data']));
    header('Cache-Control: ' . ($isDemoPlant ? 'public' : 'private') . ', max-age=86400');
    echo $plant['image_data'];
    exit;
}

// --- CRUD Operations ---

function getAllPlants(): void
{
    $viewer = Auth::currentUser();
    $ownerId = $viewer !== null ? (int) $viewer['id'] : showcaseUserId();

    $plants = [];
    if ($ownerId !== null) {
        $sql = 'SELECT id, user_id, name, nickname, type, description, watering_frequency_text,
                watering_min_days, watering_max_days, light, humidity, temperature, soil,
                common_issues, useful_tips, IF(image_data IS NOT NULL, 1, 0) AS image_data,
                image_mime, last_watered, created_at, updated_at
                FROM plants WHERE user_id = ? ORDER BY created_at DESC';
        $stmt = Database::read()->prepare($sql);
        $stmt->execute([$ownerId]);
        $plants = array_map('formatPlant', $stmt->fetchAll());
    }

    sendJson([
        'demo' => $viewer === null,
        'viewer' => $viewer !== null ? [
            'id' => (int) $viewer['id'],
            'display_name' => $viewer['display_name'],
            'avatar_url' => $viewer['avatar_url'],
        ] : null,
        'plants' => $plants,
    ]);
}

function getPlant(int $id, ?int $ownerId): void
{
    if ($ownerId === null) {
        sendError('Plant not found', 404);
    }

    $sql = 'SELECT id, user_id, name, nickname, type, description, watering_frequency_text,
            watering_min_days, watering_max_days, light, humidity, temperature, soil,
            common_issues, useful_tips, IF(image_data IS NOT NULL, 1, 0) AS image_data,
            image_mime, last_watered, created_at, updated_at
            FROM plants WHERE id = ? AND user_id = ?';
    $stmt = Database::read()->prepare($sql);
    $stmt->execute([$id, $ownerId]);
    $plant = $stmt->fetch();

    if (!$plant) {
        sendError('Plant not found', 404);
    }

    sendJson(formatPlant($plant));
}

/** 404 unless the plant exists and belongs to the caller. */
function assertOwnPlant(int $id, array $user): void
{
    $stmt = Database::read()->prepare('SELECT id FROM plants WHERE id = ? AND user_id = ?');
    $stmt->execute([$id, (int) $user['id']]);
    if (!$stmt->fetch()) {
        sendError('Plant not found', 404);
    }
}

function createPlant(array $user): void
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

    $sql = 'INSERT INTO plants (user_id, name, nickname, type, description, watering_frequency_text,
            watering_min_days, watering_max_days, light, humidity, temperature, soil,
            common_issues, useful_tips, image_data, image_mime, last_watered)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())';

    $stmt = Database::write()->prepare($sql);
    $stmt->execute([
        (int) $user['id'],
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
    getPlant($id, (int) $user['id']);
}

function updatePlant(int $id, array $user): void
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

    assertOwnPlant($id, $user);

    $image = handleImageUpload();
    $removeImage = isset($data['remove_image']) && $data['remove_image'] === '1';

    $commonIssues = isset($data['common_issues'])
        ? json_encode(array_map('sanitize', json_decode($data['common_issues'], true) ?? []), JSON_UNESCAPED_UNICODE)
        : '[]';
    $usefulTips = isset($data['useful_tips'])
        ? json_encode(array_map('sanitize', json_decode($data['useful_tips'], true) ?? []), JSON_UNESCAPED_UNICODE)
        : '[]';

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
    ];

    if ($image) {
        $sql = 'UPDATE plants SET name = ?, nickname = ?, type = ?, description = ?,
                watering_frequency_text = ?, watering_min_days = ?, watering_max_days = ?,
                light = ?, humidity = ?, temperature = ?, soil = ?, common_issues = ?,
                useful_tips = ?, image_data = ?, image_mime = ? WHERE id = ? AND user_id = ?';
        $params[] = $image['data'];
        $params[] = $image['mime'];
    } elseif ($removeImage) {
        $sql = 'UPDATE plants SET name = ?, nickname = ?, type = ?, description = ?,
                watering_frequency_text = ?, watering_min_days = ?, watering_max_days = ?,
                light = ?, humidity = ?, temperature = ?, soil = ?, common_issues = ?,
                useful_tips = ?, image_data = NULL, image_mime = NULL WHERE id = ? AND user_id = ?';
    } else {
        $sql = 'UPDATE plants SET name = ?, nickname = ?, type = ?, description = ?,
                watering_frequency_text = ?, watering_min_days = ?, watering_max_days = ?,
                light = ?, humidity = ?, temperature = ?, soil = ?, common_issues = ?,
                useful_tips = ? WHERE id = ? AND user_id = ?';
    }
    $params[] = $id;
    $params[] = (int) $user['id'];

    $stmt = Database::write()->prepare($sql);
    $stmt->execute($params);

    getPlant($id, (int) $user['id']);
}

function waterPlant(int $id, array $user): void
{
    assertOwnPlant($id, $user);

    $stmt = Database::write()->prepare('UPDATE plants SET last_watered = NOW() WHERE id = ? AND user_id = ?');
    $stmt->execute([$id, (int) $user['id']]);

    getPlant($id, (int) $user['id']);
}

function deletePlant(int $id, array $user): void
{
    assertOwnPlant($id, $user);

    $stmt = Database::write()->prepare('DELETE FROM plants WHERE id = ? AND user_id = ?');
    $stmt->execute([$id, (int) $user['id']]);

    sendJson(['message' => 'Plant deleted']);
}
