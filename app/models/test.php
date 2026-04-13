<?php
define('SECURE_ACCESS', true);

require_once __DIR__ . '/../config/database.php';

try {
    $pdo = Database::read();
    $stmt = $pdo->query('SELECT * FROM test_products');
    $rows = $stmt->fetchAll();
} catch (Exception $e) {
    die("Error: " . htmlspecialchars($e->getMessage()));
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>test_products</title>
    <style>
        body { font-family: sans-serif; padding: 2rem; background: #f4f4f4; }
        h2 { margin-bottom: 1rem; }
        table { border-collapse: collapse; width: 100%; background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,.1); }
        th { background: #333; color: #fff; text-align: left; padding: .6rem 1rem; }
        td { padding: .6rem 1rem; border-bottom: 1px solid #e0e0e0; }
        tr:last-child td { border-bottom: none; }
        tr:hover td { background: #f9f9f9; }
    </style>
</head>
<body>
    <h2>test_products</h2>
    <?php if (empty($rows)): ?>
        <p>No rows found.</p>
    <?php else: ?>
        <table>
            <thead>
                <tr>
                    <?php foreach (array_keys($rows[0]) as $col): ?>
                        <th><?= htmlspecialchars($col) ?></th>
                    <?php endforeach; ?>
                </tr>
            </thead>
            <tbody>
                <?php foreach ($rows as $row): ?>
                    <tr>
                        <?php foreach ($row as $val): ?>
                            <td><?= htmlspecialchars((string)$val) ?></td>
                        <?php endforeach; ?>
                    </tr>
                <?php endforeach; ?>
            </tbody>
        </table>
    <?php endif; ?>
</body>
</html>
