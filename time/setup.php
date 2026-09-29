<?php
/**
 * One-time database setup. Visit once: /timetracking/setup.php
 * Safe to re-run; uses IF NOT EXISTS / seed guards.
 */
$host = 'localhost';
$user = 'root';
$pass = '';

$conn = @new mysqli($host, $user, $pass);
if ($conn->connect_error) {
    http_response_code(500);
    echo '<h1>Setup failed</h1><p>Cannot connect to MySQL: ' . htmlspecialchars($conn->connect_error) . '</p>';
    echo '<p>Start MySQL from the XAMPP control panel, then reload this page.</p>';
    exit;
}

$sqlFile = __DIR__ . '/sql/schema.sql';
if (!is_readable($sqlFile)) {
    http_response_code(500);
    echo '<h1>Setup failed</h1><p>Missing sql/schema.sql</p>';
    exit;
}

$sql = file_get_contents($sqlFile);
if ($conn->multi_query($sql)) {
    do {
        if ($result = $conn->store_result()) {
            $result->free();
        }
    } while ($conn->more_results() && $conn->next_result());
}

if ($conn->errno) {
    http_response_code(500);
    echo '<h1>Setup failed</h1><p>' . htmlspecialchars($conn->error) . '</p>';
    exit;
}

$conn->close();
?>
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Time Tracking Setup</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 560px; margin: 3rem auto; padding: 0 1rem; color: #1c2430; }
    a { color: #1f4e5f; font-weight: 600; }
  </style>
</head>
<body>
  <h1>Database ready</h1>
  <p>The <code>timetracking</code> database, tables, settings, and sample projects were created.</p>
  <p><a href="index.html">Open Time Tracking →</a></p>
</body>
</html>
