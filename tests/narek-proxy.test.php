<?php
declare(strict_types=1);

// Integration tests for app/proxys/narek.php, the Gemini side of the Narek
// dictation sheet (views/narek).
//
// The contract this suite exists to hold: Narek is a PRIVATE single-owner tool
// running on the owner's Gemini key, so EVERY paid branch sits behind
// Auth::requireAdmin(). Anonymous is 401, a signed-in non-admin is 403, and in
// both cases *nothing reaches Gemini* and the rate ledger is never touched.
// That last part is asserted against the stub's call log, not inferred.
//
// Runs ONLY against the local scratch DB (127.0.0.1/portfolio): the DB_* env
// overrides below make database.php skip loading app/.env (which points at the
// remote production database). Never run these against prod.
//
// Fixtures follow the repo convention:
//   admin@test.local  session token = 64 x 'a'
//   guest@test.local  session token = 64 x 'b'
// Setup applies app/models/auth-model.sql and seeds those two users and their
// sessions if absent; teardown removes only the rows this run created.
//
// A second built-in server runs tests/fixtures/gemini-stub.php with
// GEMINI_API_BASE pointed at it, so no request ever reaches Google and no real
// key is ever loaded. A third, booted against a mirrored tree with no .env,
// covers the missing-key path without any chance of picking up the real key.
//
// Run: /opt/lampp/bin/php tests/narek-proxy.test.php

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit('CLI only');
}

const DB_DSN      = 'mysql:host=127.0.0.1;port=3306;dbname=portfolio;charset=utf8mb4';
const DB_USER     = 'portfolio_dev';
const DB_PASS     = 'R2miswz1pNKOxdl4';
const PHP_BIN     = '/opt/lampp/bin/php';
const DOC_ROOT    = __DIR__ . '/..';
const HOST        = '127.0.0.1';
const PORT        = 8953;
const STUB_PORT   = 8954;
const NOKEY_PORT  = 8955;
const API         = 'http://' . HOST . ':' . PORT . '/app/proxys/narek.php';

$ADMIN_SID = str_repeat('a', 64);
$GUEST_SID = str_repeat('b', 64);

// ------------------------------------------------------------------
//  Tiny assertion runner
// ------------------------------------------------------------------

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

// ------------------------------------------------------------------
//  Scratch state
// ------------------------------------------------------------------

$scratch = sys_get_temp_dir() . '/narek-test-' . getmypid();
@mkdir($scratch, 0775, true);

$rateFile = $scratch . '/rate.json';
$stubLog  = $scratch . '/gemini.log';
$scenario = $scratch . '/scenario.json';

register_shutdown_function(static function () use ($scratch) {
    if (!is_dir($scratch)) {
        return;
    }
    $items = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($scratch, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::CHILD_FIRST
    );
    foreach ($items as $item) {
        if ($item->isLink() || !$item->isDir()) {
            @unlink($item->getPathname());
        } else {
            @rmdir($item->getPathname());
        }
    }
    @rmdir($scratch);
});

function scenario(array $data): void
{
    global $scenario;
    file_put_contents($scenario, json_encode($data));
}

function resetRate(): void
{
    global $rateFile;
    @unlink($rateFile);
}

/** @return array<int, array<string, mixed>> every call the stub has logged */
function stubCalls(): array
{
    global $stubLog;
    if (!is_file($stubLog)) {
        return [];
    }
    $out = [];
    foreach (explode("\n", trim((string) file_get_contents($stubLog))) as $line) {
        if ($line !== '') {
            $out[] = json_decode($line, true);
        }
    }
    return $out;
}

function resetStubLog(): void
{
    global $stubLog;
    @unlink($stubLog);
}

// ------------------------------------------------------------------
//  Auth fixtures
// ------------------------------------------------------------------

