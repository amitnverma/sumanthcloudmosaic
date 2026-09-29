<?php
/**
 * Self-contained DB setup endpoint (no require) for Hostinger.
 * Saves config/db.local.php and can install sql/schema.sql.
 */
error_reporting(E_ALL);
ini_set('display_errors', '0');
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function out($data, $status = 200) {
    http_response_code($status);
    echo json_encode($data);
    exit;
}

function local_path() {
    return __DIR__ . '/config/db.local.php';
}

function defaults() {
    return ['host' => 'localhost', 'db' => 'timetracking', 'user' => 'root', 'pass' => ''];
}

function read_local() {
    $path = local_path();
    $cfg = defaults();
    if (!is_readable($path)) {
        return [$cfg, false];
    }
    $host = $cfg['host'];
    $db = $cfg['db'];
    $user = $cfg['user'];
    $pass = $cfg['pass'];
    include $path;
    return [[
        'host' => (string) $host,
        'db' => (string) $db,
        'user' => (string) $user,
        'pass' => (string) $pass,
    ], true];
}

function write_local($cfg) {
    $dir = __DIR__ . '/config';
    if (!is_dir($dir) && !@mkdir($dir, 0755, true) && !is_dir($dir)) {
        return 'Could not create config/ directory';
    }
    if (!is_writable($dir)) {
        return 'config/ is not writable';
    }
    $content = "<?php\n"
        . '$host = ' . var_export($cfg['host'], true) . ";\n"
        . '$db   = ' . var_export($cfg['db'], true) . ";\n"
        . '$user = ' . var_export($cfg['user'], true) . ";\n"
        . '$pass = ' . var_export($cfg['pass'], true) . ";\n";
    if (@file_put_contents($dir . '/db.local.php', $content, LOCK_EX) === false) {
        return 'Could not write config/db.local.php';
    }
    @chmod($dir . '/db.local.php', 0644);
    return null;
}

function try_connect($cfg) {
    if (!extension_loaded('mysqli')) {
        return [null, 'mysqli extension is not enabled — set PHP 8.x in Hostinger hPanel'];
    }
    mysqli_report(MYSQLI_REPORT_OFF);
    $conn = @new mysqli($cfg['host'], $cfg['user'], $cfg['pass'], $cfg['db']);
    if ($conn->connect_error) {
        return [null, $conn->connect_error];
    }
    $conn->set_charset('utf8mb4');
    return [$conn, null];
}

function install_schema($conn) {
    // Prefer tables-only (no CREATE DATABASE) for Hostinger named DBs.
    $sqlFile = __DIR__ . '/sql/tables-only.sql';
    if (!is_readable($sqlFile)) {
        $sqlFile = __DIR__ . '/sql/schema.sql';
    }
    if (!is_readable($sqlFile)) {
        return 'sql/tables-only.sql (or schema.sql) missing';
    }
    $sql = file_get_contents($sqlFile);
    $sql = preg_replace('/^\s*CREATE\s+DATABASE\b.*?;\s*/im', '', $sql);
    $sql = preg_replace('/^\s*USE\s+\S+\s*;\s*/im', '', $sql);
    if ($conn->multi_query($sql)) {
        do {
            if ($result = $conn->store_result()) {
                $result->free();
            }
        } while ($conn->more_results() && $conn->next_result());
    }
    return $conn->errno ? $conn->error : null;
}

$action = isset($_GET['action']) ? trim($_GET['action']) : '';
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

// Prefer POST JSON (keeps passwords out of access logs). Also accept form POST.
if ($method === 'POST' || $method === 'PUT') {
    $raw = file_get_contents('php://input');
    $body = [];
    if ($raw !== false && $raw !== '') {
        $decoded = json_decode($raw, true);
        if (is_array($decoded)) {
            $body = $decoded;
        }
    }
    if (!$body && !empty($_POST)) {
        $body = $_POST;
    }
    if ($action === '' && !empty($body['action'])) {
        $action = trim((string) $body['action']);
    }
    if ($action === '' && !empty($body['test_only'])) {
        $action = 'test';
    }
    if ($action === '' && (isset($body['host']) || isset($body['db']))) {
        $action = 'save';
    }
    // Expose body fields via $_GET-compatible keys for shared handler below
    foreach (['host', 'db', 'user', 'pass', 'keep_password', 'install_schema', 'test_only'] as $key) {
        if (array_key_exists($key, $body)) {
            $_GET[$key] = $body[$key];
        }
    }
}

if ($action === '' || $action === 'status') {
    list($cfg, $hasLocal) = read_local();
    list($conn, $err) = try_connect($cfg);
    $tablesOk = false;
    if ($conn) {
        $res = $conn->query("SHOW TABLES LIKE 'time_entries'");
        $tablesOk = $res && $res->num_rows > 0;
        $conn->close();
    }
    out([
        'ok' => true,
        'connected' => $err === null,
        'error' => $err,
        'has_local_file' => $hasLocal,
        'tables_ready' => $tablesOk,
        'php' => PHP_VERSION,
        'config' => [
            'host' => $cfg['host'],
            'db' => $cfg['db'],
            'user' => $cfg['user'],
            'has_password' => $cfg['pass'] !== '',
        ],
    ]);
}

if ($action === 'test' || $action === 'save') {
    list($existing) = read_local();
    $host = trim((string) ($_GET['host'] ?? $existing['host']));
    $db = trim((string) ($_GET['db'] ?? $existing['db']));
    $user = trim((string) ($_GET['user'] ?? $existing['user']));
    $pass = array_key_exists('pass', $_GET) ? (string) $_GET['pass'] : null;
    $keepPass = !empty($_GET['keep_password']);
    $installSchema = !empty($_GET['install_schema']);

    if ($host === '' || $db === '' || $user === '') {
        out(['ok' => false, 'error' => 'Host, database name, and username are required'], 400);
    }
    if ($pass === null || ($keepPass && $pass === '')) {
        $pass = $existing['pass'];
    }
    $cfg = compact('host', 'db', 'user', 'pass');
    list($conn, $err) = try_connect($cfg);
    if ($err !== null) {
        out(['ok' => false, 'error' => 'Connection failed: ' . $err, 'connected' => false], 400);
    }
    if ($action === 'test') {
        $conn->close();
        out(['ok' => true, 'connected' => true, 'message' => 'Connection successful', 'php' => PHP_VERSION]);
    }
    $writeErr = write_local($cfg);
    if ($writeErr !== null) {
        $conn->close();
        out(['ok' => false, 'error' => $writeErr], 500);
    }
    $schemaMsg = null;
    if ($installSchema) {
        $schemaErr = install_schema($conn);
        if ($schemaErr !== null) {
            $conn->close();
            out(['ok' => false, 'error' => 'Saved, but schema failed: ' . $schemaErr, 'saved' => true], 500);
        }
        $schemaMsg = 'Tables installed/updated';
    }
    $res = $conn->query("SHOW TABLES LIKE 'time_entries'");
    $tablesOk = $res && $res->num_rows > 0;
    $conn->close();
    out([
        'ok' => true,
        'saved' => true,
        'connected' => true,
        'tables_ready' => $tablesOk,
        'message' => $schemaMsg ?: 'Database credentials saved',
        'php' => PHP_VERSION,
        'config' => [
            'host' => $cfg['host'],
            'db' => $cfg['db'],
            'user' => $cfg['user'],
            'has_password' => $cfg['pass'] !== '',
        ],
    ]);
}

out(['ok' => false, 'error' => 'Unknown action'], 400);
