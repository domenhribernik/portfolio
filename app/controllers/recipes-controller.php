<?php
declare(strict_types=1);
define('SECURE_ACCESS', true);

header('Content-Type: application/json; charset=utf-8');
// Responses vary with the session cookie, so they must never be cached.
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
require_once __DIR__ . '/../services/image-service.php';

// Public recipe box: reads list EVERYONE's recipes (not a single demo shelf
// like plants/sourdough), writes require login and are always scoped to the
// caller's own rows. Ratings are one row per (recipe, user), upserted.

$method   = $_SERVER['REQUEST_METHOD'];
$resource = $_GET['resource'] ?? null;
$action   = $_GET['action']   ?? null;
$id       = isset($_GET['id']) ? (int) $_GET['id'] : null;

try {
    if ($resource === 'recipes') {
        if ($method !== 'GET') sendError('Method not allowed', 405);
        listRecipes();
    } elseif ($resource === 'recipe') {
        handleRecipe($method, $action, $id);
    } elseif ($resource === 'rating') {
        if ($method !== 'POST') sendError('Method not allowed', 405);
        if (!$id) sendError('Recipe ID is required', 400);
        rateRecipe($id, Auth::requireLogin());
    } else {
        sendError('Unknown resource. Use ?resource=recipes, recipe or rating', 400);
    }
} catch (InvalidArgumentException $e) {
    error_log('Recipes controller: ' . $e->getMessage());
    sendError($e->getMessage(), 400);
} catch (\Throwable $e) {
    error_log('Recipes controller error: ' . $e->getMessage());
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

function viewerEnvelope(?array $viewer): array
{
    return [
        'demo' => $viewer === null,
        'viewer' => $viewer !== null ? [
            'id' => (int) $viewer['id'],
            'display_name' => $viewer['display_name'],
            'avatar_url' => $viewer['avatar_url'],
        ] : null,
    ];
}

function mimeToExt(string $mime): string
{
    return match ($mime) {
        'image/png' => 'png',
        'image/gif' => 'gif',
        default     => 'jpg',
    };
}

/** The recipe's owner id, 404ing unless the caller owns it. */
function assertOwnRecipe(int $id, array $user): void
{
    $stmt = Database::read()->prepare('SELECT id FROM recipes WHERE id = ? AND user_id = ?');
    $stmt->execute([$id, (int) $user['id']]);
    if (!$stmt->fetch()) sendError('Recipe not found', 404);
}

// Columns shared by the list and detail queries. The author label never
// falls back to the email: that would leak addresses on a public endpoint.
function recipeSelectSql(): string
{
    return "
    SELECT r.id, r.user_id, r.title, r.description, r.servings, r.created_at, r.updated_at,
           COALESCE(NULLIF(u.display_name, ''), NULLIF(u.username, ''), 'Anonymous') AS author,
           u.avatar_url AS author_avatar,
           i.uuid AS image_uuid, i.mime_type AS image_mime,
           (SELECT ROUND(AVG(rr.stars), 2) FROM recipe_ratings rr WHERE rr.recipe_id = r.id) AS avg_rating,
           (SELECT COUNT(*) FROM recipe_ratings rr WHERE rr.recipe_id = r.id) AS rating_count
    FROM recipes r
    JOIN users u ON u.id = r.user_id
    LEFT JOIN images i ON i.id = r.image_id";
}

function formatRecipe(array $row, ?array $viewer): array
{
    $out = [
        'id'           => (int) $row['id'],
        'title'        => $row['title'],
        'description'  => $row['description'],
        'servings'     => $row['servings'] !== null ? (int) $row['servings'] : null,
        'author'       => $row['author'],
        'author_avatar' => $row['author_avatar'],
        'image_url'    => $row['image_uuid'] !== null
            ? 'assets/uploads/recipes/' . $row['image_uuid'] . '.' . mimeToExt((string) $row['image_mime'])
            : null,
        'avg_rating'   => $row['avg_rating'] !== null ? (float) $row['avg_rating'] : null,
        'rating_count' => (int) $row['rating_count'],
        'created_at'   => $row['created_at'],
        'mine'         => $viewer !== null && (int) $viewer['id'] === (int) $row['user_id'],
    ];
    return $out;
}

// --- Reads ---

function listRecipes(): void
{
    $viewer = Auth::currentUser();
    $stmt = Database::read()->query(recipeSelectSql() . ' ORDER BY r.created_at DESC, r.id DESC');
    $recipes = array_map(fn(array $row) => formatRecipe($row, $viewer), $stmt->fetchAll());
    sendJson(viewerEnvelope($viewer) + ['recipes' => $recipes]);
}

function getRecipe(int $id): void
{
    $viewer = Auth::currentUser();
    $stmt = Database::read()->prepare(recipeSelectSql() . ' WHERE r.id = ?');
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    if (!$row) sendError('Recipe not found', 404);

    $recipe = formatRecipe($row, $viewer);

    $ing = Database::read()->prepare(
        'SELECT ing_key, name, quantity FROM recipe_ingredients WHERE recipe_id = ? ORDER BY sort_order, id'
    );
    $ing->execute([$id]);
    $recipe['ingredients'] = array_map(fn(array $r) => [
        'key'      => (int) $r['ing_key'],
        'name'     => $r['name'],
        'quantity' => $r['quantity'],
    ], $ing->fetchAll());

    $steps = Database::read()->prepare(
        'SELECT body, duration_seconds FROM recipe_steps WHERE recipe_id = ? ORDER BY sort_order, id'
    );
    $steps->execute([$id]);
    $recipe['steps'] = array_map(fn(array $r) => [
        'body'             => $r['body'],
        'duration_seconds' => $r['duration_seconds'] !== null ? (int) $r['duration_seconds'] : null,
    ], $steps->fetchAll());

    $recipe['my_rating'] = null;
    if ($viewer !== null) {
        $mine = Database::read()->prepare(
            'SELECT stars FROM recipe_ratings WHERE recipe_id = ? AND user_id = ?'
        );
        $mine->execute([$id, (int) $viewer['id']]);
        $stars = $mine->fetchColumn();
        $recipe['my_rating'] = $stars !== false ? (int) $stars : null;
    }
    $recipe['can_edit'] = $recipe['mine'];

    sendJson(viewerEnvelope($viewer) + ['recipe' => $recipe]);
}

// --- Recipe document writes ---

function handleRecipe(string $method, ?string $action, ?int $id): void
{
    if ($method === 'GET') {
        if (!$id) sendError('Recipe ID is required', 400);
        getRecipe($id);
    }

    $user = Auth::requireLogin();
    switch ($method) {
        case 'POST':
            if ($id && $action === 'cover') { uploadCover($id, $user); return; }
            if ($id) sendError('Unknown recipe action', 400);
            saveRecipe(null, $user);
            return;
        case 'PUT':
            if (!$id) sendError('Recipe ID is required', 400);
            saveRecipe($id, $user);
            return;
        case 'DELETE':
            if (!$id) sendError('Recipe ID is required', 400);
            deleteRecipe($id, $user);
            return;
        default:
            sendError('Method not allowed', 405);
    }
}

/**
 * Validate the submitted recipe document. Returns the normalized document
 * (sanitized scalars, integer keys/durations, dangling tokens stripped) or
 * exits with a 400 listing the problems.
 */
function validateDocument(array $data): array
{
    $errors = [];

    $title = sanitize((string) ($data['title'] ?? ''));
    if ($title === '')                $errors[] = 'Title is required';
    elseif (mb_strlen($title) > 150)  $errors[] = 'Title must be 150 characters or less';

    $description = sanitize((string) ($data['description'] ?? ''));
    if (mb_strlen($description) > 1000) $errors[] = 'Description must be 1000 characters or less';

    // Optional base serving count. Mirrors validateDraft() in logic.js.
    $servingsRaw = trim((string) ($data['servings'] ?? ''));
    $servings = null;
    if ($servingsRaw !== '') {
        if (ctype_digit($servingsRaw) && (int) $servingsRaw >= 1 && (int) $servingsRaw <= 100) {
            $servings = (int) $servingsRaw;
        } else {
            $errors[] = 'Servings must be a whole number between 1 and 100';
        }
    }

    $rawIngredients = $data['ingredients'] ?? null;
    $rawSteps       = $data['steps'] ?? null;
    if (!is_array($rawIngredients) || count($rawIngredients) < 1) $errors[] = 'At least one ingredient is required';
    if (!is_array($rawSteps) || count($rawSteps) < 1)             $errors[] = 'At least one step is required';
    if (is_array($rawIngredients) && count($rawIngredients) > 100) $errors[] = 'Too many ingredients (max 100)';
    if (is_array($rawSteps) && count($rawSteps) > 100)             $errors[] = 'Too many steps (max 100)';
    if (!empty($errors)) sendError(implode('; ', $errors), 400);

    $ingredients = [];
    $seenKeys = [];
    foreach ($rawIngredients as $i => $row) {
        $key  = isset($row['key']) ? (int) $row['key'] : 0;
        $name = sanitize((string) ($row['name'] ?? ''));
        $qty  = sanitize((string) ($row['quantity'] ?? ''));
        if ($key < 1)                  $errors[] = 'Ingredient ' . ($i + 1) . ' has an invalid key';
        elseif (isset($seenKeys[$key])) $errors[] = 'Ingredient keys must be unique';
        if ($name === '')              $errors[] = 'Ingredient ' . ($i + 1) . ' needs a name';
        elseif (mb_strlen($name) > 100) $errors[] = 'Ingredient names must be 100 characters or less';
        if (mb_strlen($qty) > 50)      $errors[] = 'Ingredient quantities must be 50 characters or less';
        $seenKeys[$key] = true;
        $ingredients[] = ['key' => $key, 'name' => $name, 'quantity' => $qty];
    }

    $steps = [];
    foreach ($rawSteps as $i => $row) {
        $body = sanitize((string) ($row['body'] ?? ''));
        $duration = $row['duration_seconds'] ?? null;
        $duration = ($duration === null || $duration === '') ? null : (int) $duration;
        if ($body === '')                 $errors[] = 'Step ' . ($i + 1) . ' needs a description';
        elseif (mb_strlen($body) > 2000)  $errors[] = 'Steps must be 2000 characters or less';
        if ($duration !== null && ($duration < 1 || $duration > 86400)) {
            $errors[] = 'Step durations must be between 1 second and 24 hours';
        }
        // Drop tokens pointing at ingredients that are not in this document,
        // so cooking mode never renders a dead chip.
        $body = stripDanglingTokens($body, $seenKeys);
        $steps[] = ['body' => $body, 'duration_seconds' => $duration];
    }

    if (!empty($errors)) sendError(implode('; ', $errors), 400);

    return [
        'title'       => $title,
        'description' => $description === '' ? null : $description,
        'servings'    => $servings,
        'ingredients' => $ingredients,
        'steps'       => $steps,
    ];
}

/** Remove {ing:K} tokens whose key is not in the submitted ingredient set. */
function stripDanglingTokens(string $body, array $validKeys): string
{
    return preg_replace_callback('/\{ing:(\d+)\}/', function (array $m) use ($validKeys) {
        return isset($validKeys[(int) $m[1]]) ? $m[0] : '';
    }, $body);
}

/** Atomic create ($id === null) or full replace of a recipe document. */
function saveRecipe(?int $id, array $user): void
{
    if ($id !== null) assertOwnRecipe($id, $user);
    $doc = validateDocument(readBody());

    $db = Database::write();
    $db->beginTransaction();
    try {
        if ($id === null) {
            $stmt = $db->prepare('INSERT INTO recipes (user_id, title, description, servings) VALUES (?, ?, ?, ?)');
            $stmt->execute([(int) $user['id'], $doc['title'], $doc['description'], $doc['servings']]);
            $id = (int) $db->lastInsertId();
        } else {
            $stmt = $db->prepare('UPDATE recipes SET title = ?, description = ?, servings = ? WHERE id = ? AND user_id = ?');
            $stmt->execute([$doc['title'], $doc['description'], $doc['servings'], $id, (int) $user['id']]);
            $db->prepare('DELETE FROM recipe_ingredients WHERE recipe_id = ?')->execute([$id]);
            $db->prepare('DELETE FROM recipe_steps WHERE recipe_id = ?')->execute([$id]);
        }

        $ingStmt = $db->prepare(
            'INSERT INTO recipe_ingredients (recipe_id, ing_key, name, quantity, sort_order) VALUES (?, ?, ?, ?, ?)'
        );
        foreach ($doc['ingredients'] as $order => $ing) {
            $ingStmt->execute([$id, $ing['key'], $ing['name'], $ing['quantity'], $order]);
        }

        $stepStmt = $db->prepare(
            'INSERT INTO recipe_steps (recipe_id, sort_order, body, duration_seconds) VALUES (?, ?, ?, ?)'
        );
        foreach ($doc['steps'] as $order => $step) {
            $stepStmt->execute([$id, $order, $step['body'], $step['duration_seconds']]);
        }

        $db->commit();
    } catch (\Throwable $e) {
        $db->rollBack();
        throw $e;
    }

    getRecipe($id);
}

function deleteRecipe(int $id, array $user): void
{
    assertOwnRecipe($id, $user);

    $stmt = Database::read()->prepare(
        'SELECT i.id, i.uuid, i.mime_type FROM recipes r JOIN images i ON i.id = r.image_id WHERE r.id = ?'
    );
    $stmt->execute([$id]);
    $image = $stmt->fetch();

    $del = Database::write()->prepare('DELETE FROM recipes WHERE id = ? AND user_id = ?');
    $del->execute([$id, (int) $user['id']]);

    if ($image) {
        Database::write()->prepare('DELETE FROM images WHERE id = ?')->execute([(int) $image['id']]);
        try {
            ImageService::remove($image['uuid'], 'recipes', $image['mime_type']);
        } catch (RuntimeException $e) {
            error_log('Failed to remove recipe cover file: ' . $e->getMessage());
        }
    }

    sendJson(['message' => 'Recipe deleted']);
}

// --- Cover photo ---

function uploadCover(int $id, array $user): void
{
    assertOwnRecipe($id, $user);

    if (!isset($_FILES['image']) || $_FILES['image']['error'] === UPLOAD_ERR_NO_FILE) {
        sendError('Cover image is required', 400);
    }

    $existing = null;
    $stmt = Database::read()->prepare(
        'SELECT i.id, i.uuid, i.mime_type FROM recipes r JOIN images i ON i.id = r.image_id WHERE r.id = ?'
    );
    $stmt->execute([$id]);
    $existing = $stmt->fetch() ?: null;

    $prepared = ImageService::prepareFromUpload($_FILES['image'], ['size' => 'large', 'format' => 'jpeg']);
    $stored   = ImageService::store($prepared, 'recipes');

    if ($existing) {
        // Replace in place: keep the images row (and recipes.image_id) stable.
        try {
            ImageService::remove($existing['uuid'], 'recipes', $existing['mime_type']);
        } catch (RuntimeException $e) {
            error_log('Failed to remove old recipe cover file: ' . $e->getMessage());
        }
        $upd = Database::write()->prepare(
            'UPDATE images SET uuid = ?, mime_type = ?, width = ?, height = ?, file_size = ? WHERE id = ?'
        );
        $upd->execute([
            $stored['uuid'], $stored['mime'], $stored['width'], $stored['height'],
            $stored['file_size'], (int) $existing['id'],
        ]);
    } else {
        $ins = Database::write()->prepare(
            'INSERT INTO images (uuid, folder, mime_type, width, height, file_size) VALUES (?, ?, ?, ?, ?, ?)'
        );
        $ins->execute([
            $stored['uuid'], $stored['folder'], $stored['mime'],
            $stored['width'], $stored['height'], $stored['file_size'],
        ]);
        $imageId = (int) Database::write()->lastInsertId();
        Database::write()->prepare('UPDATE recipes SET image_id = ? WHERE id = ? AND user_id = ?')
            ->execute([$imageId, $id, (int) $user['id']]);
    }

    getRecipe($id);
}

// --- Ratings ---

function rateRecipe(int $id, array $user): void
{
    $stmt = Database::read()->prepare('SELECT user_id FROM recipes WHERE id = ?');
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    if (!$row) sendError('Recipe not found', 404);
    if ((int) $row['user_id'] === (int) $user['id']) {
        sendError('You cannot rate your own recipe', 400);
    }

    $data  = readBody();
    $stars = isset($data['stars']) ? (int) $data['stars'] : 0;
    if ($stars < 1 || $stars > 5) sendError('Rating must be between 1 and 5 stars', 400);

    $upsert = Database::write()->prepare(
        'INSERT INTO recipe_ratings (recipe_id, user_id, stars) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE stars = VALUES(stars)'
    );
    $upsert->execute([$id, (int) $user['id'], $stars]);

    $agg = Database::read()->prepare(
        'SELECT ROUND(AVG(stars), 2) AS avg_rating, COUNT(*) AS rating_count FROM recipe_ratings WHERE recipe_id = ?'
    );
    $agg->execute([$id]);
    $result = $agg->fetch();

    sendJson([
        'avg_rating'   => $result['avg_rating'] !== null ? (float) $result['avg_rating'] : null,
        'rating_count' => (int) $result['rating_count'],
        'my_rating'    => $stars,
    ]);
}
