<?php
/**
 * Database connection for Time Tracking.
 * Optional override: create config/db.local.php on the server (not in git)
 * to set $host, $db, $user, $pass for production without changing this file.
 */
$host = 'localhost';
$db   = 'timetracking';
$user = 'root';
$pass = '';

if (is_readable(__DIR__ . '/db.local.php')) {
    require __DIR__ . '/db.local.php';
}

$conn = new mysqli($host, $user, $pass, $db);
if ($conn->connect_error) {
    http_response_code(500);
    header('Content-Type: application/json');
    echo json_encode(['ok' => false, 'error' => 'Database connection failed: ' . $conn->connect_error]);
    exit;
}

$conn->set_charset('utf8mb4');

/**
 * Send a JSON response and exit.
 */
function json_response($data, $status = 200) {
    http_response_code($status);
    header('Content-Type: application/json');
    echo json_encode($data);
    exit;
}

/**
 * Read JSON body from request.
 */
function read_json_body() {
    $raw = file_get_contents('php://input');
    if ($raw === false || $raw === '') {
        return [];
    }
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

/**
 * Default settings used when a key is missing from DB.
 */
function default_settings() {
    return [
        'week_start_day' => '1',
        'max_hours_per_day' => '8',
        'max_hours_per_week' => '40',
        'hour_increment' => '0.25',
        'require_notes' => '0',
        'default_range_days' => '7',
        'allow_future_dates' => '0',
        'include_weekends' => '1',
        'timezone' => 'America/New_York',
    ];
}

/**
 * Load all settings as key => value map (with defaults).
 */
function load_settings(mysqli $conn) {
    $settings = default_settings();
    $result = $conn->query('SELECT setting_key, setting_value FROM settings');
    if ($result) {
        while ($row = $result->fetch_assoc()) {
            $settings[$row['setting_key']] = $row['setting_value'];
        }
    }
    return $settings;
}
