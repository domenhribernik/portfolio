<?php
declare(strict_types=1);

if (!defined('SECURE_ACCESS')) {
    header('HTTP/1.0 403 Forbidden');
    exit('Access denied.');
}

require_once __DIR__ . '/database.php';

/**
 * Shared authentication and authorization gate.
 *
 * This is intentionally a single shared include (like database.php), unlike the
 * copy-pasted per-controller helpers elsewhere: a drifted copy of an auth check
 * is a security bug, not a style inconsistency.
 *
 * Session model: an opaque random token lives in an httpOnly cookie; only its
 * SHA-256 hash is stored in the `sessions` table, so a DB dump cannot hijack
 * sessions. Lifetime is sliding: requests seen with less than half the lifetime
 * remaining extend the session (and cookie) to a full lifetime again.
 *
 * Controller usage:
 *   require_once __DIR__ . '/../config/auth.php';
 *   $user = Auth::requireLogin();                       // any signed-in user
 *   $user = Auth::requireAdmin();                       // site admin only
 *   $user = Auth::requireProjectRole('images', 'editor'); // per-project role (admins pass)
 */
class Auth
{
    public const COOKIE_NAME = 'portfolio_sid';
    public const SESSION_LIFETIME_DAYS = 30;
    public const RENEW_THRESHOLD_DAYS = 15;
    public const RESET_TTL_HOURS = 48;
    private const LAST_SEEN_GRANULARITY_MIN = 10;

    private static bool $resolved = false;
    private static ?array $user = null;
    private static ?array $session = null;

    // ------------------------------------------------------------------
    //  Reading the current session
    // ------------------------------------------------------------------

    /** Returns the signed-in user row (without password_hash) or null. */
    public static function currentUser(): ?array
    {
        self::resolve();
        return self::$user;
    }

    /** Id of the session backing the current request, or null. */
    public static function currentSessionId(): ?int
    {
        self::resolve();
        return self::$session['id'] ?? null;
    }

    /** Project roles of a user: [{project_key, role, permissions}]. */
    public static function projectRoles(int $userId): array
    {
        $stmt = Database::read()->prepare(
            'SELECT p.project_key, r.role, r.permissions
             FROM user_project_roles r
             JOIN projects p ON p.id = r.project_id
             WHERE r.user_id = ? AND p.active = 1
             ORDER BY p.project_key'
        );
        $stmt->execute([$userId]);
        $roles = $stmt->fetchAll();
        foreach ($roles as &$row) {
            $row['permissions'] = $row['permissions'] !== null
                ? json_decode($row['permissions'], true)
                : null;
        }
        return $roles;
    }

    /**
     * True when the current user is a site admin or holds a role in the
     * project. Pass $role to require that exact role, omit it to accept any.
     */
    public static function hasProjectRole(string $projectKey, ?string $role = null): bool
    {
        $user = self::currentUser();
        if ($user === null) {
            return false;
        }
        if ((int) $user['is_admin'] === 1) {
            return true;
        }
        $stmt = Database::read()->prepare(
            'SELECT r.role
             FROM user_project_roles r
             JOIN projects p ON p.id = r.project_id
             WHERE r.user_id = ? AND p.project_key = ? AND p.active = 1'
        );
        $stmt->execute([$user['id'], $projectKey]);
        $found = $stmt->fetchColumn();
        if ($found === false) {
            return false;
        }
        return $role === null || $found === $role;
    }

    // ------------------------------------------------------------------
    //  Gates (each one denies the request and exits on failure)
    // ------------------------------------------------------------------

    public static function requireLogin(): array
    {
        self::assertSameOrigin();
        $user = self::currentUser();
        if ($user === null) {
            self::deny(401, 'Authentication required');
        }
        return $user;
    }

    public static function requireAdmin(): array
    {
        $user = self::requireLogin();
        if ((int) $user['is_admin'] !== 1) {
            self::deny(403, 'Forbidden');
        }
        return $user;
    }

    public static function requireProjectRole(string $projectKey, ?string $role = null): array
    {
        $user = self::requireLogin();
        if (!self::hasProjectRole($projectKey, $role)) {
            self::deny(403, 'Forbidden');
        }
        return $user;
    }

    /**
     * CSRF backstop: reject unsafe methods whose Origin header is present but
     * does not match this host. Also called by the unauthenticated login
     * endpoints, which have no session to gate on.
     */
    public static function assertSameOrigin(): void
    {
        $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
        if (in_array($method, ['GET', 'HEAD', 'OPTIONS'], true)) {
            return;
        }
        $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
        if ($origin === '') {
            return; // non-browser clients (curl) send no Origin
        }
        $host = parse_url($origin, PHP_URL_HOST);
        if (!is_string($host) || $host === '') {
            self::deny(403, 'Cross-origin request rejected');
        }
        $port = parse_url($origin, PHP_URL_PORT);
        $originHost = strtolower($host . ($port !== null ? ':' . $port : ''));
        $expected = strtolower($_SERVER['HTTP_HOST'] ?? '');
        if ($expected === '' || !hash_equals($expected, $originHost)) {
            self::deny(403, 'Cross-origin request rejected');
        }
    }

    // ------------------------------------------------------------------
    //  Session lifecycle
    // ------------------------------------------------------------------

