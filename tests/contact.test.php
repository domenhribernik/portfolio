<?php
declare(strict_types=1);

// Integration tests for app/proxys/contact.php (public homepage contact form:
// validates, stores a row in contact_messages, fires a Telegram alert).
//
// Runs ONLY against the local scratch DB (127.0.0.1/portfolio): the DB_* env
// overrides below make database.php skip loading app/.env (which points at the
// remote production database) AND leave TELEGRAM_* unset, so the endpoint's
// alert call is a no-op, keeping the suite offline. Never run against prod.
//
// Setup creates contact_messages if absent; teardown deletes only the rows this
// suite inserted (their emails all end in @example.test).
//
// Run: /opt/lampp/bin/php tests/contact.test.php

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit('CLI only');
}

const DB_DSN   = 'mysql:host=127.0.0.1;port=3306;dbname=portfolio;charset=utf8mb4';
const DB_USER  = 'portfolio_dev';
const DB_PASS  = 'R2miswz1pNKOxdl4';
const PHP_BIN  = '/opt/lampp/bin/php';
const DOC_ROOT = __DIR__ . '/..';
const HOST     = '127.0.0.1';
const PORT     = 8951;
const API      = 'http://' . HOST . ':' . PORT . '/app/proxys/contact.php';
const MARKER   = '@example.test';

$passed = 0;
$failed = 0;

function check(string $name, bool $cond, string $detail = ''): void
{
    global $passed, $failed;
    if ($cond) {
        $passed++;
        echo "  ok  $name\n";
    } else {
        $failed++;
        echo "FAIL  $name" . ($detail !== '' ? "  ($detail)" : '') . "\n";
    }
}

/** @return array{status:int, body:mixed} */
function request(?string $content, string $method = 'POST', string $contentType = 'application/json'): array
{
    $opts = ['http' => ['method' => $method, 'ignore_errors' => true, 'timeout' => 10]];
    if ($content !== null) {
        $opts['http']['header']  = 'Content-Type: ' . $contentType;
        $opts['http']['content'] = $content;
    }
    $raw = @file_get_contents(API, false, stream_context_create($opts));
    $status = 0;
    foreach ($http_response_header ?? [] as $h) {
        if (preg_match('#^HTTP/\S+\s+(\d{3})#', $h, $m)) {
            $status = (int) $m[1];
        }
    }
    return ['status' => $status, 'body' => $raw !== false ? json_decode($raw, true) : null];
}

function submit(array $fields): array
{
    return request(json_encode($fields));
}

// ------------------------------------------------------------------
//  DB fixtures
// ------------------------------------------------------------------

$pdo = new PDO(DB_DSN, DB_USER, DB_PASS, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
$pdo->exec(file_get_contents(DOC_ROOT . '/app/models/contact-model.sql'));

// Everything this suite inserts lands above this id; teardown deletes exactly
// those rows (any email shape, valid or junk), touching no pre-existing data.
$BASELINE_ID = (int) $pdo->query('SELECT COALESCE(MAX(id), 0) FROM contact_messages')->fetchColumn();

function teardown(PDO $pdo): void
{
    global $BASELINE_ID;
    $stmt = $pdo->prepare('DELETE FROM contact_messages WHERE id > ?');
    $stmt->execute([$BASELINE_ID]);
}

function rowCount(PDO $pdo): int
{
    global $BASELINE_ID;
    $stmt = $pdo->prepare('SELECT COUNT(*) FROM contact_messages WHERE id > ?');
    $stmt->execute([$BASELINE_ID]);
    return (int) $stmt->fetchColumn();
}

// ------------------------------------------------------------------
//  Boot the built-in server against the LOCAL scratch DB
// ------------------------------------------------------------------

$server = proc_open(
    [PHP_BIN, '-d', 'variables_order=EGPCS', '-S', HOST . ':' . PORT, '-t', DOC_ROOT],
    [1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']],
    $pipes,
    DOC_ROOT,
    [
        'DB_HOST'   => '127.0.0.1',
        'DB_PORT'   => '3306',
        'DB_NAME'   => 'portfolio',
        'DB_USER_W' => DB_USER,
        'DB_PASS_W' => DB_PASS,
        'DB_USER_R' => DB_USER,
        'DB_PASS_R' => DB_PASS,
        'PATH'      => getenv('PATH') ?: '/usr/bin:/bin',
    ]
);

register_shutdown_function(function () use ($server, $pdo) {
    if (is_resource($server)) {
        proc_terminate($server);
    }
    teardown($pdo);
});

$ready = false;
for ($i = 0; $i < 50; $i++) {
    $sock = @fsockopen(HOST, PORT, $errno, $errstr, 0.2);
    if ($sock) {
        fclose($sock);
        $ready = true;
        break;
    }
    usleep(100_000);
}
if (!$ready) {
    fwrite(STDERR, "Built-in PHP server did not start on port " . PORT . "\n");
    exit(1);
}

// ------------------------------------------------------------------
//  Tests
// ------------------------------------------------------------------

echo "contact endpoint\n";

// Tracer: a valid submission is accepted and persisted.
$before = rowCount($pdo);
$res = submit(['name' => 'Ada Lovelace', 'email' => 'ada' . MARKER, 'message' => 'I have a project in mind.']);
check('valid submission returns 200 ok', $res['status'] === 200 && ($res['body']['ok'] ?? false) === true, "got {$res['status']}");
check('valid submission persists one row', rowCount($pdo) === $before + 1);

// Invalid input is rejected with field errors and never persisted.
$before = rowCount($pdo);
$res = submit(['name' => '', 'email' => 'not-an-email', 'message' => '']);
check('invalid submission returns 422', $res['status'] === 422, "got {$res['status']}");
check('invalid submission reports name/email/message errors',
    isset($res['body']['errors']['name'], $res['body']['errors']['email'], $res['body']['errors']['message']));
check('invalid submission persists nothing', rowCount($pdo) === $before);

// Over-length message is rejected too.
$res = submit(['name' => 'Ada', 'email' => 'ada' . MARKER, 'message' => str_repeat('x', 4001)]);
check('over-length message returns 422', $res['status'] === 422, "got {$res['status']}");

// Wrong method is refused.
$res = request(null, 'GET');
check('GET returns 405', $res['status'] === 405, "got {$res['status']}");

// Non-JSON body is a bad request.
$res = request('this is not json', 'POST');
check('malformed body returns 400', $res['status'] === 400, "got {$res['status']}");

// Honeypot: a bot that fills the hidden field is silently accepted but dropped.
$before = rowCount($pdo);
$res = submit(['name' => 'Bot', 'email' => 'bot' . MARKER, 'message' => 'spam', 'website' => 'http://spam.example']);
check('honeypot submission returns 200 (no hint to the bot)', $res['status'] === 200, "got {$res['status']}");
check('honeypot submission persists nothing', rowCount($pdo) === $before);

echo "\n$passed passed, $failed failed\n";
exit($failed === 0 ? 0 : 1);
