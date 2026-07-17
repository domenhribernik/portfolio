<?php
declare(strict_types=1);
define('SECURE_ACCESS', true);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
// Deliberately no Access-Control-Allow-Origin: cookie auth is same-origin only.

require_once __DIR__ . '/../config/dev-mode.php';
require_once __DIR__ . '/../config/auth.php';
require_once __DIR__ . '/../services/google-auth-service.php';

const PASSWORD_MIN_LENGTH = 10;
const PASSWORD_MAX_LENGTH = 200;
const MAX_FAILURES_PER_IDENTIFIER = 5;
const MAX_FAILURES_PER_IP = 20;
const RATE_WINDOW_MINUTES = 15;
// Verified against on unknown identifiers so response timing does not reveal
// whether an account exists.
const DUMMY_HASH = '$2y$10$rcXYOPqsXA82.LrT87b55OepL5d3VweQgkBZUE37rHaseG20KQOJC';

$method   = $_SERVER['REQUEST_METHOD'];
$action   = $_GET['action'] ?? null;
$resource = $_GET['resource'] ?? null;
$id       = isset($_GET['id']) ? (int) $_GET['id'] : null;

try {
    if ($resource === 'sessions') {
        switch ($method) {
            case 'GET':
                listOwnSessions();
                break;
            case 'DELETE':
                if (!$id) {
                    sendError('Session id is required', 400);
                }
                revokeOwnSession($id);
                break;
            default:
                sendError('Method not allowed', 405);
        }
    }

    switch ($action) {
        case 'google':
            requirePost($method);
            googleLogin();
            break;
        case 'login':
            requirePost($method);
            passwordLogin();
            break;
        case 'logout':
            requirePost($method);
            Auth::assertSameOrigin();
            Auth::logout();
            sendJson(['message' => 'Logged out']);
            break;
        case 'me':
            me();
            break;
        case 'config':
            // The Google client id is public by design (it is embedded in the
            // GSI button); serving it from .env keeps it single-sourced.
            $clientId = $_ENV['GOOGLE_CLIENT_ID'] ?? '';
            sendJson([
                'google_client_id' => str_starts_with($clientId, 'REPLACE_ME') ? '' : $clientId,
            ]);
            break;
        case 'set-credentials':
            requirePost($method);
            setCredentials();
            break;
        case 'reset-password':
            requirePost($method);
            resetPassword();
            break;
        default:
            sendError('Unknown action', 400);
    }
} catch (Throwable $e) {
    // Never log request bodies here: they can contain passwords and tokens.
    error_log('Auth controller error: ' . $e->getMessage() . ' in ' . $e->getFile() . ':' . $e->getLine());
    sendError('Internal server error', 500);
}

// ------------------------------------------------------------------
//  Handlers
// ------------------------------------------------------------------

function googleLogin(): void
{
    Auth::assertSameOrigin();
    $body = jsonBody();
    $credential = isset($body['credential']) && is_string($body['credential']) ? $body['credential'] : '';

    try {
        $profile = GoogleAuthService::verifyIdToken($credential);
    } catch (InvalidArgumentException $e) {
        sendError($e->getMessage(), 401);
    } catch (RuntimeException $e) {
        error_log('Google verification unavailable: ' . $e->getMessage());
        sendError('Google sign-in is temporarily unavailable', 502);
    }

    $write = Database::write();

    $stmt = $write->prepare('SELECT * FROM users WHERE google_sub = ?');
    $stmt->execute([$profile['sub']]);
    $user = $stmt->fetch();

    if (!$user) {
        // Link by verified email if the account was created another way.
        $stmt = $write->prepare('SELECT * FROM users WHERE email = ?');
        $stmt->execute([$profile['email']]);
        $user = $stmt->fetch();
    }

    $isAdminEmail = isAdminEmail($profile['email']);

    if ($user) {
        if ((int) $user['is_active'] !== 1) {
            sendError('This account has been deactivated', 403);
        }
        $stmt = $write->prepare(
            'UPDATE users SET google_sub = ?, email = ?, display_name = ?, avatar_url = ?,
                    is_admin = IF(? = 1, 1, is_admin)
             WHERE id = ?'
        );
        $stmt->execute([
            $profile['sub'],
            $profile['email'],
            $profile['name'],
            $profile['picture'],
            $isAdminEmail ? 1 : 0,
            $user['id'],
        ]);
        $userId = (int) $user['id'];
    } else {
        $stmt = $write->prepare(
            'INSERT INTO users (google_sub, email, display_name, avatar_url, is_admin)
             VALUES (?, ?, ?, ?, ?)'
        );
        $stmt->execute([
            $profile['sub'],
            $profile['email'],
            $profile['name'],
            $profile['picture'],
            $isAdminEmail ? 1 : 0,
        ]);
        $userId = (int) $write->lastInsertId();

        // Seed the personal hub shelf with the admin-marked default tiles.
        // Best-effort: a shelf without defaults is recoverable, a failed
        // signup is not.
        try {
            require_once __DIR__ . '/../services/hub-shelf-service.php';
            seedDefaultHubApps($write, $userId);
        } catch (Throwable $e) {
            error_log('Default hub shelf seeding failed for user ' . $userId . ': ' . $e->getMessage());
        }
    }

    Auth::login($userId);
    me();
}

