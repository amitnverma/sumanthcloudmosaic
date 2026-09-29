#!/usr/bin/env bash
# Serve CloudMosaic at http://localhost:8080 (site root — required for React Router)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8080}"
PHP_BIN="${PHP_BIN:-/Applications/XAMPP/xamppfiles/bin/php}"

if [[ ! -x "$PHP_BIN" ]]; then
  PHP_BIN="$(command -v php)"
fi

echo "CloudMosaic local server"
echo "  Marketing: http://localhost:${PORT}/"
echo "  Time app:  http://localhost:${PORT}/time/"
echo "  DB:        timetracking (XAMPP MySQL)"
echo "Ctrl+C to stop."
cd "$ROOT"
exec "$PHP_BIN" -S "localhost:${PORT}" "$ROOT/scripts/local-router.php"
