<?php
declare(strict_types=1);
define('SECURE_ACCESS', true);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
// Deliberately no Access-Control-Allow-Origin: cookie auth is same-origin only.

require_once __DIR__ . '/../config/dev-mode.php';
require_once __DIR__ . '/../config/auth.php';

// Every endpoint in this file is admin-only. This exits with 401/403 otherwise.
$admin = Auth::requireAdmin();

const PASSWORD_MIN_LENGTH = 10;
const PASSWORD_MAX_LENGTH = 200;
const USERS_PAGE_SIZE = 50;

$method   = $_SERVER['REQUEST_METHOD'];
$resource = $_GET['resource'] ?? null;
$action   = $_GET['action'] ?? null;
$id       = isset($_GET['id']) ? (int) $_GET['id'] : null;
$userId   = isset($_GET['user_id']) ? (int) $_GET['user_id'] : null;

try {
    switch ($resource) {
        case 'users':
            handleUsers($method, $id, $admin);
            break;
        case 'projects':
            handleProjects($method, $id);
            break;
        case 'roles':
            handleRoles($method, $id, $admin);
            break;
        case 'resets':
            handleResets($method, $action, $admin);
            break;
        case 'sessions':
            handleSessions($method, $id, $userId);
            break;
        default:
            sendError('Unknown resource', 400);
    }
} catch (Throwable $e) {
    error_log('Admin controller error: ' . $e->getMessage() . ' in ' . $e->getFile() . ':' . $e->getLine());
    sendError('Internal server error', 500);
}

// ------------------------------------------------------------------
//  Users
// ------------------------------------------------------------------

function handleUsers(string $method, ?int $id, array $admin): void
{
    switch ($method) {
        case 'GET':
            $id ? getUserDetail($id) : listUsers();
            break;
        case 'PUT':
            if (!$id) {
                sendError('User id is required', 400);
            }
            updateUser($id, $admin);
            break;
        default:
            sendError('Method not allowed', 405);
    }
}

function listUsers(): void
{
    $q = isset($_GET['q']) ? trim((string) $_GET['q']) : '';
    $page = max(1, (int) ($_GET['page'] ?? 1));
    $offset = ($page - 1) * USERS_PAGE_SIZE;

    $where = '';
    $params = [];
    if ($q !== '') {
        $like = '%' . $q . '%';
        $where = 'WHERE email LIKE ? OR username LIKE ? OR display_name LIKE ?';
        $params = [$like, $like, $like];
    }

    $stmt = Database::read()->prepare(
        "SELECT id, email, username, display_name, avatar_url, is_admin, is_active,
                password_hash IS NOT NULL AS has_password, google_sub IS NOT NULL AS has_google,
                last_login_at, created_at,
                (SELECT COUNT(*) FROM user_project_roles r WHERE r.user_id = users.id) AS role_count
         FROM users $where
         ORDER BY created_at DESC
         LIMIT " . USERS_PAGE_SIZE . " OFFSET $offset"
    );
    $stmt->execute($params);
    sendJson(array_map('formatUser', $stmt->fetchAll()));
}

function getUserDetail(int $id): void
{
    $user = fetchUser($id);
    if (!$user) {
        sendError('User not found', 404);
    }

    $read = Database::read();

    $stmt = $read->prepare(
        'SELECT r.id, p.project_key, p.name AS project_name, r.role, r.permissions, r.created_at
         FROM user_project_roles r
         JOIN projects p ON p.id = r.project_id
         WHERE r.user_id = ?
         ORDER BY p.project_key'
    );
    $stmt->execute([$id]);
    $roles = $stmt->fetchAll();
    foreach ($roles as &$r) {
        $r['id'] = (int) $r['id'];
        $r['permissions'] = $r['permissions'] !== null ? json_decode($r['permissions'], true) : null;
    }

    $stmt = $read->prepare(
        'SELECT id, ip_address, user_agent, created_at, last_seen_at, expires_at
         FROM sessions
         WHERE user_id = ? AND revoked_at IS NULL AND expires_at > NOW()
         ORDER BY last_seen_at DESC'
    );
    $stmt->execute([$id]);
    $sessions = $stmt->fetchAll();
    foreach ($sessions as &$s) {
        $s['id'] = (int) $s['id'];
    }

    $stmt = $read->prepare(
        'SELECT id, expires_at, created_at
         FROM password_resets
         WHERE user_id = ? AND used_at IS NULL AND expires_at > NOW()
         ORDER BY created_at DESC'
    );
    $stmt->execute([$id]);
    $resets = $stmt->fetchAll();

    sendJson([
        'user'     => formatUser($user),
        'roles'    => $roles,
        'sessions' => $sessions,
        'resets'   => $resets,
    ]);
}