try {
    $pdo = new PDO(DB_DSN, DB_USER, DB_PASS, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
} catch (Throwable $e) {
    fwrite(STDERR, "No local scratch DB at 127.0.0.1/portfolio: " . $e->getMessage() . "\n");
    exit(1);
}

// CREATE TABLE IF NOT EXISTS throughout, so this is a no-op once seeded.
$schema = (string) file_get_contents(DOC_ROOT . '/app/models/auth-model.sql');
$schema = preg_replace('/^\s*--.*$/m', '', $schema); // strip comments BEFORE splitting on ';'
foreach (array_filter(array_map('trim', explode(';', (string) $schema))) as $sql) {
    $pdo->exec($sql);
}

$createdUsers    = [];
$createdSessions = [];

/** Returns the user id, creating the fixture if this run has to. */
function fixtureUser(PDO $pdo, string $email, int $isAdmin): int
{
    global $createdUsers;
    $stmt = $pdo->prepare('SELECT id FROM users WHERE email = ?');
    $stmt->execute([$email]);
    $id = (int) $stmt->fetchColumn();
    if ($id > 0) {
        return $id;
    }
    $pdo->prepare('INSERT INTO users (email, display_name, is_admin, is_active) VALUES (?, ?, ?, 1)')
        ->execute([$email, $email === 'admin@test.local' ? 'Test Admin' : 'Test Guest', $isAdmin]);
    $id = (int) $pdo->lastInsertId();
    $createdUsers[] = $id;
    return $id;
}

/** Seeds a 30-day session for the given raw token if one is not already live. */
function fixtureSession(PDO $pdo, int $userId, string $token): void
{
    global $createdSessions;
    $hash = hash('sha256', $token);
    $stmt = $pdo->prepare('SELECT id FROM sessions WHERE token_hash = ?');
    $stmt->execute([$hash]);
    if ((int) $stmt->fetchColumn() > 0) {
        return;
    }
    $pdo->prepare(
        'INSERT INTO sessions (user_id, token_hash, expires_at)
         VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 30 DAY))'
    )->execute([$userId, $hash]);
    $createdSessions[] = (int) $pdo->lastInsertId();
}

$adminId = fixtureUser($pdo, 'admin@test.local', 1);
$guestId = fixtureUser($pdo, 'guest@test.local', 0);
fixtureSession($pdo, $adminId, $ADMIN_SID);
fixtureSession($pdo, $guestId, $GUEST_SID);

register_shutdown_function(static function () use ($pdo, &$createdUsers, &$createdSessions) {
    foreach ($createdSessions as $id) {
        $pdo->prepare('DELETE FROM sessions WHERE id = ?')->execute([$id]);
    }
    foreach ($createdUsers as $id) {
        $pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$id]);
    }
});

// ------------------------------------------------------------------
//  HTTP helper
// ------------------------------------------------------------------

/**
 * @param array<string, string> $headers
 * @return array{status:int, body:mixed, raw:string}
 */
function request(
    string $query,
    ?string $content = null,
    string $method = 'POST',
    ?string $sid = null,
    array $headers = [],
    string $base = API
): array {
    $lines = [];
    if ($sid !== null) {
        $lines[] = 'Cookie: portfolio_sid=' . $sid;
    }
    foreach ($headers as $name => $value) {
        $lines[] = "$name: $value";
    }
    $opts = ['http' => [
        'method'        => $method,
        'ignore_errors' => true,
        'timeout'       => 20,
    ]];
    if ($lines) {
        $opts['http']['header'] = implode("\r\n", $lines);
    }
    if ($content !== null) {
        $opts['http']['content'] = $content;
    }

    $raw = @file_get_contents($base . '?' . $query, false, stream_context_create($opts));
    $status = 0;
    foreach ($http_response_header ?? [] as $header) {
        if (preg_match('#^HTTP/\S+\s+(\d{3})#', $header, $m)) {
            $status = (int) $m[1];
        }
    }
    return [
        'status' => $status,
        'body'   => $raw !== false ? json_decode($raw, true) : null,
        'raw'    => $raw !== false ? $raw : '',
    ];
}

/** A minimal but real 16 kHz mono WAV, so the proxy's RIFF check sees the truth. */
function wav(int $samples = 800): string
{
    $data = str_repeat("\x00\x10", $samples);
    return 'RIFF' . pack('V', 36 + strlen($data)) . 'WAVE'
        . 'fmt ' . pack('V', 16) . pack('v', 1) . pack('v', 1)
        . pack('V', 16000) . pack('V', 32000) . pack('v', 2) . pack('v', 16)
        . 'data' . pack('V', strlen($data)) . $data;
}