function passwordLogin(): void
{
    Auth::assertSameOrigin();
    $body = jsonBody();
    $identifier = isset($body['identifier']) && is_string($body['identifier'])
        ? strtolower(trim($body['identifier'])) : '';
    $password = isset($body['password']) && is_string($body['password']) ? $body['password'] : '';

    if ($identifier === '' || $password === '' || mb_strlen($identifier) > 190
        || strlen($password) > PASSWORD_MAX_LENGTH) {
        sendError('Invalid credentials', 401);
    }

    $ip = $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
    if (isRateLimited($identifier, $ip)) {
        sendError('Too many attempts, try again later', 429);
    }

    $stmt = Database::read()->prepare(
        'SELECT * FROM users WHERE (username = ? OR email = ?) LIMIT 1'
    );
    $stmt->execute([$identifier, $identifier]);
    $user = $stmt->fetch();

    // Always verify against some hash so timing does not reveal account existence.
    $hash = ($user && $user['password_hash'] !== null) ? $user['password_hash'] : DUMMY_HASH;
    $valid = password_verify($password, $hash)
        && $user && $user['password_hash'] !== null && (int) $user['is_active'] === 1;

    recordLoginAttempt($identifier, $ip, $valid);

    if (!$valid) {
        sendError('Invalid credentials', 401);
    }

    Auth::login((int) $user['id']);
    me();
}

function me(): void
{
    $user = Auth::currentUser();
    if ($user === null) {
        sendJson(['user' => null]);
    }
    sendJson([
        'user' => [
            'id'           => $user['id'],
            'email'        => $user['email'],
            'username'     => $user['username'],
            'display_name' => $user['display_name'],
            'avatar_url'   => $user['avatar_url'],
            'is_admin'     => $user['is_admin'] === 1,
            'has_password' => userHasPassword($user['id']),
            'created_at'   => $user['created_at'],
        ],
        'roles' => Auth::projectRoles($user['id']),
    ]);
}

function setCredentials(): void
{
    $user = Auth::requireLogin();
    $body = jsonBody();

    $username = isset($body['username']) && is_string($body['username']) ? trim($body['username']) : '';
    $newPassword = isset($body['new_password']) && is_string($body['new_password']) ? $body['new_password'] : '';
    $currentPassword = isset($body['current_password']) && is_string($body['current_password'])
        ? $body['current_password'] : '';

    if (!preg_match('/^[a-zA-Z0-9._-]{3,32}$/', $username)) {
        sendError('Username must be 3-32 characters: letters, digits, dot, dash, underscore', 400);
    }
    if (strlen($newPassword) < PASSWORD_MIN_LENGTH || strlen($newPassword) > PASSWORD_MAX_LENGTH) {
        sendError('Password must be between ' . PASSWORD_MIN_LENGTH . ' and ' . PASSWORD_MAX_LENGTH . ' characters', 400);
    }

    // Changing an existing password requires proving the old one.
    $stmt = Database::read()->prepare('SELECT password_hash FROM users WHERE id = ?');
    $stmt->execute([$user['id']]);
    $existingHash = $stmt->fetchColumn();
    if ($existingHash !== null && $existingHash !== false) {
        if (!password_verify($currentPassword, $existingHash)) {
            sendError('Current password is incorrect', 401);
        }
    }

    try {
        $stmt = Database::write()->prepare('UPDATE users SET username = ?, password_hash = ? WHERE id = ?');
        $stmt->execute([
            strtolower($username),
            password_hash($newPassword, PASSWORD_DEFAULT),
            $user['id'],
        ]);
    } catch (PDOException $e) {
        if ((int) $e->errorInfo[1] === 1062) { // duplicate key
            sendError('Username is already taken', 409);
        }
        throw $e;
    }

    sendJson(['message' => 'Backup credentials saved']);
}

