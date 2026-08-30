<?php
//? Narek: the Gemini side of the Slovenian dictation sheet (views/narek).
//?
//? PRIVATE, single-owner tool. Every branch sits behind Auth::requireAdmin(),
//? for the same reason views/compass does: this is one person's tool, and here
//? each request also spends real money on the owner's Gemini key. An anonymous
//? caller is 401 and a signed-in non-admin is 403, both before the request body
//? is read and long before anything reaches Google.
//?
//? Three actions:
//?   GET|POST ?action=status      -> { ok, ready }   the page's gate probe
//?   POST     ?action=transcribe  raw WAV body       -> { text }
//?   POST     ?action=translate   raw WAV body       -> { lang, source, translation }
//?   POST     ?action=correct     JSON { text, vocab } -> { text }
//?
//? Seams for tests/narek-proxy.test.php: GEMINI_API_BASE, GEMINI_API_KEY,
//? GEMINI_MODEL, NAREK_RATE_FILE, NAREK_MAX_PER_MIN, NAREK_MAX_PER_DAY.

declare(strict_types=1);
define('SECURE_ACCESS', true);

header('Content-Type: application/json; charset=utf-8');
//? Responses vary with the session cookie, so they must never be cached.
header('Cache-Control: no-store');
//? Deliberately no Access-Control-Allow-Origin: everything here is gated by the
//? session cookie, and wildcard CORS is invalid with credentials anyway.

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

require_once __DIR__ . '/../config/dev-mode.php';
require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../config/auth.php';

// ------------------------------------------------------------------
//  Limits
// ------------------------------------------------------------------

const MAX_AUDIO_BYTES = 4 * 1024 * 1024;  //? ~18 s of 16 kHz mono WAV is 576 KB
const MAX_TEXT_BYTES  = 60000;
const MAX_VOCAB_TERMS = 48;
const UPSTREAM_TIMEOUT = 60;

function limit(string $name, int $fallback): int
{
    $raw = getenv($name);
    return ($raw !== false && $raw !== '' && ctype_digit((string) $raw)) ? (int) $raw : $fallback;
}

function fail(int $status, string $code, string $message): never
{
    http_response_code($status);
    echo json_encode(['ok' => false, 'error' => $code, 'message' => $message], JSON_UNESCAPED_UNICODE);
    exit;
}

// ------------------------------------------------------------------
//  Request guards, then the gate
// ------------------------------------------------------------------

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$action = isset($_GET['action']) && is_string($_GET['action']) ? $_GET['action'] : '';

if (!in_array($action, ['status', 'transcribe', 'translate', 'correct'], true)) {
    fail(400, 'bad_request', 'Neznana akcija.');
}
//? status answers a GET so the page can decide before touching the microphone;
//? everything that costs money is POST only.
if ($action !== 'status' && $method !== 'POST') {
    fail(405, 'method_not_allowed', 'Uporabi POST.');
}

//? Cross-origin backstop. A missing Origin is allowed (some clients omit it);
//? a mismatched one is not.
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if (is_string($origin) && $origin !== '') {
    $host = $_SERVER['HTTP_HOST'] ?? '';
    if ($host === '' || parse_url($origin, PHP_URL_HOST) !== parse_url('http://' . $host, PHP_URL_HOST)) {
        fail(403, 'bad_origin', 'Zahtevek ni z iste domene.');
    }
}

//? THE GATE. Everything below this line costs the owner money, so nothing
//? below it runs for anyone else: not the rate ledger, not the body read, and
//? certainly not the upstream call. Auth::deny() sends its own 401/403 JSON.
$user = Auth::requireAdmin();

// ------------------------------------------------------------------
//  Config
// ------------------------------------------------------------------

//? Env vars win over app/.env so a test run never touches the real key.
$apiKey = (string) (getenv('GEMINI_API_KEY') ?: '');
$model  = (string) (getenv('GEMINI_MODEL') ?: '');

if ($apiKey === '') {
    $basePath   = $DEV_MODE ? dirname(__DIR__) : '/usr/home/meuhdy';
    $vendorPath = $basePath . '/vendor';
    if (file_exists($vendorPath . '/autoload.php') && file_exists($basePath . '/.env')) {
        require_once $vendorPath . '/autoload.php';
        Dotenv\Dotenv::createImmutable($basePath)->safeLoad();
        $apiKey = (string) ($_ENV['GEMINI_API_KEY'] ?? '');
        if ($model === '') {
            $model = (string) ($_ENV['GEMINI_MODEL'] ?? '');
        }
    }
}

