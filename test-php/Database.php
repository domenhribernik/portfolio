<?php
declare(strict_types=1);

if (!defined('SECURE_ACCESS')) {
    header('HTTP/1.0 403 Forbidden');
    exit('Access denied.');
}

// Load autoloader silently
$autoloaderPath = __DIR__ . '/../vendor/autoload.php';
if (!file_exists($autoloaderPath)) {
    error_log("Database Error: Autoloader not found at $autoloaderPath");
    die("System configuration error. Contact administrator.");
}
require_once $autoloaderPath;

// Load .env silently
if (empty($_ENV['DB_HOST'])) {
    $paths = [__DIR__ . '/../.env', __DIR__ . '/.env', __DIR__ . '/../../.env'];
    foreach ($paths as $path) {
        if (file_exists($path)) {
            try {
                Dotenv\Dotenv::createImmutable(dirname($path))->safeLoad();
                break;
            } catch (Exception $e) {
                error_log("Dotenv error: " . $e->getMessage());
            }
        }
    }
}

class Database 
{
    private static ?PDO $writeConnection = null;
    private static ?PDO $readConnection = null;
    private static bool $initialized = false;
    
    public static function init(): void 
    {
        if (self::$initialized) return;
        
        $required = ['DB_HOST', 'DB_NAME', 'DB_USER_W', 'DB_PASS_W', 'DB_USER_R', 'DB_PASS_R'];
        foreach ($required as $var) {
            if (empty($_ENV[$var])) {
                error_log("Database Config Error: Missing $var");
                throw new Exception("Configuration incomplete");
            }
        }
        self::$initialized = true;
    }
    
    public static function write(): PDO 
    {
        if (!self::$initialized) self::init();
        
        if (self::$writeConnection === null) {
            try {
                self::$writeConnection = self::createConnection(
                    $_ENV['DB_USER_W'],
                    $_ENV['DB_PASS_W']
                );
            } catch (PDOException $e) {
                error_log("DB Write Connection failed: " . $e->getMessage());
                throw new Exception("Database connection failed");
            }
        }
        return self::$writeConnection;
    }
    
    public static function read(): PDO 
    {
        if (!self::$initialized) self::init();
        
        if (self::$readConnection === null) {
            try {
                self::$readConnection = self::createConnection(
                    $_ENV['DB_USER_R'],
                    $_ENV['DB_PASS_R']
                );
            } catch (PDOException $e) {
                error_log("DB Read Connection failed: " . $e->getMessage());
                throw new Exception("Database connection failed");
            }
        }
        return self::$readConnection;
    }
    
    private static function createConnection(string $user, string $password): PDO 
    {
        $dsn = sprintf(
            'mysql:host=%s;port=%s;dbname=%s;charset=%s',
            $_ENV['DB_HOST'],
            $_ENV['DB_PORT'] ?? '3306',
            $_ENV['DB_NAME'],
            $_ENV['DB_CHARSET'] ?? 'utf8mb4'
        );
        
        $options = [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ];
        
        return new PDO($dsn, $user, $password, $options);
    }
    
    private function __construct() {}
    private function __clone() {}
    public function __wakeup() 
    {
        throw new Exception("Cannot unserialize singleton");
    }
}