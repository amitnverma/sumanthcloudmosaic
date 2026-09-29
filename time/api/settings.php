<?php
require_once __DIR__ . '/../config/db.php';

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    $settings = load_settings($conn);
    json_response(['ok' => true, 'settings' => $settings]);
}

if ($method === 'PUT' || $method === 'POST') {
    $body = read_json_body();
    $incoming = $body['settings'] ?? $body;

    if (!is_array($incoming) || empty($incoming)) {
        json_response(['ok' => false, 'error' => 'No settings provided'], 400);
    }

    $allowed = [
        'week_start_day' => function ($v) {
            $n = (int) $v;
            return ($n >= 0 && $n <= 6) ? (string) $n : null;
        },
        'max_hours_per_day' => function ($v) {
            $n = (float) $v;
            return ($n > 0 && $n <= 24) ? (string) $n : null;
        },
        'max_hours_per_week' => function ($v) {
            $n = (float) $v;
            return ($n > 0 && $n <= 168) ? (string) $n : null;
        },
        'hour_increment' => function ($v) {
            $n = (float) $v;
            $ok = in_array($n, [0.25, 0.5, 1.0], true) || abs($n - 0.25) < 0.001 || abs($n - 0.5) < 0.001 || abs($n - 1) < 0.001;
            return $ok ? (string) $n : null;
        },
        'require_notes' => function ($v) {
            return in_array((string) $v, ['0', '1', 'true', 'false'], true)
                ? ((($v === true || $v === '1' || $v === 'true') ? '1' : '0'))
                : null;
        },
        'default_range_days' => function ($v) {
            $n = (int) $v;
            return ($n >= 1 && $n <= 31) ? (string) $n : null;
        },
        'allow_future_dates' => function ($v) {
            return in_array((string) $v, ['0', '1', 'true', 'false'], true)
                ? ((($v === true || $v === '1' || $v === 'true') ? '1' : '0'))
                : null;
        },
        'include_weekends' => function ($v) {
            return in_array((string) $v, ['0', '1', 'true', 'false'], true)
                ? ((($v === true || $v === '1' || $v === 'true') ? '1' : '0'))
                : null;
        },
        'timezone' => function ($v) {
            $v = trim((string) $v);
            return $v !== '' ? $v : null;
        },
    ];

    $stmt = $conn->prepare(
        'INSERT INTO settings (setting_key, setting_value) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)'
    );

    $updated = [];
    foreach ($incoming as $key => $value) {
        if (!isset($allowed[$key])) {
            continue;
        }
        $normalized = $allowed[$key]($value);
        if ($normalized === null) {
            json_response(['ok' => false, 'error' => "Invalid value for {$key}"], 400);
        }
        $stmt->bind_param('ss', $key, $normalized);
        if (!$stmt->execute()) {
            json_response(['ok' => false, 'error' => $stmt->error], 500);
        }
        $updated[$key] = $normalized;
    }
    $stmt->close();

    if (empty($updated)) {
        json_response(['ok' => false, 'error' => 'No valid settings to update'], 400);
    }

    json_response(['ok' => true, 'settings' => load_settings($conn)]);
}

json_response(['ok' => false, 'error' => 'Method not allowed'], 405);