function updateUser(int $id, array $admin): void
{
    $user = fetchUser($id);
    if (!$user) {
        sendError('User not found', 404);
    }
    $body = jsonBody();
    if (!isset($body['is_active'])) {
        sendError('Nothing to update', 400);
    }
    $isActive = (int) (bool) $body['is_active'];
    if ($isActive === 0 && $id === (int) $admin['id']) {
        sendError('You cannot deactivate your own account', 400);
    }

    Database::write()->prepare('UPDATE users SET is_active = ? WHERE id = ?')->execute([$isActive, $id]);
    if ($isActive === 0) {
        Auth::revokeAllSessions($id);
    }
    sendJson(['message' => $isActive ? 'User reactivated' : 'User deactivated and signed out everywhere']);
}

// ------------------------------------------------------------------
//  Projects
// ------------------------------------------------------------------

function handleProjects(string $method, ?int $id): void
{
    switch ($method) {
        case 'GET':
            $stmt = Database::read()->query(
                'SELECT p.id, p.project_key, p.name, p.active, p.created_at,
                        (SELECT COUNT(*) FROM user_project_roles r WHERE r.project_id = p.id) AS member_count
                 FROM projects p ORDER BY p.project_key'
            );
            $projects = $stmt->fetchAll();
            foreach ($projects as &$p) {
                $p['id'] = (int) $p['id'];
                $p['active'] = (int) $p['active'];
                $p['member_count'] = (int) $p['member_count'];
            }
            sendJson($projects);
            break;

        case 'POST':
            $body = jsonBody();
            $key = isset($body['project_key']) && is_string($body['project_key'])
                ? strtolower(trim($body['project_key'])) : '';
            $name = isset($body['name']) && is_string($body['name']) ? trim($body['name']) : '';
            if (!preg_match('/^[a-z0-9_-]{2,50}$/', $key)) {
                sendError('Project key must be 2-50 chars: lowercase letters, digits, dash, underscore', 400);
            }
            if ($name === '' || mb_strlen($name) > 100) {
                sendError('Project name is required (max 100 chars)', 400);
            }
            try {
                Database::write()->prepare('INSERT INTO projects (project_key, name) VALUES (?, ?)')
                    ->execute([$key, $name]);
            } catch (PDOException $e) {
                if ((int) $e->errorInfo[1] === 1062) {
                    sendError('Project key already exists', 409);
                }
                throw $e;
            }
            sendJson(['message' => 'Project registered'], 201);
            break;

        case 'PUT':
            if (!$id) {
                sendError('Project id is required', 400);
            }
            $body = jsonBody();
            $updates = [];
            $params = [];
            if (isset($body['name']) && is_string($body['name']) && trim($body['name']) !== '') {
                $updates[] = 'name = ?';
                $params[] = mb_substr(trim($body['name']), 0, 100);
            }
            if (isset($body['active'])) {
                $updates[] = 'active = ?';
                $params[] = (int) (bool) $body['active'];
            }
            if ($updates === []) {
                sendError('Nothing to update', 400);
            }
            $params[] = $id;
            $stmt = Database::write()->prepare('UPDATE projects SET ' . implode(', ', $updates) . ' WHERE id = ?');
            $stmt->execute($params);
            sendJson(['message' => 'Project updated']);
            break;

        default:
            sendError('Method not allowed', 405);
    }
}

