<?php
define('SECURE_ACCESS', true);
require_once 'Database.php';

// No need to call Database::init() - it happens automatically, 
// but you can call it explicitly to catch config errors early

try {
    $stmt = Database::read()->query('SELECT * FROM test_data');
    $results = $stmt->fetchAll();
    
    echo "<h1>Test Data Results</h1>";
    echo "<p>Total rows: " . count($results) . "</p>";
    
    if (empty($results)) {
        echo "<p>No data found.</p>";
    } else {
        echo "<table border='1' cellpadding='10'>";
        echo "<thead><tr>";
        foreach (array_keys($results[0]) as $column) {
            echo "<th>" . htmlspecialchars($column) . "</th>";
        }
        echo "</tr></thead><tbody>";
        
        foreach ($results as $row) {
            echo "<tr>";
            foreach ($row as $value) {
                echo "<td>" . htmlspecialchars($value ?? 'NULL') . "</td>";
            }
            echo "</tr>";
        }
        echo "</tbody></table>";
    }
    
} catch (PDOException $e) {
    // Database errors (connection failures, SQL errors)
    echo "<h2>Database Error</h2>";
    echo "<p>" . htmlspecialchars($e->getMessage()) . "</p>";
} catch (Exception $e) {
    // Configuration errors (missing .env vars, etc.)
    echo "<h2>Configuration Error</h2>";
    echo "<p>" . htmlspecialchars($e->getMessage()) . "</p>";
}