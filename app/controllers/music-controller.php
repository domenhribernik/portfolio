<?php
declare(strict_types=1);
define('SECURE_ACCESS', true);

// shortest float representation when re-encoding the analyzer's JSON
// (otherwise 87.9 comes back out as 87.900000000000006)
ini_set('serialize_precision', '-1');

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

require_once __DIR__ . '/../config/database.php';

const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;
const MAX_CHORD_EVENTS = 500;
const MAX_WORD_SYNCS   = 2000;
const MAX_LYRICS_CHARS = 20000;

$method   = $_SERVER['REQUEST_METHOD'];
$resource = $_GET['resource'] ?? null;
$id       = isset($_GET['id']) ? (int) $_GET['id'] : null;

try {
    if ($resource === 'sync') {
        handleSync($method);
    } elseif ($resource === 'analysis') {
        handleAnalysis($method, $id);
    } else {
        sendError('Unknown resource. Use ?resource=sync or ?resource=analysis', 400);
    }
} catch (Exception $e) {
    error_log('Music controller error: ' . $e->getMessage());
    sendError('Internal server error', 500);
}

// --- Helpers ---

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
    return is_array($json) ? $json : [];
}

function validTrackKey(string $key): bool
{
    return (bool) preg_match('#^(acoustic|electric)/[^/\\\\]{1,200}\.mp3$#u', $key);
}

// --- Sync (chords + lyrics per track) ---

function handleSync(string $method): void
{
    $track = isset($_GET['track']) ? (string) $_GET['track'] : null;

    switch ($method) {
        case 'GET':
            if ($track !== null) { getSync($track); return; }
            listSync();
            return;
        case 'POST':
            saveSync();
            return;
        case 'DELETE':
            if ($track === null) sendError('track parameter is required', 400);
            deleteSync($track);
            return;
        default:
            sendError('Method not allowed', 405);
    }
}

function formatSync(array $row): array
{
    // The chords column holds either a plain array of chord events (legacy
    // rows) or an { events, words } envelope once word syncs were saved.
    $decoded = json_decode($row['chords'] ?? '[]', true);
    $chords  = [];
    $words   = [];
    if (is_array($decoded)) {
        if (array_key_exists('events', $decoded)) {
            $chords = is_array($decoded['events']) ? $decoded['events'] : [];
            $words  = is_array($decoded['words'] ?? null) ? $decoded['words'] : [];
        } else {
            $chords = $decoded;
        }
    }
    return [
        'track_key'  => $row['track_key'],
        'lyrics'     => $row['lyrics'],
        'chords'     => $chords,
        'words'      => $words,
        'updated_at' => $row['updated_at'],
    ];
}

function getSync(string $track): void
{
    if (!validTrackKey($track)) sendError('Invalid track key', 400);
    $stmt = Database::read()->prepare(
        'SELECT track_key, lyrics, chords, updated_at FROM music_sync WHERE track_key = ?'
    );
    $stmt->execute([$track]);
    $row = $stmt->fetch();
    if (!$row) sendError('No chords or lyrics saved for this track yet', 404);
    sendJson(formatSync($row));
}

function listSync(): void
{
    $stmt = Database::read()->query(
        'SELECT track_key, updated_at FROM music_sync ORDER BY updated_at DESC'
    );
    sendJson($stmt->fetchAll());
}