// ------------------------------------------------------------------
//  Roles
// ------------------------------------------------------------------

function handleRoles(string $method, ?int $id, array $admin): void
{
    switch ($method) {
        case 'POST':
            $body = jsonBody();
            // user_id "all" fans the grant out to every existing active user.
            $isBulk = ($body['user_id'] ?? null) === 'all';
            $targetId = $isBulk ? 0 : (int) ($body['user_id'] ?? 0);
            $projectKey = isset($body['project_key']) && is_string($body['project_key'])
                ? strtolower(trim($body['project_key'])) : '';
            $role = isset($body['role']) && is_string($body['role']) ? strtolower(trim($body['role'])) : '';

            if (!$isBulk && (!$targetId || !fetchUser($targetId))) {
                sendError('User not found', 404);
            }
            if (!preg_match('/^[a-z0-9_-]{2,32}$/', $role)) {
                sendError('Role must be 2-32 chars: lowercase letters, digits, dash, underscore', 400);
            }
            $stmt = Database::read()->prepare('SELECT id FROM projects WHERE project_key = ? AND active = 1');
            $stmt->execute([$projectKey]);
            $projectId = $stmt->fetchColumn();
            if ($projectId === false) {
                sendError('Project not found or inactive', 404);
            }

            if ($isBulk) {
                // One-time fan-out over users existing NOW (users created later
                // are not covered; re-run when needed). Users already holding a
                // role in the project are left untouched, so a better role is
                // never downgraded. The permissions JSON is per-user tuning and
                // is deliberately not part of a fan-out.
                $stmt = Database::write()->prepare(
                    'INSERT INTO user_project_roles (user_id, project_id, role, granted_by)
                     SELECT u.id, ?, ?, ? FROM users u
                     WHERE u.is_active = 1
                       AND NOT EXISTS (SELECT 1 FROM user_project_roles r
                                       WHERE r.user_id = u.id AND r.project_id = ?)'
                );
                $stmt->execute([(int) $projectId, $role, $admin['id'], (int) $projectId]);
                sendJson(['message' => 'Role granted to all users', 'granted' => $stmt->rowCount()]);
            }

            $permissions = null;
            if (isset($body['permissions']) && $body['permissions'] !== null && $body['permissions'] !== '') {
                if (!is_array($body['permissions'])) {
                    sendError('Permissions must be a JSON object', 400);
                }
                $permissions = json_encode($body['permissions'], JSON_UNESCAPED_UNICODE);
            }

            Database::write()->prepare(
                'INSERT INTO user_project_roles (user_id, project_id, role, permissions, granted_by)
                 VALUES (?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE role = VALUES(role), permissions = VALUES(permissions),
                                         granted_by = VALUES(granted_by)'
            )->execute([$targetId, (int) $projectId, $role, $permissions, $admin['id']]);
            sendJson(['message' => 'Role granted']);
            break;

        case 'DELETE':
            if (!$id) {
                sendError('Role id is required', 400);
            }
            $stmt = Database::write()->prepare('DELETE FROM user_project_roles WHERE id = ?');
            $stmt->execute([$id]);
            if ($stmt->rowCount() === 0) {
                sendError('Role not found', 404);
            }
            sendJson(['message' => 'Role revoked']);
            break;

        default:
            sendError('Method not allowed', 405);
    }
}

// ------------------------------------------------------------------
//  Password resets
// ------------------------------------------------------------------

function handleResets(string $method, ?string $action, array $admin): void
{
    if ($method !== 'POST') {
        sendError('Method not allowed', 405);
    }
    $body = jsonBody();
    $targetId = (int) ($body['user_id'] ?? 0);
    $target = $targetId ? fetchUser($targetId) : false;
    if (!$target) {
        sendError('User not found', 404);
    }

    switch ($action) {
        case 'link':
            $token = bin2hex(random_bytes(32));
            Database::write()->prepare(
                'INSERT INTO password_resets (user_id, token_hash, expires_at, created_by)
                 VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ' . Auth::RESET_TTL_HOURS . ' HOUR), ?)'
            )->execute([$targetId, hash('sha256', $token), $admin['id']]);
            // The raw token is returned exactly once; only its hash is stored.
            sendJson([
                'token'      => $token,
                'path'       => '/portfolio/views/account/?reset=' . $token,
                'expires_in' => Auth::RESET_TTL_HOURS . ' hours',
            ], 201);
            break;

        case 'temp-password':
            $password = isset($body['password']) && is_string($body['password']) ? $body['password'] : '';
            if (strlen($password) < PASSWORD_MIN_LENGTH || strlen($password) > PASSWORD_MAX_LENGTH) {
                sendError('Password must be between ' . PASSWORD_MIN_LENGTH . ' and ' . PASSWORD_MAX_LENGTH . ' characters', 400);
            }
            Database::write()->prepare('UPDATE users SET password_hash = ? WHERE id = ?')
                ->execute([password_hash($password, PASSWORD_DEFAULT), $targetId]);
            Auth::revokeAllSessions($targetId);
            sendJson(['message' => 'Temporary password set, all their sessions revoked']);
            break;

        default:
            sendError('Unknown action', 400);
    }
}

