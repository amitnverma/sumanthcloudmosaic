<?php
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
echo json_encode([
    'ok' => true,
    'php' => PHP_VERSION,
    'sapi' => PHP_SAPI,
    'mysqli' => extension_loaded('mysqli'),
    'message' => 'PHP is running',
]);