function saveSync(): void
{
    $data  = readBody();
    $track = isset($data['track_key']) ? trim((string) $data['track_key']) : '';
    if (!validTrackKey($track)) sendError('Invalid track key', 400);

    $lyrics = isset($data['lyrics']) ? (string) $data['lyrics'] : '';
    if (mb_strlen($lyrics) > MAX_LYRICS_CHARS) {
        sendError('Lyrics are too long (max ' . MAX_LYRICS_CHARS . ' characters)', 400);
    }

    $chords = $data['chords'] ?? [];
    if (is_string($chords)) $chords = json_decode($chords, true);
    if (!is_array($chords)) sendError('chords must be a JSON array', 400);
    if (count($chords) > MAX_CHORD_EVENTS) {
        sendError('Too many chord events (max ' . MAX_CHORD_EVENTS . ')', 400);
    }

    $clean = [];
    foreach ($chords as $i => $event) {
        if (!is_array($event)) sendError("Chord event #$i is not an object", 400);
        $time  = $event['time'] ?? null;
        $chord = $event['chord'] ?? null;
        if (!is_numeric($time) || (float) $time < 0) sendError("Chord event #$i has an invalid time", 400);
        if (!is_string($chord) || $chord === '' || mb_strlen($chord) > 16) {
            sendError("Chord event #$i has an invalid chord name", 400);
        }
        $entry = ['time' => round((float) $time, 2), 'chord' => $chord];
        if (isset($event['line']) && is_numeric($event['line']) && (int) $event['line'] >= 0) {
            $entry['line'] = (int) $event['line'];
        }
        if (isset($event['word']) && is_numeric($event['word']) && (int) $event['word'] >= 0) {
            $entry['word'] = (int) $event['word'];
        }
        $clean[] = $entry;
    }
    usort($clean, fn($a, $b) => $a['time'] <=> $b['time']);

    // Word syncs: timestamps for individual lyric words (no chord attached),
    // used by the player to interpolate the karaoke highlight precisely.
    $words = $data['words'] ?? [];
    if (is_string($words)) $words = json_decode($words, true);
    if (!is_array($words)) sendError('words must be a JSON array', 400);
    if (count($words) > MAX_WORD_SYNCS) {
        sendError('Too many word syncs (max ' . MAX_WORD_SYNCS . ')', 400);
    }

    $cleanWords = [];
    foreach ($words as $i => $mark) {
        if (!is_array($mark)) sendError("Word sync #$i is not an object", 400);
        $time = $mark['time'] ?? null;
        if (!is_numeric($time) || (float) $time < 0) sendError("Word sync #$i has an invalid time", 400);
        if (!isset($mark['line'], $mark['word'])
            || !is_numeric($mark['line']) || (int) $mark['line'] < 0
            || !is_numeric($mark['word']) || (int) $mark['word'] < 0) {
            sendError("Word sync #$i has an invalid line/word anchor", 400);
        }
        $cleanWords[] = [
            'time' => round((float) $time, 2),
            'line' => (int) $mark['line'],
            'word' => (int) $mark['word'],
        ];
    }
    usort($cleanWords, fn($a, $b) => $a['time'] <=> $b['time']);

    // Store a plain array while there are no word syncs (matches legacy rows);
    // otherwise wrap both in an envelope. formatSync understands both shapes,
    // so no schema migration is needed for the words feature.
    $payload = $cleanWords ? ['events' => $clean, 'words' => $cleanWords] : $clean;

    $stmt = Database::write()->prepare(
        'INSERT INTO music_sync (track_key, lyrics, chords) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE lyrics = VALUES(lyrics), chords = VALUES(chords)'
    );
    $stmt->execute([$track, $lyrics, json_encode($payload, JSON_UNESCAPED_UNICODE)]);

    getSync($track);
}

function deleteSync(string $track): void
{
    if (!validTrackKey($track)) sendError('Invalid track key', 400);
    $stmt = Database::write()->prepare('DELETE FROM music_sync WHERE track_key = ?');
    $stmt->execute([$track]);
    sendJson(['message' => 'Sync data deleted']);
}

// --- Analysis (upload an MP3, run the Python analyzer) ---

function handleAnalysis(string $method, ?int $id): void
{
    switch ($method) {
        case 'GET':
            if ($id) { getAnalysis($id); return; }
            listAnalyses();
            return;
        case 'POST':
            runAnalysis();
            return;
        default:
            sendError('Method not allowed', 405);
    }
}

function listAnalyses(): void
{
    $stmt = Database::read()->query(
        'SELECT id, filename, result, created_at FROM music_analyses ORDER BY created_at DESC LIMIT 10'
    );
    $out = [];
    foreach ($stmt->fetchAll() as $row) {
        $result = json_decode($row['result'], true) ?: [];
        $out[] = [
            'id'         => (int) $row['id'],
            'filename'   => $row['filename'],
            'created_at' => $row['created_at'],
            'key'        => $result['key']['name'] ?? null,
            'bpm'        => $result['tempo']['bpm'] ?? null,
        ];
    }
    sendJson($out);
}

function getAnalysis(int $id): void
{
    $stmt = Database::read()->prepare(
        'SELECT id, filename, result, created_at FROM music_analyses WHERE id = ?'
    );
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    if (!$row) sendError('Analysis not found', 404);
    sendJson([
        'id'         => (int) $row['id'],
        'filename'   => $row['filename'],
        'created_at' => $row['created_at'],
        'result'     => json_decode($row['result'], true),
    ]);
}

