<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');

$projectRoot = dirname(__DIR__, 2);

$cacheFile = __DIR__ . '/../cache/stats-cache.json';
$today = date('Y-m-d');
$cachedData = file_exists($cacheFile) ? json_decode(file_get_contents($cacheFile), true) : null;

if ($cachedData && isset($cachedData['date']) && $cachedData['date'] === $today) {
    echo json_encode($cachedData);
    exit;
}

$extensions = ['html', 'css', 'js', 'php'];
$counts = [];
foreach ($extensions as $ext) {
    $counts[$ext] = ['lines' => 0, 'files' => 0];
}

$excludeDirs = ['vendor', 'cache', 'assets', 'node_modules', '.git', '.vscode'];

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
    'counts' => $counts,
    'total' => $total
];

file_put_contents($cacheFile, json_encode($result));
echo json_encode($result);
?>