// ------------------------------------------------------------------
//  Boot
// ------------------------------------------------------------------

scenario(['text' => 'Danes je lep dan.']);

$stubBase = 'http://' . HOST . ':' . STUB_PORT . '/tests/fixtures/gemini-stub.php';

$common = [
    'PATH'      => getenv('PATH') ?: '/usr/bin:/bin',
    // LOCAL scratch DB only. These overrides make database.php skip app/.env,
    // which points at the remote production database.
    'DB_HOST'   => '127.0.0.1',
    'DB_PORT'   => '3306',
    'DB_NAME'   => 'portfolio',
    'DB_USER_W' => DB_USER,
    'DB_PASS_W' => DB_PASS,
    'DB_USER_R' => DB_USER,
    'DB_PASS_R' => DB_PASS,
    // A stub key, never the real one: the proxy reads env before app/.env.
    'GEMINI_API_KEY'       => 'test-key-not-real',
    'GEMINI_API_BASE'      => $stubBase,
    'GEMINI_STUB_LOG'      => $stubLog,
    'GEMINI_STUB_SCENARIO' => $scenario,
    'NAREK_RATE_FILE'      => $rateFile,
    'NAREK_MAX_PER_MIN'    => '6',
    'NAREK_MAX_PER_DAY'    => '9',
];
if (PHP_OS_FAMILY === 'Windows') {
    $common['SystemRoot'] = getenv('SystemRoot') ?: 'C:\\Windows';
}

// Mirror app/'s shape with no .env in it, so the proxy's own dotenv fallback
// finds nothing and the missing-key path can be tested with zero risk of
// picking up the real key. vendor is symlinked so database.php still boots.
@mkdir($scratch . '/proxys', 0775, true);
@mkdir($scratch . '/config', 0775, true);
copy(DOC_ROOT . '/app/proxys/narek.php', $scratch . '/proxys/narek.php');
foreach (['dev-mode.php', 'database.php', 'auth.php'] as $file) {
    copy(DOC_ROOT . '/app/config/' . $file, $scratch . '/config/' . $file);
}
@symlink(DOC_ROOT . '/app/vendor', $scratch . '/vendor');

$nokeyEnv = $common;
$nokeyEnv['GEMINI_API_KEY']  = '';
$nokeyEnv['NAREK_RATE_FILE'] = $scratch . '/rate-nokey.json';

$nullDev = '/dev/null';
$servers = [];
foreach ([[PORT, DOC_ROOT, $common], [STUB_PORT, DOC_ROOT, $common], [NOKEY_PORT, $scratch, $nokeyEnv]] as [$port, $root, $env]) {
    $servers[] = proc_open(
        [PHP_BIN, '-d', 'variables_order=EGPCS', '-S', HOST . ':' . $port, '-t', $root],
        [1 => ['file', $nullDev, 'w'], 2 => ['file', $nullDev, 'w']],
        $pipes,
        $root,
        $env
    );
}

register_shutdown_function(static function () use ($servers) {
    foreach ($servers as $server) {
        if (is_resource($server)) {
            proc_terminate($server);
        }
    }
});

foreach ([PORT, STUB_PORT, NOKEY_PORT] as $port) {
    $ready = false;
    for ($i = 0; $i < 50; $i++) {
        $sock = @fsockopen(HOST, $port, $errno, $errstr, 0.2);
        if ($sock) {
            fclose($sock);
            $ready = true;
            break;
        }
        usleep(100_000);
    }
    if (!$ready) {
        fwrite(STDERR, "Built-in PHP server did not start on port $port\n");
        exit(1);
    }
}

// ==================================================================
//  The gate. This is the contract the whole tool depends on.
// ==================================================================

echo "\n-- the admin gate --\n";
resetRate();
resetStubLog();

$res = request('action=status', null, 'GET');
check('anonymous status probe is 401', $res['status'] === 401, (string) $res['status']);