//? The gate probe: the page uses this to choose between the tool and the login
//? wall, and `ready` tells the owner the key is missing without pressing record.
if ($action === 'status') {
    echo json_encode([
        'ok'    => true,
        'ready' => $apiKey !== '',
        'user'  => ['name' => $user['display_name'] ?? $user['email'] ?? ''],
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

if ($apiKey === '') {
    fail(503, 'no_key', 'Strežnik nima ključa za Gemini. Dodaj GEMINI_API_KEY v app/.env.');
}

$apiBase = rtrim((string) (getenv('GEMINI_API_BASE') ?: 'https://generativelanguage.googleapis.com/v1beta'), '/');

//? Tried in order; a 404 from one falls through to the next, so the tool keeps
//? working on a key whose project has a different model line-up. Set
//? GEMINI_MODEL in app/.env to pin a specific generateContent-capable model.
$candidates = array_values(array_unique(array_filter([
    $model,
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-1.5-flash',
])));

// ------------------------------------------------------------------
//  Rate limiting
// ------------------------------------------------------------------

/**
 * Sliding per-caller window plus a hard global day cap, in one small JSON file.
 * Behind the admin gate this is no longer an anti-abuse measure but a runaway
 * guard: a stuck retry loop in a tab should not empty the quota overnight.
 */
function enforceRateLimit(string $caller): void
{
    $path = (string) (getenv('NAREK_RATE_FILE') ?: (__DIR__ . '/../cache/narek/rate.json'));
    $dir  = dirname($path);
    if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
        return; //? cannot record: fail open rather than break the tool
    }

    $perMin = limit('NAREK_MAX_PER_MIN', 40);
    $perDay = limit('NAREK_MAX_PER_DAY', 1500);

    $handle = @fopen($path, 'c+');
    if ($handle === false) {
        return;
    }
    if (!flock($handle, LOCK_EX)) {
        fclose($handle);
        return;
    }

    $raw   = stream_get_contents($handle);
    $state = json_decode($raw !== false ? $raw : '', true);
    if (!is_array($state)) {
        $state = [];
    }

    $now   = time();
    $today = gmdate('Y-m-d', $now);

    if (($state['day'] ?? '') !== $today) {
        $state = ['day' => $today, 'total' => 0, 'ips' => []];
    }

    //? Drop windows nobody has touched for a minute, so the file cannot grow.
    $callers = [];
    foreach (($state['ips'] ?? []) as $key => $stamps) {
        if (!is_array($stamps)) {
            continue;
        }
        $fresh = array_values(array_filter($stamps, static fn($t) => is_int($t) && $t > $now - 60));
        if ($fresh) {
            $callers[$key] = $fresh;
        }
    }

    $mine    = $callers[$caller] ?? [];
    $blocked = null;

    if ((int) ($state['total'] ?? 0) >= $perDay) {
        $blocked = 'Dnevna kvota je porabljena. Poskusi jutri.';
    } elseif (count($mine) >= $perMin) {
        $blocked = 'Preveč zahtevkov zapored. Počakaj minuto.';
    } else {
        $mine[]           = $now;
        $callers[$caller] = $mine;
        $state['total']   = (int) ($state['total'] ?? 0) + 1;
    }

    $state['ips'] = $callers;

    ftruncate($handle, 0);
    rewind($handle);
    fwrite($handle, json_encode($state, JSON_UNESCAPED_UNICODE));
    fflush($handle);
    flock($handle, LOCK_UN);
    fclose($handle);

    if ($blocked !== null) {
        fail(429, 'rate_limited', $blocked);
    }
}

//? Keyed by user, not by IP: the caller is always a known account now, and the
//? budget should follow them across networks rather than reset with the IP.
enforceRateLimit('u' . (int) $user['id']);

/** @return string[] */
function readVocab(mixed $raw): array
{
    if (is_string($raw)) {
        $raw = preg_split('/[,\n;]+/', $raw) ?: [];
    }
    if (!is_array($raw)) {
        return [];
    }
    $out = [];
    foreach ($raw as $term) {
        if (!is_string($term)) {
            continue;
        }
        $term = trim($term);
        if (mb_strlen($term) > 1 && mb_strlen($term) <= 40 && !in_array($term, $out, true)) {
            $out[] = $term;
        }
        if (count($out) >= MAX_VOCAB_TERMS) {
            break;
        }
    }
    return $out;
}

function vocabClause(array $vocab): string
{
    if (!$vocab) {
        return '';
    }
    return "\n\nLastna imena in strokovni izrazi, ki se lahko pojavijo v posnetku, "
        . "zapiši jih točno tako: " . implode(', ', $vocab) . '.';
}

// ------------------------------------------------------------------
//  Prompts
// ------------------------------------------------------------------

const TRANSCRIBE_PROMPT = <<<'TXT'
Prepiši ta posnetek slovenskega govora.

Pravila:
- Vrni SAMO prepisano besedilo v slovenščini.
- Prepiši dobesedno. Ne povzemaj, ne prevajaj, ne dopolnjuj.
- Uporabi ločila in velike začetnice.
- Ne dodajaj oznak, narekovajev, časovnih žigov, imen govorcev ali razlag.
- Če v posnetku ni razumljivega govora, vrni prazen odgovor.
TXT;

//? The interpreter contract: the direction is the model's to work out from
//? the audio, because the whole point is that you just talk and it keeps up.
//? Answered as JSON against a schema, so the page never has to guess which
//? half of the reply is the transcript and which is the translation.
const TRANSLATE_PROMPT = <<<'TXT'
Poslušaj posnetek. Govor je v slovenščini ALI v angleščini.

1. Ugotovi jezik govora: "sl" za slovenščino, "en" za angleščino.
2. V polje "source" dobesedno zapiši, kar je bilo povedano, v izvirnem jeziku.
3. V polje "translation" zapiši prevod v drugi jezik: slovensko v angleščino,
   angleško v slovenščino.

Prevajaj pomen, ne besede po vrsti. Ohrani ton in vljudnostno raven.
Ne dodajaj razlag, opomb, oklepajev ali alternativnih prevodov.
Če v posnetku ni razumljivega govora, vrni prazna niza.
TXT;

//? The narrow correction contract from the feasibility work: fix the record,
//? never rewrite it. Slovenian's six cases and its dual make a "fluent"
//? rewrite look correct and mean something else, which is exactly what the
//? diff in front of the visitor is there to catch.
const CORRECT_PROMPT = <<<'TXT'
Si lektor slovenskega besedila, ki je nastalo s samodejnim prepoznavanjem govora.

Popravi SAMO:
- ločila in velike začetnice,
- očitno napačno slišane besede,
- podvojene besede in mašila (ehm, aaa, mmm),
- razdelitev na odstavke, kjer je to smiselno.

NE spreminjaj:
- besednega reda,
- izbire besed, če niso očitno napačne,
- sklonov, spola in števila, posebej ne dvojine,
- pomena. Ničesar ne dodajaj in ničesar ne izpuščaj.

Vrni samo popravljeno besedilo, brez razlag, brez uvoda in brez oznak.
TXT;

// ------------------------------------------------------------------
//  Upstream call
// ------------------------------------------------------------------

/**
 * POST one generateContent request. Returns [httpCode, decodedBody|null].
 *
 * @return array{0:int, 1:mixed}
 */
function callGemini(string $base, string $model, string $key, array $payload): array
{
    $url = $base . '/models/' . rawurlencode($model) . ':generateContent';
    $ch  = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => UPSTREAM_TIMEOUT,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_HTTPHEADER     => [
            'Content-Type: application/json',
            'x-goog-api-key: ' . $key,
        ],
        CURLOPT_POSTFIELDS     => json_encode($payload, JSON_UNESCAPED_UNICODE),
    ]);

    $body = curl_exec($ch);
    if ($body === false) {
        $err = curl_error($ch);
        curl_close($ch);
        error_log('narek: curl failed: ' . $err);
        return [0, null];
    }
    $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    return [$code, json_decode((string) $body, true)];
}

