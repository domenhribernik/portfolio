<?php
// Everbloom founding-waitlist endpoint (views/store). POST stores a signup in
// store_waitlist (durable record, one row per email) and fires a Telegram
// alert to the site owner (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID in .env).
// GET ?action=count returns the claimed/cap numbers the storefront's
// founding-spots line prints, so the scarcity copy is never made up.
// No auth by design; all consumers are same-origin. Validation mirrors
// views/store/logic.js, but the server is the real gate.

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

define('SECURE_ACCESS', true);
require_once __DIR__ . '/../config/database.php';

const MAX_EMAIL    = 255;
const MAX_NOTE     = 500;
const FOUNDING_CAP = 100;
const PLANS        = ['forever', 'petal-post', 'curious'];

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    if (($_GET['action'] ?? '') !== 'count') {
        http_response_code(400);
        echo json_encode(['error' => 'bad_request']);
        exit;
    }
    try {
        $count = (int) Database::read()->query('SELECT COUNT(*) FROM store_waitlist')->fetchColumn();
        echo json_encode(['count' => $count, 'cap' => FOUNDING_CAP]);
    } catch (Throwable $e) {
        http_response_code(503);
        echo json_encode(['error' => 'unavailable']);
    }
    exit;
}

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

$email = trim((string) ($input['email'] ?? ''));
$plan  = trim((string) ($input['plan'] ?? ''));
$note  = trim((string) ($input['note'] ?? ''));

$errors = [];
if ($email === '') {
    $errors['email'] = 'Add an email so I can save your spot.';
} elseif (mb_strlen($email) > MAX_EMAIL || !preg_match('/^[^\s@]+@[^\s@]+\.[^\s@]+$/', $email)) {
    $errors['email'] = 'That email looks off.';
}
if (!in_array($plan, PLANS, true)) {
    $errors['plan'] = 'Pick one of the three.';
}
if (mb_strlen($note) > MAX_NOTE) {
    $errors['note'] = 'That note is too long.';
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

$notified = notifyOwner($email, $plan, $note) ? 1 : 0;

// One row per email: re-submitting updates the plan and note instead of
// duplicating, and the response stays a plain ok either way.
$db = Database::write();
$stmt = $db->prepare(
    'INSERT INTO store_waitlist (email, plan, note, ip_hash, user_agent, notified)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE plan = VALUES(plan), note = COALESCE(VALUES(note), note)'
);
$stmt->execute([$email, $plan, $note !== '' ? $note : null, $ipHash, $userAgent, $notified]);

echo json_encode(['ok' => true]);

/**
 * Fire a Telegram alert to the site owner. Best-effort: any missing config or
 * network error just returns false (the signup is already safe in the DB).
 */
function notifyOwner(string $email, string $plan, string $note): bool
{
    $token  = $_ENV['TELEGRAM_BOT_TOKEN'] ?? '';
    $chatId = $_ENV['TELEGRAM_CHAT_ID'] ?? '';
    if ($token === '' || $chatId === '') {
        return false;
    }

    $esc = fn (string $s) => htmlspecialchars($s, ENT_QUOTES, 'UTF-8');
    $text = "<b>New Everbloom signup</b>\n"
        . "<b>Email:</b> " . $esc($email) . "\n"
        . "<b>Plan:</b> " . $esc($plan)
        . ($note !== '' ? "\n\n" . $esc($note) : '');

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