$res = request('action=transcribe', wav());
check('anonymous transcribe is 401', $res['status'] === 401, (string) $res['status']);

$res = request('action=translate', wav());
check('anonymous translate is 401', $res['status'] === 401, (string) $res['status']);

$res = request('action=correct', json_encode(['text' => 'nekaj besedila']));
check('anonymous correct is 401', $res['status'] === 401, (string) $res['status']);

$res = request('action=transcribe', wav(), 'POST', str_repeat('f', 64));
check('an unknown session token is 401', $res['status'] === 401, (string) $res['status']);

$res = request('action=transcribe', wav(), 'POST', 'not-a-valid-token');
check('a malformed cookie is 401', $res['status'] === 401, (string) $res['status']);

$res = request('action=status', null, 'GET', $GUEST_SID);
check('a signed-in non-admin is 403 on the probe', $res['status'] === 403, (string) $res['status']);

$res = request('action=transcribe', wav(), 'POST', $GUEST_SID);
check('a signed-in non-admin is 403 on transcribe', $res['status'] === 403, (string) $res['status']);

$res = request('action=translate', wav(), 'POST', $GUEST_SID);
check('a signed-in non-admin is 403 on translate', $res['status'] === 403, (string) $res['status']);

$res = request('action=correct', json_encode(['text' => 'nekaj besedila']), 'POST', $GUEST_SID);
check('a signed-in non-admin is 403 on correct', $res['status'] === 403, (string) $res['status']);

// The point of all of the above: none of it can spend the owner's quota.
check('nothing denied ever reached Gemini', stubCalls() === [], json_encode(stubCalls()));
check('denied requests never touched the rate ledger', !is_file($rateFile));

$res = request('action=status', null, 'GET', $ADMIN_SID);
check('the admin passes the probe', $res['status'] === 200 && ($res['body']['ok'] ?? false) === true);
check('the probe reports the key is configured', ($res['body']['ready'] ?? null) === true);
check('the probe names the signed-in user', ($res['body']['user']['name'] ?? '') === 'Test Admin');
check('the probe alone costs nothing upstream', stubCalls() === []);

// ==================================================================
//  Request guards
// ==================================================================

echo "\n-- request guards --\n";
resetRate();

$res = request('action=transcribe', wav(), 'GET', $ADMIN_SID);
check('transcribe refuses GET', $res['status'] === 405 && ($res['body']['error'] ?? '') === 'method_not_allowed');

$res = request('action=summarise', wav(), 'POST', $ADMIN_SID);
check('an unknown action is 400', $res['status'] === 400 && ($res['body']['error'] ?? '') === 'bad_request');

$res = request('', wav(), 'POST', $ADMIN_SID);
check('a missing action is 400', $res['status'] === 400);

$res = request('action=transcribe', wav(), 'POST', $ADMIN_SID, ['Origin' => 'https://evil.example']);
check('a cross-origin POST is refused even for the admin',
    $res['status'] === 403 && ($res['body']['error'] ?? '') === 'bad_origin');

$res = request('action=transcribe', wav(), 'POST', $ADMIN_SID, ['Origin' => 'http://' . HOST . ':' . PORT]);
check('a same-origin POST is allowed', $res['status'] === 200);

$res = request('action=transcribe', '', 'POST', $ADMIN_SID);
check('an empty body is 400', $res['status'] === 400 && ($res['body']['error'] ?? '') === 'bad_request');

$res = request('action=transcribe', 'this is not a wav file at all', 'POST', $ADMIN_SID);
check('a non-RIFF body is refused before Gemini is called',
    $res['status'] === 400 && ($res['body']['error'] ?? '') === 'bad_audio');

$res = request('action=transcribe', 'RIFF' . str_repeat('x', 5 * 1024 * 1024), 'POST', $ADMIN_SID);
check('an oversized upload is 413', $res['status'] === 413 && ($res['body']['error'] ?? '') === 'too_large');

$res = request('action=correct', '{"text": ""}', 'POST', $ADMIN_SID);
check('correct rejects empty text', $res['status'] === 400);

