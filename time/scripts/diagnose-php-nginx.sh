#!/usr/bin/env bash
# Root diagnostic — prints why /time PHP may not execute.
#   sudo bash /home/cloudmosaicaissh/htdocs/cloudmosaic.ai/time/scripts/diagnose-php-nginx.sh
set -euo pipefail
DOMAIN="${1:-cloudmosaic.ai}"
echo "=== FPM pool ==="
ls -la /etc/php/*/fpm/pool.d/"${DOMAIN}".conf 2>/dev/null || true
grep -H '^listen' /etc/php/*/fpm/pool.d/"${DOMAIN}".conf 2>/dev/null || true
echo "=== snippet file ==="
ls -la /etc/nginx/snippets/time-php-"${DOMAIN}".conf 2>/dev/null || echo "(missing)"
cat /etc/nginx/snippets/time-php-"${DOMAIN}".conf 2>/dev/null || true
echo "=== confs mentioning domain ==="
grep -Rsl --include='*.conf' "$DOMAIN" /etc/nginx 2>/dev/null || true
echo "=== include lines ==="
grep -Rn "time-php-${DOMAIN}\|time-tracking-php\|/time/.*\\.php" /etc/nginx 2>/dev/null | head -50 || true
echo "=== nginx -T matches ==="
nginx -T 2>/dev/null | grep -n "time-php\|location ~ \^/time\|20003\|cloudmosaic.ai" | head -60 || true
echo "=== probe ==="
curl -ksS -D - -o /tmp/tphp.out "https://127.0.0.1/time/hello.php" -H "Host: ${DOMAIN}" | head -20
echo "BODY:"; head -c 200 /tmp/tphp.out; echo
