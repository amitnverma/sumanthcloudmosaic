#!/usr/bin/env bash
# Enable PHP-FPM for /time ONLY on CloudPanel/Hostinger nginx.
# Fixes the common failure where include was added to the port-80 redirect
# server block instead of the HTTPS (443) vhost.
#
# Run as root:
#   sudo bash /home/cloudmosaicaissh/htdocs/cloudmosaic.ai/time/scripts/enable-php-for-time.sh
#
# Success check:
#   curl -sS https://cloudmosaic.ai/time/hello.php
# Must print JSON {"ok":true,...} — not <?php source.

set -euo pipefail

DOMAIN="${TIME_DOMAIN:-cloudmosaic.ai}"
SITE_ROOT="${TIME_SITE_ROOT:-/home/cloudmosaicai/htdocs/${DOMAIN}}"
TIME_URI="${TIME_URI_PREFIX:-/time}"
SNIPPET_NAME="time-php-${DOMAIN}.conf"
MARKER_BEGIN="# BEGIN time-tracking-php"
MARKER_END="# END time-tracking-php"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root: sudo bash $0"
  exit 1
fi

if [[ ! -d "$SITE_ROOT/time" ]]; then
  echo "Missing app folder: $SITE_ROOT/time"
  exit 1
fi

detect_fpm() {
  local pool listen
  for pool in \
    "/etc/php/8.5/fpm/pool.d/${DOMAIN}.conf" \
    "/etc/php/8.4/fpm/pool.d/${DOMAIN}.conf" \
    "/etc/php/8.3/fpm/pool.d/${DOMAIN}.conf" \
    "/etc/php/8.2/fpm/pool.d/${DOMAIN}.conf" \
    "/etc/php/8.1/fpm/pool.d/${DOMAIN}.conf"
  do
    if [[ -r "$pool" ]]; then
      listen="$(awk -F= '/^listen[[:space:]]*=/ {gsub(/[[:space:]]/,"",$2); print $2; exit}' "$pool")"
      if [[ -n "$listen" ]]; then
        if [[ "$listen" == /* ]]; then
          echo "unix:$listen"
        else
          echo "$listen"
        fi
        return 0
      fi
    fi
  done
  return 1
}

FPM_PASS="$(detect_fpm || true)"
if [[ -z "${FPM_PASS}" ]]; then
  echo "Could not detect PHP-FPM listen address for ${DOMAIN}."
  exit 1
fi
echo "Using PHP-FPM: $FPM_PASS"

SNIPPET_DIR="/etc/nginx/snippets"
mkdir -p "$SNIPPET_DIR"
SNIPPET_PATH="$SNIPPET_DIR/$SNIPPET_NAME"

# Flat regex location (more reliable than nested location inside ^~).
cat > "$SNIPPET_PATH" <<EOF
${MARKER_BEGIN}
# /time PHP only — other sites / paths untouched.
location ~ ^${TIME_URI}/.*\\.php\$ {
    root ${SITE_ROOT};
    include fastcgi_params;
    fastcgi_param SCRIPT_FILENAME \$document_root\$fastcgi_script_name;
    fastcgi_param HTTP_PROXY "";
    fastcgi_pass ${FPM_PASS};
    fastcgi_read_timeout 60s;
}
${MARKER_END}
EOF
echo "Wrote $SNIPPET_PATH"
cat "$SNIPPET_PATH"
echo

INCLUDE_LINE="    include ${SNIPPET_PATH};"

# Prefer HTTPS / main app server blocks; skip plain redirect-only blocks when possible.
mapfile -t CONF_CANDIDATES < <(
  {
    grep -Rsl --include='*.conf' -E "server_name[[:space:]].*${DOMAIN}" /etc/nginx 2>/dev/null || true
    grep -Rsl --include='*.conf' -F "${SITE_ROOT}" /etc/nginx 2>/dev/null || true
  } | awk 'NF && !seen[$0]++'
)

if [[ "${#CONF_CANDIDATES[@]}" -eq 0 ]]; then
  echo "ERROR: No nginx conf mentioning ${DOMAIN} under /etc/nginx"
  echo "Paste this into CloudPanel → Sites → ${DOMAIN} → Vhost → Additional Nginx Directives:"
  cat "$SNIPPET_PATH"
  exit 2
fi

echo "Candidate vhost files:"
printf '  %s\n' "${CONF_CANDIDATES[@]}"

python3 - "$INCLUDE_LINE" "${CONF_CANDIDATES[@]}" <<'PY'
import re, sys
from pathlib import Path

include_line = sys.argv[1].rstrip() + "\n"
paths = [Path(p) for p in sys.argv[2:]]
updated = []

def split_server_blocks(text: str):
    """Return list of (start, end, block_text) for top-level server { } blocks."""
    blocks = []
    i = 0
    n = len(text)
    while True:
        m = re.search(r'\bserver\s*\{', text[i:])
        if not m:
            break
        start = i + m.start()
        brace_start = i + m.end() - 1  # points at '{'
        depth = 0
        j = brace_start
        while j < n:
            ch = text[j]
            if ch == '{':
                depth += 1
            elif ch == '}':
                depth -= 1
                if depth == 0:
                    end = j + 1
                    blocks.append((start, end, text[start:end]))
                    i = end
                    break
            j += 1
        else:
            break
    return blocks

def is_redirect_only(block: str) -> bool:
    # listen 80 + return 301/302 and no root → skip
    if re.search(r'listen\s+[^;]*\b443\b', block):
        return False
    if re.search(r'\bssl\b', block) and re.search(r'listen\s+', block):
        return False
    if re.search(r'\broot\s+', block):
        return False
    if re.search(r'return\s+30[12]\s+', block) and re.search(r'listen\s+[^;]*\b80\b', block):
        return True
    return False

def block_serves_domain(block: str, domain: str, site_root: str) -> bool:
    if domain not in block and site_root not in block:
        return False
    if is_redirect_only(block):
        return False
    # Prefer blocks that look like real site hosts
    if re.search(r'listen\s+[^;]*\b443\b', block) or re.search(r'\broot\s+', block):
        return True
    return 'server_name' in block

domain = "cloudmosaic.ai"
site_root = "/home/cloudmosaicai/htdocs/cloudmosaic.ai"

for path in paths:
    text = path.read_text()
    # Remove any previous include of this snippet so we can re-place correctly
    text2 = re.sub(
        rf'^[ \t]*include\s+{re.escape(include_line.strip().split(maxsplit=1)[1].rstrip(";"))}\s*;\s*\n',
        '',
        text,
        flags=re.M,
    )
    blocks = split_server_blocks(text2)
    targets = [(s, e, b) for s, e, b in blocks if block_serves_domain(b, domain, site_root)]
    if not targets:
        print(f"skip (no HTTPS/app server block): {path}")
        continue

    # Insert include immediately after each target server { line
    # Process from end to start so offsets stay valid
    out = text2
    changed = False
    for start, end, block in sorted(targets, key=lambda t: t[0], reverse=True):
        if include_line.strip() in block:
            continue
        m = re.match(r'(\bserver\s*\{[ \t]*\n?)', block)
        if not m:
            # fallback: after first '{'
            brace = block.find('{')
            new_block = block[: brace + 1] + "\n" + include_line + block[brace + 1 :]
        else:
            new_block = m.group(1) + include_line + block[m.end() :]
        out = out[:start] + new_block + out[end:]
        changed = True

    if changed or text2 != path.read_text():
        path.write_text(out)
        updated.append(str(path))
        print(f"updated {path} ({len(targets)} server block(s))")
    else:
        # ensure include present
        if include_line.strip() in path.read_text():
            print(f"already ok: {path}")
            updated.append(str(path))
        else:
            print(f"no change: {path}")

if not updated:
    print("ERROR: Could not insert include into an HTTPS/app server block.")
    print("Paste snippet into CloudPanel Additional Nginx Directives instead.")
    raise SystemExit(2)

print("Updated files:")
for p in updated:
    print(" ", p)
PY

echo "Testing nginx config..."
nginx -t

echo "Reloading nginx..."
systemctl reload nginx 2>/dev/null || service nginx reload

echo
echo "=== Active config check (nginx -T) ==="
if nginx -T 2>/dev/null | grep -F "time-php-${DOMAIN}.conf" >/dev/null; then
  echo "OK: snippet is in active nginx config"
  nginx -T 2>/dev/null | grep -n "time-php\|time/.*php\|20003" | head -40
else
  echo "WARNING: snippet include not found in nginx -T output"
  echo "CloudPanel may regenerate vhosts. Use Additional Nginx Directives UI."
fi

echo
echo "=== Local HTTPS probe ==="
BODY="$(curl -ksS --max-time 10 "https://127.0.0.1${TIME_URI}/hello.php" -H "Host: ${DOMAIN}" || true)"
echo "$BODY" | head -c 200; echo
if printf '%s' "$BODY" | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then
  echo "SUCCESS: PHP is executing for ${TIME_URI}"
  exit 0
fi

BODY2="$(curl -sS --max-time 10 "https://${DOMAIN}${TIME_URI}/hello.php" || true)"
echo "Public probe: $(printf '%s' "$BODY2" | head -c 120)"
if printf '%s' "$BODY2" | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then
  echo "SUCCESS via public URL"
  exit 0
fi

echo
echo "FAILED: still getting PHP source or empty response."
echo "Do this in CloudPanel (most reliable on Hostinger):"
echo "  Sites → ${DOMAIN} → Vhost / Nginx → Additional Nginx Directives"
echo "Paste EXACTLY:"
cat "$SNIPPET_PATH"
echo
echo "Save, then: nginx -t && systemctl reload nginx"
exit 1
