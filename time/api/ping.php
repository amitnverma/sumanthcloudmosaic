<?php
header('Content-Type: application/json; charset=utf-8');
echo json_encode([
    'ok' => true,
    'php' => PHP_VERSION,
    'mysqli' => class_exists('mysqli'),
    'config_writable' => is_writable(dirname(__DIR__) . '/config'),
    'time' => date('c'),
]);