function resetPassword(): void
{
    Auth::assertSameOrigin();
    $body = jsonBody();
    $token = isset($body['token']) && is_string($body['token']) ? trim($body['token']) : '';
    $newPassword = isset($body['new_password']) && is_string($body['new_password']) ? $body['new_password'] : '';

    if (strlen($newPassword) < PASSWORD_MIN_LENGTH || strlen($newPassword) > PASSWORD_MAX_LENGTH) {
        sendError('Password must be between ' . PASSWORD_MIN_LENGTH . ' and ' . PASSWORD_MAX_LENGTH . ' characters', 400);
    }
    if (!preg_match('/^[a-f0-9]{64}$/', $token)) {
        sendError('Invalid or expired reset link', 400);
    }

    $write = Database::write();
    $stmt = $write->prepare(
        'SELECT r.id AS reset_id, r.user_id
         FROM password_resets r
         JOIN users u ON u.id = r.user_id
         WHERE r.token_hash = ? AND r.used_at IS NULL AND r.expires_at > NOW() AND u.is_active = 1'
    );
    $stmt->execute([hash('sha256', $token)]);
    $reset = $stmt->fetch();
    if (!$reset) {
        sendError('Invalid or expired reset link', 400);
    }

    $write->beginTransaction();
    try {
        $write->prepare('UPDATE password_resets SET used_at = NOW() WHERE id = ?')
            ->execute([$reset['reset_id']]);
        $write->prepare('UPDATE users SET password_hash = ? WHERE id = ?')
            ->execute([password_hash($newPassword, PASSWORD_DEFAULT), $reset['user_id']]);
        $write->commit();
    } catch (Throwable $e) {
        $write->rollBack();
        throw $e;
    }
    Auth::revokeAllSessions((int) $reset['user_id']);

    sendJson(['message' => 'Password updated, you can now log in']);
}

function listOwnSessions(): void
{
    $user = Auth::requireLogin();
    $currentId = Auth::currentSessionId();
    $stmt = Database::read()->prepare(
        'SELECT id, ip_address, user_agent, created_at, last_seen_at, expires_at
         FROM sessions
         WHERE user_id = ? AND revoked_at IS NULL AND expires_at > NOW()
         ORDER BY last_seen_at DESC'
    );
    $stmt->execute([$user['id']]);
    $sessions = $stmt->fetchAll();
    foreach ($sessions as &$s) {
        $s['id'] = (int) $s['id'];
        $s['current'] = $s['id'] === $currentId;
    }
    sendJson($sessions);
}

function revokeOwnSession(int $id): void
{
    $user = Auth::requireLogin();
    $stmt = Database::write()->prepare(
        'UPDATE sessions SET revoked_at = NOW() WHERE id = ? AND user_id = ? AND revoked_at IS NULL'
    );
    $stmt->execute([$id, $user['id']]);
    if ($stmt->rowCount() === 0) {
        sendError('Session not found', 404);
    }
    sendJson(['message' => 'Session revoked']);
}

// ------------------------------------------------------------------
//  Rate limiting
// ------------------------------------------------------------------

function isRateLimited(string $identifier, string $ip): bool
{
    $stmt = Database::read()->prepare(
        'SELECT
            SUM(identifier = ?) AS by_identifier,
            SUM(ip_address = ?) AS by_ip
         FROM login_attempts
         WHERE success = 0 AND attempted_at > NOW() - INTERVAL ' . RATE_WINDOW_MINUTES . ' MINUTE
           AND (identifier = ? OR ip_address = ?)'
    );
    $stmt->execute([$identifier, $ip, $identifier, $ip]);
    $row = $stmt->fetch();
    return (int) ($row['by_identifier'] ?? 0) >= MAX_FAILURES_PER_IDENTIFIER
        || (int) ($row['by_ip'] ?? 0) >= MAX_FAILURES_PER_IP;
}

function recordLoginAttempt(string $identifier, string $ip, bool $success): void
{
    $write = Database::write();
    $write->prepare('INSERT INTO login_attempts (identifier, ip_address, success) VALUES (?, ?, ?)')
        ->execute([$identifier, $ip, $success ? 1 : 0]);
    // Opportunistic cleanup, there is no cron for this.
    $write->exec('DELETE FROM login_attempts WHERE attempted_at < NOW() - INTERVAL 1 DAY');
}

// ------------------------------------------------------------------
//  Helpers
// ------------------------------------------------------------------

function isAdminEmail(string $email): bool
{
    $adminEmail = strtolower(trim($_ENV['ADMIN_EMAIL'] ?? ''));
    return $adminEmail !== '' && hash_equals($adminEmail, strtolower($email));
}

function userHasPassword(int $userId): bool
{
    $stmt = Database::read()->prepare('SELECT password_hash IS NOT NULL FROM users WHERE id = ?');
    $stmt->execute([$userId]);
    return (bool) $stmt->fetchColumn();
}

function requirePost(string $method): void
{
    if ($method !== 'POST') {
        sendError('Method not allowed', 405);
    }
}

function jsonBody(): array
{
    // CSRF backstop: JSON-only endpoints refuse form-encoded bodies, so a
    // cross-site form post can never reach a handler.
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