    /** Opens a new session for the user and sets the cookie. */
    public static function login(int $userId): void
    {
        $token = bin2hex(random_bytes(32));
        $expiresAt = date('Y-m-d H:i:s', time() + self::SESSION_LIFETIME_DAYS * 86400);
        $userAgent = isset($_SERVER['HTTP_USER_AGENT'])
            ? mb_substr($_SERVER['HTTP_USER_AGENT'], 0, 255)
            : null;

        $stmt = Database::write()->prepare(
            'INSERT INTO sessions (user_id, token_hash, ip_address, user_agent, expires_at)
             VALUES (?, ?, ?, ?, ?)'
        );
        $stmt->execute([
            $userId,
            hash('sha256', $token),
            $_SERVER['REMOTE_ADDR'] ?? null,
            $userAgent,
            $expiresAt,
        ]);

        Database::write()
            ->prepare('UPDATE users SET last_login_at = NOW() WHERE id = ?')
            ->execute([$userId]);

        self::setSessionCookie($token, time() + self::SESSION_LIFETIME_DAYS * 86400);
        // Make the fresh session visible to currentUser() within this same
        // request (the Set-Cookie header only reaches $_COOKIE next request).
        $_COOKIE[self::COOKIE_NAME] = $token;
        self::$resolved = false;
        self::$user = null;
        self::$session = null;
    }

    /** Revokes the current session (if any) and clears the cookie. */
    public static function logout(): void
    {
        self::resolve();
        if (self::$session !== null) {
            Database::write()
                ->prepare('UPDATE sessions SET revoked_at = NOW() WHERE id = ?')
                ->execute([self::$session['id']]);
        }
        self::setSessionCookie('', time() - 3600);
        self::$user = null;
        self::$session = null;
    }

    /** Revokes every open session of a user (deactivation, password reset). */
    public static function revokeAllSessions(int $userId): void
    {
        Database::write()
            ->prepare('UPDATE sessions SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL')
            ->execute([$userId]);
    }

    // ------------------------------------------------------------------
    //  Internals
    // ------------------------------------------------------------------

    private static function resolve(): void
    {
        if (self::$resolved) {
            return;
        }
        self::$resolved = true;

        $token = $_COOKIE[self::COOKIE_NAME] ?? '';
        if (!is_string($token) || !preg_match('/^[a-f0-9]{64}$/', $token)) {
            return;
        }

        $stmt = Database::read()->prepare(
            'SELECT s.id AS session_id, s.expires_at AS session_expires_at,
                    s.last_seen_at AS session_last_seen_at, u.*
             FROM sessions s
             JOIN users u ON u.id = s.user_id
             WHERE s.token_hash = ? AND s.revoked_at IS NULL
               AND s.expires_at > NOW() AND u.is_active = 1'
        );
        $stmt->execute([hash('sha256', $token)]);
        $row = $stmt->fetch();
        if (!$row) {
            return;
        }

        self::$session = [
            'id'           => (int) $row['session_id'],
            'expires_at'   => $row['session_expires_at'],
            'last_seen_at' => $row['session_last_seen_at'],
        ];
        unset($row['session_id'], $row['session_expires_at'], $row['session_last_seen_at'], $row['password_hash']);
        $row['id'] = (int) $row['id'];
        $row['is_admin'] = (int) $row['is_admin'];
        $row['is_active'] = (int) $row['is_active'];
        self::$user = $row;

        self::maintainSession($token);
    }

    /** Sliding expiration and throttled last_seen_at updates. */
    private static function maintainSession(string $token): void
    {
        $now = time();
        $expiresAt = strtotime(self::$session['expires_at']);
        $lastSeen = strtotime(self::$session['last_seen_at']);
        $updates = [];
        $params = [];

        if ($expiresAt !== false && $expiresAt - $now < self::RENEW_THRESHOLD_DAYS * 86400) {
            $newExpiry = $now + self::SESSION_LIFETIME_DAYS * 86400;
            $updates[] = 'expires_at = ?';
            $params[] = date('Y-m-d H:i:s', $newExpiry);
            self::setSessionCookie($token, $newExpiry);
        }
        if ($lastSeen === false || $now - $lastSeen > self::LAST_SEEN_GRANULARITY_MIN * 60) {
            $updates[] = 'last_seen_at = NOW()';
        }
        if ($updates === []) {
            return;
        }
        $params[] = self::$session['id'];
        Database::write()
            ->prepare('UPDATE sessions SET ' . implode(', ', $updates) . ' WHERE id = ?')
            ->execute($params);
    }

    private static function setSessionCookie(string $value, int $expires): void
    {
        // Secure only in prod: local XAMPP is plain http and would drop the cookie.
        $secure = !($GLOBALS['DEV_MODE'] ?? false);
        setcookie(self::COOKIE_NAME, $value, [
            'expires'  => $expires,
            'path'     => '/',
            'secure'   => $secure,
            'httponly' => true,
            'samesite' => 'Lax',
        ]);
    }

    private static function deny(int $code, string $message): never
    {
        http_response_code($code);
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store');
        echo json_encode(['error' => $message], JSON_UNESCAPED_UNICODE);
        exit;
    }
}