/** Concatenate the text parts of the first candidate. */
function extractText(mixed $decoded): string
{
    if (!is_array($decoded)) {
        return '';
    }
    $parts = $decoded['candidates'][0]['content']['parts'] ?? null;
    if (!is_array($parts)) {
        return '';
    }
    $out = '';
    foreach ($parts as $part) {
        if (is_array($part) && isset($part['text']) && is_string($part['text'])) {
            $out .= $part['text'];
        }
    }
    return trim($out);
}

/**
 * Walk the model chain until one answers. A 404 or 400 means "this project
 * cannot use that model", so try the next; anything else is a real failure.
 *
 * @param string[] $models
 */
function generate(string $base, array $models, string $key, array $payload): array
{
    $lastCode = 0;
    $lastBody = null;

    foreach ($models as $candidate) {
        $body = $payload;
        //? Thinking costs seconds per segment and buys nothing on a transcript.
        //? Only 2.5 takes this shape of the setting, so only 2.5 gets it.
        if (str_starts_with($candidate, 'gemini-2.5')) {
            $body['generationConfig']['thinkingConfig'] = ['thinkingBudget' => 0];
        }

        [$code, $decoded] = callGemini($base, $candidate, $key, $body);
        if ($code === 200) {
            return ['ok' => true, 'model' => $candidate, 'body' => $decoded];
        }
        $lastCode = $code;
        $lastBody = $decoded;
        if ($code !== 404 && $code !== 400) {
            break;
        }
    }

    return ['ok' => false, 'code' => $lastCode, 'body' => $lastBody, 'model' => end($models) ?: ''];
}