$res = request('action=correct', 'not json', 'POST', $ADMIN_SID);
check('correct rejects a non-JSON body', $res['status'] === 400);

// ==================================================================
//  Transcribe
// ==================================================================

echo "\n-- transcribe --\n";
resetRate();
resetStubLog();
scenario(['text' => 'Danes je lep dan.']);

$res = request('action=transcribe', wav(), 'POST', $ADMIN_SID);
check('happy path returns the model text', $res['status'] === 200 && ($res['body']['text'] ?? '') === 'Danes je lep dan.');
check('the response names the model used', ($res['body']['model'] ?? '') === 'gemini-2.5-flash');
check('the response reports a latency', is_int($res['body']['ms'] ?? null));

$first = stubCalls()[0] ?? [];
check('the key travels in the header, never the URL', ($first['key'] ?? '') === 'test-key-not-real');
check('the audio is sent as inline base64 WAV',
    ($first['body']['contents'][0]['parts'][1]['inline_data']['mime_type'] ?? '') === 'audio/wav');
check('the audio round-trips intact',
    base64_decode($first['body']['contents'][0]['parts'][1]['inline_data']['data'] ?? '', true) === wav());
check('temperature is pinned to zero', ($first['body']['generationConfig']['temperature'] ?? null) === 0);
check('thinking is disabled on a 2.5 model',
    ($first['body']['generationConfig']['thinkingConfig']['thinkingBudget'] ?? null) === 0);
check('the prompt asks for Slovenian verbatim',
    str_contains($first['body']['contents'][0]['parts'][0]['text'] ?? '', 'slovenskega govora'));
check('no vocabulary clause without terms',
    !str_contains($first['body']['contents'][0]['parts'][0]['text'] ?? '', 'Lastna imena'));

resetStubLog();
request('action=transcribe&vocab=' . urlencode('Kranjska Gora, Hribernik,x, Kranjska Gora'), wav(), 'POST', $ADMIN_SID);
$prompt = stubCalls()[0]['body']['contents'][0]['parts'][0]['text'] ?? '';
check('vocabulary terms reach the prompt', str_contains($prompt, 'Kranjska Gora') && str_contains($prompt, 'Hribernik'));
check('one-character terms are dropped', !preg_match('/[,:]\s*x\s*[.,]/', $prompt));
check('duplicate terms appear once', substr_count($prompt, 'Kranjska Gora') === 1);

resetStubLog();
scenario(['parts' => [['text' => 'Prvi del '], ['text' => 'in drugi.']]]);
$res = request('action=transcribe', wav(), 'POST', $ADMIN_SID);
check('several text parts are joined', ($res['body']['text'] ?? '') === 'Prvi del in drugi.');

scenario(['parts' => []]);
$res = request('action=transcribe', wav(), 'POST', $ADMIN_SID);
check('a candidate with no text yields an empty string, not an error',
    $res['status'] === 200 && ($res['body']['text'] ?? null) === '');

// ==================================================================
//  Model fallback
// ==================================================================

echo "\n-- model fallback --\n";
resetRate();
resetStubLog();
scenario(['missing' => ['gemini-2.5-flash'], 'text' => 'Prek rezerve.']);

$res = request('action=transcribe', wav(), 'POST', $ADMIN_SID);
$tried = array_column(stubCalls(), 'model');
check('a 404 falls through to the next model', $res['status'] === 200 && ($res['body']['text'] ?? '') === 'Prek rezerve.');
check('both models were tried in order', $tried === ['gemini-2.5-flash', 'gemini-2.0-flash'], implode(',', $tried));
check('the response names the model that actually answered', ($res['body']['model'] ?? '') === 'gemini-2.0-flash');

