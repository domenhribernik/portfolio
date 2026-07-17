<?php
declare(strict_types=1);
define('SECURE_ACCESS', true);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
// Deliberately no Access-Control-Allow-Origin: the admin-only reads below are
// cookie-authed, same-origin only (see root CLAUDE.md gotchas).

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../config/auth.php';

$method = $_SERVER['REQUEST_METHOD'];
$id     = isset($_GET['id']) ? (int) $_GET['id'] : null;

try {
    if ($method === 'POST') {
        createQuote();
    } elseif ($method === 'PUT' && $id) {
        updateQuote($id);
    } elseif ($method === 'PATCH' && $id) {
        Auth::requireAdmin();
        markContacted($id);
    } elseif ($method === 'DELETE' && $id) {
        // Admin-only: lets the owner clear junk or test submissions from the
        // leads inbox (views/admin). Hard delete, mirroring the roles delete.
        Auth::requireAdmin();
        deleteQuote($id);
    } elseif ($method === 'GET' && isset($_GET['all'])) {
        // Admin leads inbox: every submitted quote, newest first.
        Auth::requireAdmin();
        listQuotes();
    } elseif ($method === 'GET' && $id) {
        // Admin-only: a quote carries the submitter's name/email/message,
        // so this can't be left open to anyone who guesses an id.
        Auth::requireAdmin();
        getQuote($id);
    } else {
        sendError('Method or resource not supported', 405);
    }
} catch (Exception $e) {
    error_log('Pricing controller error: ' . $e->getMessage());
    sendError('Internal server error', 500);
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

function getClientIp(): string
{
    $headers = ['HTTP_X_FORWARDED_FOR', 'HTTP_CLIENT_IP', 'HTTP_X_REAL_IP'];
    foreach ($headers as $header) {
        if (!empty($_SERVER[$header])) {
            $ip = trim(explode(',', $_SERVER[$header])[0]);
            if (filter_var($ip, FILTER_VALIDATE_IP)) {
                return $ip;
            }
        }
    }
    return $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
}

function sanitizeString(?string $value, int $maxLen = 500): string
{
    if ($value === null) return '';
    return mb_substr(htmlspecialchars(trim($value), ENT_QUOTES, 'UTF-8'), 0, $maxLen);
}

function createQuote(): void
{
    $data = readBody();

    $selections = $data['selections'] ?? null;
    if (!$selections || !is_array($selections)) {
        sendError('selections is required and must be an object', 400);
    }

    $suggestedPackage = sanitizeString($data['suggested_package'] ?? '', 20);
    $totalPrice       = isset($data['total_price']) ? (int) $data['total_price'] : 0;
    $specialRequests  = sanitizeString($data['special_requests'] ?? '', 2000);
    $contactName      = sanitizeString($data['contact_name']     ?? '', 100);
    $contactEmail     = sanitizeString($data['contact_email']    ?? '', 255);
    $message          = sanitizeString($data['message']          ?? '', 3000);

    if (!in_array($suggestedPackage, ['MINI', 'BASIC', 'PLUS', 'PREMIUM', 'CUSTOM'], true)) {
        sendError('Invalid suggested_package value', 400);
    }
    if ($totalPrice < 0 || $totalPrice > 99999) {
        sendError('Invalid total_price', 400);
    }

    // Store a daily-salted hash of the IP, never the raw address: enough to
    // spot abuse within a day, not reversible or identifiable across days.
    // Matches contact_messages / store_waitlist (see their model files).
    $ip        = getClientIp();
    $ipHash    = $ip !== '' && $ip !== '0.0.0.0' ? hash('sha256', $ip . '|' . gmdate('Y-m-d')) : null;
    $userAgent = mb_substr($_SERVER['HTTP_USER_AGENT'] ?? '', 0, 500);

    $stmt = Database::write()->prepare(
        'INSERT INTO pricing_quotes
             (ip_hash, user_agent, suggested_package, total_price, selections,
              special_requests, contact_name, contact_email, message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    $stmt->execute([
        $ipHash,
        $userAgent,
        $suggestedPackage,
        $totalPrice,
        json_encode($selections, JSON_UNESCAPED_UNICODE),
        $specialRequests ?: null,
        $contactName     ?: null,
        $contactEmail    ?: null,
        $message         ?: null,
    ]);

    $insertId = (int) Database::write()->lastInsertId();
    getQuote($insertId);
}

function updateQuote(int $id): void
{
    $stmt = Database::read()->prepare('SELECT id FROM pricing_quotes WHERE id = ?');
    $stmt->execute([$id]);
    if (!$stmt->fetch()) sendError('Quote not found', 404);

    $data = readBody();

    $selections = $data['selections'] ?? null;
    if (!$selections || !is_array($selections)) {
        sendError('selections is required and must be an object', 400);
    }

    $suggestedPackage = sanitizeString($data['suggested_package'] ?? '', 20);
    $totalPrice       = isset($data['total_price']) ? (int) $data['total_price'] : 0;
    $specialRequests  = sanitizeString($data['special_requests'] ?? '', 2000);
    $contactName      = sanitizeString($data['contact_name']     ?? '', 100);
    $contactEmail     = sanitizeString($data['contact_email']    ?? '', 255);
    $message          = sanitizeString($data['message']          ?? '', 3000);

    if (!in_array($suggestedPackage, ['MINI', 'BASIC', 'PLUS', 'PREMIUM', 'CUSTOM'], true)) {
        sendError('Invalid suggested_package value', 400);
    }

    $upd = Database::write()->prepare(
        'UPDATE pricing_quotes
         SET suggested_package = ?,
             total_price       = ?,
             selections        = ?,
             special_requests  = ?,
             contact_name      = ?,
             contact_email     = ?,
             message           = ?
         WHERE id = ?'
    );
    $upd->execute([
        $suggestedPackage,
        $totalPrice,
        json_encode($selections, JSON_UNESCAPED_UNICODE),
        $specialRequests ?: null,
        $contactName     ?: null,
        $contactEmail    ?: null,
        $message         ?: null,
        $id,
    ]);

    getQuote($id);
}

function getQuote(int $id): void
{
    $stmt = Database::read()->prepare(
        'SELECT id, suggested_package, total_price, selections,
                special_requests, contact_name, contact_email, message, contacted,
                created_at, updated_at
         FROM pricing_quotes WHERE id = ?'
    );
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    if (!$row) sendError('Quote not found', 404);

    $row['id']          = (int) $row['id'];
    $row['total_price'] = (int) $row['total_price'];
    $row['contacted']   = (bool) $row['contacted'];
    $row['selections']  = json_decode($row['selections'], true);

    sendJson($row);
}

function listQuotes(): void
{
    $stmt = Database::read()->query(
        'SELECT id, suggested_package, total_price, selections, special_requests,
                contact_name, contact_email, message, contacted, created_at, updated_at
         FROM pricing_quotes
         ORDER BY created_at DESC
         LIMIT 500'
    );
    $rows = $stmt->fetchAll();
    foreach ($rows as &$row) {
        $row['id']          = (int) $row['id'];
        $row['total_price'] = (int) $row['total_price'];
        $row['contacted']   = (bool) $row['contacted'];
        $row['selections']  = json_decode($row['selections'], true);
    }
    sendJson($rows);
}

function deleteQuote(int $id): void
{
    $stmt = Database::write()->prepare('DELETE FROM pricing_quotes WHERE id = ?');
    $stmt->execute([$id]);
    if ($stmt->rowCount() === 0) sendError('Quote not found', 404);
    sendJson(['message' => 'Quote deleted']);
}

function markContacted(int $id): void
{
    $data      = readBody();
    $contacted = !empty($data['contacted']) ? 1 : 0;

    $stmt = Database::write()->prepare('UPDATE pricing_quotes SET contacted = ? WHERE id = ?');
    $stmt->execute([$contacted, $id]);
    if ($stmt->rowCount() === 0) {
        $exists = Database::read()->prepare('SELECT id FROM pricing_quotes WHERE id = ?');
        $exists->execute([$id]);
        if (!$exists->fetch()) sendError('Quote not found', 404);
    }

    getQuote($id);
}