// ------------------------------------------------------------------
//  Sessions
// ------------------------------------------------------------------

function handleSessions(string $method, ?int $id, ?int $userId): void
{
    switch ($method) {
        case 'GET':
            if (!$userId) {
                sendError('user_id is required', 400);
            }
            $stmt = Database::read()->prepare(
                'SELECT id, ip_address, user_agent, created_at, last_seen_at, expires_at
                 FROM sessions
                 WHERE user_id = ? AND revoked_at IS NULL AND expires_at > NOW()
                 ORDER BY last_seen_at DESC'
            );
            $stmt->execute([$userId]);
            sendJson($stmt->fetchAll());
            break;

        case 'DELETE':
            if ($userId && isset($_GET['all'])) {
                Auth::revokeAllSessions($userId);
                sendJson(['message' => 'All sessions revoked']);
            }
            if (!$id) {
                sendError('Session id is required', 400);
            }
            $stmt = Database::write()->prepare(
                'UPDATE sessions SET revoked_at = NOW() WHERE id = ? AND revoked_at IS NULL'
            );
            $stmt->execute([$id]);
            if ($stmt->rowCount() === 0) {
                sendError('Session not found', 404);
            }
            sendJson(['message' => 'Session revoked']);
            break;

        default:
            sendError('Method not allowed', 405);
    }
}

// ------------------------------------------------------------------
//  Helpers
// ------------------------------------------------------------------

function fetchUser(int $id): array|false
{
    $stmt = Database::read()->prepare(
        'SELECT id, email, username, display_name, avatar_url, is_admin, is_active,
                password_hash IS NOT NULL AS has_password, google_sub IS NOT NULL AS has_google,
                last_login_at, created_at
         FROM users WHERE id = ?'
    );
    $stmt->execute([$id]);
    return $stmt->fetch();
}

function formatUser(array $row): array
{
    $row['id'] = (int) $row['id'];
    $row['is_admin'] = (int) $row['is_admin'] === 1;
    $row['is_active'] = (int) $row['is_active'] === 1;
    $row['has_password'] = (int) $row['has_password'] === 1;
    $row['has_google'] = (int) $row['has_google'] === 1;
    if (isset($row['role_count'])) {
        $row['role_count'] = (int) $row['role_count'];
    }
    return $row;
}

function jsonBody(): array
{
    // CSRF backstop: admin endpoints only accept JSON bodies.
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
    echo json_encode(['error' => $message], JSON_UNESCAPED_UNICODE);
    exit;
}