resetStubLog();
scenario(['missing' => ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash']]);
$res = request('action=transcribe', wav(), 'POST', $ADMIN_SID);
check('every model missing is a 502, not a hang', $res['status'] === 502);
check('the chain stops after the last candidate', count(stubCalls()) === 3);

resetStubLog();
scenario(['status' => 500, 'message' => 'boom']);
$res = request('action=transcribe', wav(), 'POST', $ADMIN_SID);
check('a 500 stops the chain instead of retrying every model', count(stubCalls()) === 1);
check('a 500 surfaces as 502 upstream', $res['status'] === 502 && ($res['body']['error'] ?? '') === 'upstream');
check('the upstream message is not leaked to the client', !str_contains(strtolower($res['raw']), 'boom'));

scenario(['status' => 429]);
$res = request('action=transcribe', wav(), 'POST', $ADMIN_SID);
check('an upstream quota error keeps its 429', $res['status'] === 429 && ($res['body']['error'] ?? '') === 'upstream_rate');

scenario(['status' => 403]);
$res = request('action=transcribe', wav(), 'POST', $ADMIN_SID);
check('a rejected key says so specifically', $res['status'] === 502 && ($res['body']['error'] ?? '') === 'bad_key');

// ==================================================================
//  Translate (the interpreter page)
// ==================================================================

echo "\n-- translate --\n";
resetRate();
resetStubLog();

$answer = json_encode(['lang' => 'en', 'source' => 'Where is the station?', 'translation' => 'Kje je postaja?'],
    JSON_UNESCAPED_UNICODE);
scenario(['text' => $answer]);

$res = request('action=translate', wav(), 'POST', $ADMIN_SID);
check('translate returns the model answer untouched',
    $res['status'] === 200 && ($res['body']['text'] ?? '') === $answer, $res['raw']);
check('translate names the model', ($res['body']['model'] ?? '') === 'gemini-2.5-flash');

$sent   = stubCalls()[0]['body'] ?? [];
$prompt = $sent['contents'][0]['parts'][0]['text'] ?? '';
$config = $sent['generationConfig'] ?? [];

check('the audio is sent as inline base64 WAV',
    ($sent['contents'][0]['parts'][1]['inline_data']['mime_type'] ?? '') === 'audio/wav');
check('the prompt makes the model decide the direction',
    str_contains($prompt, 'Ugotovi jezik govora') && str_contains($prompt, '"sl"') && str_contains($prompt, '"en"'));
check('the prompt asks for meaning, not word order', str_contains($prompt, 'Prevajaj pomen'));
check('the answer is constrained to JSON', ($config['responseMimeType'] ?? '') === 'application/json');
check('the schema pins the three fields',
    ($config['responseSchema']['required'] ?? []) === ['lang', 'source', 'translation'],
    json_encode($config['responseSchema'] ?? null));
check('the schema restricts the language to the supported pair',
    ($config['responseSchema']['properties']['lang']['enum'] ?? []) === ['sl', 'en']);
check('temperature is pinned to zero', ($config['temperature'] ?? null) === 0);

resetStubLog();
request('action=translate&vocab=' . urlencode('Kranjska Gora, Bled'), wav(), 'POST', $ADMIN_SID);
$prompt = stubCalls()[0]['body']['contents'][0]['parts'][0]['text'] ?? '';
check('vocabulary reaches the translation prompt',
    str_contains($prompt, 'Kranjska Gora') && str_contains($prompt, 'Bled'));

$res = request('action=translate', wav(), 'GET', $ADMIN_SID);
check('translate refuses GET', $res['status'] === 405);

$res = request('action=translate', 'this is not a wav file at all', 'POST', $ADMIN_SID);
check('translate shares the WAV guard', $res['status'] === 400 && ($res['body']['error'] ?? '') === 'bad_audio');

$res = request('action=translate', '', 'POST', $ADMIN_SID);
check('translate rejects an empty body', $res['status'] === 400);

resetStubLog();
scenario(['status' => 500]);
$res = request('action=translate', wav(), 'POST', $ADMIN_SID);
check('an upstream failure on translate is a 502', $res['status'] === 502);
check('a 500 on translate does not walk the model chain', count(stubCalls()) === 1);

// ==================================================================
//  Correct
// ==================================================================

echo "\n-- correct --\n";
resetRate();
resetStubLog();
scenario(['text' => 'Danes je lep dan.']);

$res = request('action=correct', json_encode(['text' => 'danes je lep dan', 'vocab' => ['Kranj']]), 'POST', $ADMIN_SID);
$prompt = stubCalls()[0]['body']['contents'][0]['parts'][0]['text'] ?? '';

check('correct returns the corrected text', $res['status'] === 200 && ($res['body']['text'] ?? '') === 'Danes je lep dan.');
check('the source text reaches the prompt', str_contains($prompt, 'danes je lep dan'));
check('the prompt forbids changing meaning', str_contains($prompt, 'NE spreminjaj'));
check('the prompt protects the dual', str_contains($prompt, 'dvojine'));
check('vocabulary reaches the correction prompt too', str_contains($prompt, 'Kranj'));
check('correct sends no audio part', !isset(stubCalls()[0]['body']['contents'][0]['parts'][1]));

$res = request('action=correct', json_encode(['text' => str_repeat('beseda ', 12000)]), 'POST', $ADMIN_SID);
check('an oversized correction body is 413', $res['status'] === 413);

// ==================================================================
//  Rate limiting
// ==================================================================

echo "\n-- rate limiting --\n";
resetRate();
scenario(['text' => 'ok']);

$statuses = [];
for ($i = 0; $i < 8; $i++) {
    $statuses[] = request('action=transcribe', wav(), 'POST', $ADMIN_SID)['status'];
}
$ok  = count(array_filter($statuses, static fn($s) => $s === 200));
$hit = count(array_filter($statuses, static fn($s) => $s === 429));
check('the per-minute cap stops a runaway loop', $ok === 6 && $hit === 2, implode(',', $statuses));

$res = request('action=transcribe', wav(), 'POST', $ADMIN_SID);
check('a blocked request explains itself', ($res['body']['error'] ?? '') === 'rate_limited'
    && str_contains((string) ($res['body']['message'] ?? ''), 'Počakaj'));

$ledger = json_decode((string) file_get_contents($rateFile), true);
check('the ledger counts only what it let through', ($ledger['total'] ?? 0) === 6, json_encode($ledger));
check('the ledger stamps the day', ($ledger['day'] ?? '') === gmdate('Y-m-d'));
check('the budget is keyed by user, not by IP', array_keys($ledger['ips'] ?? []) === ['u' . $adminId],
    json_encode(array_keys($ledger['ips'] ?? [])));

// The day cap is 9 and 6 are already spent; a fresh window must still stop at 9.
$ledger['ips'] = [];
file_put_contents($rateFile, json_encode($ledger));
$statuses = [];
for ($i = 0; $i < 5; $i++) {
    $statuses[] = request('action=transcribe', wav(), 'POST', $ADMIN_SID)['status'];
}
check('the daily cap holds even with a fresh per-minute window',
    count(array_filter($statuses, static fn($s) => $s === 200)) === 3, implode(',', $statuses));

$res = request('action=transcribe', wav(), 'POST', $ADMIN_SID);
check('the daily message differs from the per-minute one',
    str_contains((string) ($res['body']['message'] ?? ''), 'Dnevna'));

// ==================================================================
//  No key configured
// ==================================================================

echo "\n-- no key configured --\n";

$nokey = 'http://' . HOST . ':' . NOKEY_PORT . '/proxys/narek.php';

$res = request('action=transcribe', wav(), 'POST', null, [], $nokey);
check('a missing key still refuses anonymous first', $res['status'] === 401, (string) $res['status']);

$res = request('action=status', null, 'GET', $ADMIN_SID, [], $nokey);
check('the probe tells the owner the key is missing',
    $res['status'] === 200 && ($res['body']['ready'] ?? null) === false, $res['raw']);

$res = request('action=transcribe', wav(), 'POST', $ADMIN_SID, [], $nokey);
check('a missing key is a 503 that names the variable',
    $res['status'] === 503 && ($res['body']['error'] ?? '') === 'no_key'
    && str_contains((string) ($res['body']['message'] ?? ''), 'GEMINI_API_KEY'), $res['raw']);

// ------------------------------------------------------------------

echo "\n$passed passed, $failed failed\n";
exit($failed === 0 ? 0 : 1);