// MP3 for uploads; webm/ogg/m4a/wav for in-app mic recordings (MediaRecorder
// output varies by browser). Each format is sniffed by its container magic.
function looksLikeAudio(string $path, string $ext): bool
{
    $handle = fopen($path, 'rb');
    if (!$handle) return false;
    $head = fread($handle, 12);
    fclose($handle);
    if ($head === false || strlen($head) < 12) return false;

    switch ($ext) {
        case 'mp3':
            if (str_starts_with($head, 'ID3')) return true;                       // ID3 tag
            return ord($head[0]) === 0xFF && (ord($head[1]) & 0xE0) === 0xE0;     // MPEG frame sync
        case 'webm':
            return substr($head, 0, 4) === "\x1A\x45\xDF\xA3";                    // EBML
        case 'ogg':
            return str_starts_with($head, 'OggS');
        case 'wav':
            return str_starts_with($head, 'RIFF') && substr($head, 8, 4) === 'WAVE';
        case 'm4a':
        case 'mp4':
            return substr($head, 4, 4) === 'ftyp';
    }
    return false;
}

function runAnalysis(): void
{
    set_time_limit(180);

    if (empty($_FILES['audio'])) sendError('No file uploaded (field name must be "audio")', 400);
    $file = $_FILES['audio'];

    if ($file['error'] === UPLOAD_ERR_INI_SIZE || $file['error'] === UPLOAD_ERR_FORM_SIZE) {
        sendError('File is too large', 413);
    }
    if ($file['error'] !== UPLOAD_ERR_OK) sendError('Upload failed (code ' . $file['error'] . ')', 400);
    if ($file['size'] > MAX_UPLOAD_BYTES) sendError('File is too large (max 30 MB)', 413);
    if ($file['size'] < 1024) sendError('File is too small to be an MP3', 400);

    $filename = basename((string) $file['name']);
    if (!preg_match('/\.(mp3|webm|ogg|m4a|mp4|wav)$/i', $filename, $extMatch)) {
        sendError('Only MP3 files or in-app mic recordings are accepted', 400);
    }
    $ext = strtolower($extMatch[1]);
    if (!looksLikeAudio($file['tmp_name'], $ext)) {
        sendError($ext === 'mp3'
            ? 'This file does not look like a valid MP3 (bad file header)'
            : 'This recording does not look like valid audio', 400);
    }

    $tmpPath = tempnam(sys_get_temp_dir(), 'music_analysis_');
    if ($tmpPath === false || !move_uploaded_file($file['tmp_name'], $tmpPath)) {
        sendError('Could not store the uploaded file', 500);
    }

    $script = realpath(__DIR__ . '/../scripts/analyze_audio.py');
    if ($script === false) {
        unlink($tmpPath);
        sendError('Analyzer script not found on the server', 500);
    }

    $python = $_ENV['PYTHON_BIN'] ?? 'python3';
    // XAMPP exports LD_LIBRARY_PATH=/opt/lampp/lib, whose old libstdc++ breaks
    // the system ffmpeg (and could break numpy); run Python with it unset.
    $cmd = 'env -u LD_LIBRARY_PATH ' . escapeshellcmd($python) . ' '
        . escapeshellarg($script) . ' ' . escapeshellarg($tmpPath) . ' 2>&1';
    exec($cmd, $outputLines, $exitCode);
    unlink($tmpPath);

    $output = implode("\n", $outputLines);
    $result = json_decode($output, true);

    if ($exitCode !== 0 || !is_array($result)) {
        error_log("Music analysis failed (exit $exitCode): " . substr($output, 0, 500));
        sendError('Analysis failed on the server', 500);
    }
    if (empty($result['ok'])) {
        sendError($result['error'] ?? 'Analysis failed', 422);
    }

    $saved = false;
    $analysisId = null;
    $wantSave = ($_POST['save'] ?? '1') !== '0';
    if ($wantSave) {
        try {
            $stmt = Database::write()->prepare(
                'INSERT INTO music_analyses (filename, result) VALUES (?, ?)'
            );
            $stmt->execute([mb_substr($filename, 0, 255), json_encode($result, JSON_UNESCAPED_UNICODE)]);
            $analysisId = (int) Database::write()->lastInsertId();
            $saved = true;
        } catch (Exception $e) {
            // Analysis succeeded; a DB hiccup shouldn't throw the result away.
            error_log('Could not save music analysis: ' . $e->getMessage());
        }
    }

    sendJson([
        'filename'    => $filename,
        'saved'       => $saved,
        'analysis_id' => $analysisId,
        'result'      => $result,
    ]);
}
