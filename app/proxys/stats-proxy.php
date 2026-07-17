<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');

// STATS_ROOT / STATS_CACHE process-env overrides exist for the integration
// tests (tests/stats-proxy.test.php), which point the counter at a fixture
// tree instead of the real repo.
$projectRoot = getenv('STATS_ROOT') ?: dirname(__DIR__, 2);

$cacheFile = getenv('STATS_CACHE') ?: __DIR__ . '/../cache/stats-cache.json';
$today = date('Y-m-d');

$extensions = ['html', 'css', 'js', 'php', 'sql'];
$counts = [];
foreach ($extensions as $ext) {
    $counts[$ext] = ['lines' => 0, 'files' => 0];
}

// The headline number means "code this site is built from": dev tooling
// (Claude skills, test suites, the SEO generator) and server-only dirs are
// excluded so the count matches what actually deploys, give or take the few
// never-uploaded views.
$excludeDirs = [
    'vendor', 'cache', 'assets', 'node_modules', '.git', '.vscode',
    '.claude', '.agents', '.impeccable', '.github', 'tests', 'tools',
];

// The cache is per-day AND per-counting-rules: when the extension or exclude
// lists change, the version stamp changes, so the first request after a
// deploy recounts instead of serving yesterday's rules until midnight.
$cacheVersion = md5(json_encode([$extensions, $excludeDirs]));
$cachedData = file_exists($cacheFile) ? json_decode(file_get_contents($cacheFile), true) : null;

if ($cachedData
    && isset($cachedData['date']) && $cachedData['date'] === $today
    && isset($cachedData['version']) && $cachedData['version'] === $cacheVersion) {
    echo json_encode($cachedData);
    exit;
}

$iterator = new RecursiveIteratorIterator(
    new RecursiveCallbackFilterIterator(
        new RecursiveDirectoryIterator($projectRoot, RecursiveDirectoryIterator::SKIP_DOTS),
        function ($file, $key, $iterator) use ($excludeDirs) {
            if ($iterator->hasChildren()) {
                return !in_array($file->getFilename(), $excludeDirs);
            }
            return true;
        }
    )
);

foreach ($iterator as $file) {
    if (!$file->isFile()) continue;

    $ext = strtolower($file->getExtension());
    if (!isset($counts[$ext])) continue;

    $lineCount = count(file($file->getRealPath()));
    $counts[$ext]['lines'] += $lineCount;
    $counts[$ext]['files']++;
}

$total = 0;
foreach ($counts as $ext => $data) {
    $total += $data['lines'];
}

foreach ($counts as $ext => &$data) {
    $data['percent'] = $total > 0 ? number_format(($data['lines'] / $total) * 100, 2) : '0.00';
}
unset($data);

$result = [
    'date' => $today,
    'version' => $cacheVersion,
    'counts' => $counts,
    'total' => $total
];

file_put_contents($cacheFile, json_encode($result));
echo json_encode($result);
?>