function upstreamFailure(array $result): never
{
    $code    = (int) ($result['code'] ?? 0);
    $message = $result['body']['error']['message'] ?? '';

    if ($code === 429) {
        fail(429, 'upstream_rate', 'Gemini je zavrnil zaradi kvote. Poskusi čez nekaj trenutkov.');
    }
    if ($code === 401 || $code === 403) {
        fail(502, 'bad_key', 'Gemini je zavrnil ključ. Preveri GEMINI_API_KEY.');
    }
    if ($code === 0) {
        fail(504, 'unreachable', 'Gemini ni dosegljiv.');
    }
    error_log('narek: upstream ' . $code . ' ' . (is_string($message) ? $message : ''));
    fail(502, 'upstream', 'Gemini je vrnil napako (' . $code . ').');
}

// ------------------------------------------------------------------
//  Actions
// ------------------------------------------------------------------

$started = microtime(true);

/** Read and validate the WAV body shared by transcribe and translate. */
function readAudio(): string
{
    $audio = file_get_contents('php://input');
    if ($audio === false || $audio === '') {
        fail(400, 'bad_request', 'Manjka posnetek.');
    }
    if (strlen($audio) > MAX_AUDIO_BYTES) {
        fail(413, 'too_large', 'Posnetek je predolg.');
    }
    if (substr($audio, 0, 4) !== 'RIFF') {
        fail(400, 'bad_audio', 'Posnetek ni v obliki WAV.');
    }
    return $audio;
}

if ($action === 'translate') {
    $audio  = readAudio();
    $vocab  = readVocab($_GET['vocab'] ?? '');
    $prompt = TRANSLATE_PROMPT . vocabClause($vocab);

    $result = generate($apiBase, $candidates, $apiKey, [
        'contents' => [[
            'role'  => 'user',
            'parts' => [
                ['text' => $prompt],
                ['inline_data' => ['mime_type' => 'audio/wav', 'data' => base64_encode($audio)]],
            ],
        ]],
        'generationConfig' => [
            'temperature'      => 0,
            'maxOutputTokens'  => 2048,
            'responseMimeType' => 'application/json',
            'responseSchema'   => [
                'type'       => 'OBJECT',
                'properties' => [
                    'lang'        => ['type' => 'STRING', 'enum' => ['sl', 'en']],
                    'source'      => ['type' => 'STRING'],
                    'translation' => ['type' => 'STRING'],
                ],
                'required' => ['lang', 'source', 'translation'],
            ],
        ],
    ]);

    if (!$result['ok']) {
        upstreamFailure($result);
    }

    //? Handed on as the raw string: parseTranslation() in views/narek/logic.js
    //? owns every decision about what a malformed answer means, and it is
    //? tested. Decoding it in two places would be two places to drift.
    echo json_encode([
        'ok'    => true,
        'text'  => extractText($result['body']),
        'model' => $result['model'],
        'ms'    => (int) round((microtime(true) - $started) * 1000),
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

if ($action === 'transcribe') {
    $audio  = readAudio();
    $vocab  = readVocab($_GET['vocab'] ?? '');
    $prompt = TRANSCRIBE_PROMPT . vocabClause($vocab);

    $result = generate($apiBase, $candidates, $apiKey, [
        'contents' => [[
            'role'  => 'user',
            'parts' => [
                ['text' => $prompt],
                ['inline_data' => ['mime_type' => 'audio/wav', 'data' => base64_encode($audio)]],
            ],
        ]],
        'generationConfig' => [
            'temperature'     => 0,
            'maxOutputTokens' => 2048,
        ],
    ]);

    if (!$result['ok']) {
        upstreamFailure($result);
    }

    echo json_encode([
        'ok'    => true,
        'text'  => extractText($result['body']),
        'model' => $result['model'],
        'ms'    => (int) round((microtime(true) - $started) * 1000),
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

// action === 'correct'
$raw = file_get_contents('php://input');
if ($raw === false || strlen($raw) > MAX_TEXT_BYTES) {
    fail(413, 'too_large', 'Besedilo je predolgo.');
}
$input = json_decode((string) $raw, true);
if (!is_array($input) || !isset($input['text']) || !is_string($input['text']) || trim($input['text']) === '') {
    fail(400, 'bad_request', 'Manjka besedilo.');
}

$vocab  = readVocab($input['vocab'] ?? []);
$prompt = CORRECT_PROMPT . vocabClause($vocab) . "\n\nBesedilo:\n" . trim($input['text']);

$result = generate($apiBase, $candidates, $apiKey, [
    'contents' => [[
        'role'  => 'user',
        'parts' => [['text' => $prompt]],
    ]],
    'generationConfig' => [
        'temperature'     => 0,
        'maxOutputTokens' => 8192,
    ],
]);

if (!$result['ok']) {
    upstreamFailure($result);
}

echo json_encode([
    'ok'    => true,
    'text'  => extractText($result['body']),
    'model' => $result['model'],
    'ms'    => (int) round((microtime(true) - $started) * 1000),
], JSON_UNESCAPED_UNICODE);
