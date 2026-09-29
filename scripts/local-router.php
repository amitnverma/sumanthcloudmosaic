<?php
/**
 * Router for PHP built-in server so React SPA + /time PHP work at site root.
 * Usage: php -S localhost:8080 scripts/local-router.php
 */
$root = dirname(__DIR__);
$uri = urldecode(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH));

// Normalize
if ($uri === '') {
    $uri = '/';
}

$file = $root . $uri;

// Serve existing files (assets, php, images, etc.)
if ($uri !== '/' && is_file($file)) {
    // Let PHP built-in server handle PHP execution / static files
    return false;
}

// Directory with index
if (is_dir($file)) {
    if (is_file($file . '/index.html')) {
        header('Content-Type: text/html; charset=UTF-8');
        readfile($file . '/index.html');
        return true;
    }
    if (is_file($file . '/index.php')) {
        require $file . '/index.php';
        return true;
    }
}

// SPA fallback (React Router) — do not steal /time API paths
if (strpos($uri, '/time') === 0) {
    http_response_code(404);
    echo 'Not found';
    return true;
}

header('Content-Type: text/html; charset=UTF-8');
readfile($root . '/index.html');
return true;
