<?php
declare(strict_types=1);

/**
 * Google Sign-In verification service.
 *
 * Verifies a Google Identity Services ID token server-side by asking Google's
 * tokeninfo endpoint, then checking audience, issuer, expiry, and that the
 * email is verified. Chosen over local JWT verification because the site has
 * no JWT library and logins are rare; one HTTPS round trip is fine and the
 * check fails closed if Google is unreachable.
 * Does NOT touch the database, that is the controller's responsibility.
 *
 * Usage:
 *   require_once __DIR__ . '/../services/google-auth-service.php';
 *   $profile = GoogleAuthService::verifyIdToken($idToken);
 *   // $profile = ['sub' => '1234...', 'email' => 'a@b.c', 'name' => '...', 'picture' => '...']
 */
class GoogleAuthService
{
    private const TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';
    private const ALLOWED_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
    private const MAX_TOKEN_LENGTH = 4096;

    /**
     * @param  string $idToken  The `credential` JWT handed to the browser by GSI.
     * @return array  ['sub' => string, 'email' => string, 'name' => ?string, 'picture' => ?string]
     * @throws InvalidArgumentException  When the token is missing, malformed, or fails verification (treat as 401).
     * @throws RuntimeException          When verification itself cannot run (config or network, treat as 5xx).
     */
    public static function verifyIdToken(string $idToken): array
    {
        $idToken = trim($idToken);
        if ($idToken === '' || strlen($idToken) > self::MAX_TOKEN_LENGTH
            || !preg_match('/^[A-Za-z0-9._-]+$/', $idToken)) {
            throw new InvalidArgumentException('Invalid Google token');
        }

        $clientId = $_ENV['GOOGLE_CLIENT_ID'] ?? '';
        if ($clientId === '' || str_starts_with($clientId, 'REPLACE_ME')) {
            throw new RuntimeException('GOOGLE_CLIENT_ID is not configured');
        }

        $claims = self::fetchTokenInfo($idToken);

        if (!hash_equals($clientId, (string) ($claims['aud'] ?? ''))) {
            throw new InvalidArgumentException('Invalid Google token');
        }
        if (!in_array($claims['iss'] ?? '', self::ALLOWED_ISSUERS, true)) {
            throw new InvalidArgumentException('Invalid Google token');
        }
        // tokeninfo returns every claim as a string.
        if ((int) ($claims['exp'] ?? 0) <= time()) {
            throw new InvalidArgumentException('Invalid Google token');
        }
        if (($claims['email_verified'] ?? '') !== 'true' && ($claims['email_verified'] ?? '') !== true) {
            throw new InvalidArgumentException('Google account email is not verified');
        }
        $sub = (string) ($claims['sub'] ?? '');
        $email = strtolower(trim((string) ($claims['email'] ?? '')));
        if ($sub === '' || $email === '' || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
            throw new InvalidArgumentException('Invalid Google token');
        }

        return [
            'sub'     => $sub,
            'email'   => $email,
            'name'    => isset($claims['name']) ? mb_substr((string) $claims['name'], 0, 100) : null,
            'picture' => isset($claims['picture']) ? mb_substr((string) $claims['picture'], 0, 500) : null,
        ];
    }

    private static function fetchTokenInfo(string $idToken): array
    {
        $ch = curl_init(self::TOKENINFO_URL . '?id_token=' . urlencode($idToken));
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_TIMEOUT        => 10,
        ]);
        $raw = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);

        if ($raw === false) {
            throw new RuntimeException('Google token verification request failed');
        }
        $data = json_decode((string) $raw, true);
        if (!is_array($data)) {
            throw new RuntimeException('Google token verification returned invalid JSON');
        }
        // Google answers 4xx for bad/expired tokens.
        if ($status !== 200) {
            throw new InvalidArgumentException('Invalid Google token');
        }
        return $data;
    }
}
