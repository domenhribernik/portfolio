<?php
// Public homepage contact endpoint. Accepts a POSTed JSON message from the
// colophon form, stores it in contact_messages (durable record) and fires a
// Telegram alert to the site owner (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID in
// .env). No auth by design; all consumers are same-origin. Validation mirrors
// views/homepage/contact-logic.js, but the server is the real gate.

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

define('SECURE_ACCESS', true);
require_once __DIR__ . '/../config/database.php';

const MAX_NAME    = 120;
const MAX_EMAIL   = 255;
const MAX_MESSAGE = 4000;

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'method_not_allowed']);
    exit;
}

$raw = file_get_contents('php://input');
$input = json_decode($raw, true);
if (!is_array($input)) {
    http_response_code(400);
    echo json_encode(['error' => 'bad_request']);
    exit;
}

// Honeypot: `website` is a hidden field a human never sees or fills. A bot that
// populates it gets a clean 200 (no signal that it was caught) but nothing is
// stored or sent.
if (trim((string) ($input['website'] ?? '')) !== '') {
    echo json_encode(['ok' => true]);
    exit;
}

$name    = trim((string) ($input['name'] ?? ''));
$email   = trim((string) ($input['email'] ?? ''));
$message = trim((string) ($input['message'] ?? ''));

$errors = [];
if ($name === '') {
    $errors['name'] = 'Please add your name.';
} elseif (mb_strlen($name) > MAX_NAME) {
    $errors['name'] = 'Name is too long.';
}
if ($email === '') {
    $errors['email'] = 'Please add an email so I can reply.';
} elseif (mb_strlen($email) > MAX_EMAIL || !preg_match('/^[^\s@]+@[^\s@]+\.[^\s@]+$/', $email)) {
    $errors['email'] = 'That email looks off.';
}
if ($message === '') {
    $errors['message'] = 'Tell me a little about it.';
} elseif (mb_strlen($message) > MAX_MESSAGE) {
    $errors['message'] = 'That message is too long.';
}
if ($errors) {
    http_response_code(422);
    echo json_encode(['error' => 'invalid', 'errors' => $errors]);
    exit;
}

// Coarse abuse tracing, not PII: a daily-salted hash, so the same visitor is
// stable within a day but not identifiable across days or reversible to an IP.
$ip = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
$ipHash = $ip !== '' ? hash('sha256', $ip . '|' . date('Y-m-d')) : null;
$userAgent = mb_substr((string) ($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 255) ?: null;

$notified = notifyOwner($name, $email, $message) ? 1 : 0;

$db = Database::write();
$stmt = $db->prepare(
    'INSERT INTO contact_messages (name, email, message, ip_hash, user_agent, notified)
     VALUES (?, ?, ?, ?, ?, ?)'
);
$stmt->execute([$name, $email, $message, $ipHash, $userAgent, $notified]);

echo json_encode(['ok' => true]);

/**
 * Fire a Telegram alert to the site owner. Best-effort: any missing config or
 * network error just returns false (the message is already safe in the DB).
 */
function notifyOwner(string $name, string $email, string $message): bool
{
    $token  = $_ENV['TELEGRAM_BOT_TOKEN'] ?? '';
    $chatId = $_ENV['TELEGRAM_CHAT_ID'] ?? '';
    if ($token === '' || $chatId === '') {
        return false;
    }

    $esc = fn (string $s) => htmlspecialchars($s, ENT_QUOTES, 'UTF-8');
    $text = "<b>New contact message</b>\n"
        . "<b>From:</b> " . $esc($name) . "\n"
        . "<b>Email:</b> " . $esc($email) . "\n\n"
        . $esc($message);

    $ch = curl_init("https://api.telegram.org/bot{$token}/sendMessage");
    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 5,
        CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
        CURLOPT_POSTFIELDS     => json_encode([
            'chat_id'                  => $chatId,
            'text'                     => $text,
            'parse_mode'               => 'HTML',
            'disable_web_page_preview' => true,
        ]),
    ]);
    $ok = curl_exec($ch) !== false && curl_getinfo($ch, CURLINFO_HTTP_CODE) === 200;
    curl_close($ch);
    return $ok;
}
