#!/usr/bin/env bash
# Sync this repo into ONE Hostinger folder only.
set -euo pipefail

ALLOWED_USER="cloudmosaicaissh"
ALLOWED_PATH="/home/cloudmosaicaissh/htdocs/cloudmosaic.ai/time"

raw_host="${HOSTINGER_HOST:?Set HOSTINGER_HOST}"
# Sanitize common paste mistakes
HOST="$(printf '%s' "$raw_host" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's|^https\?://||' -e 's|/.*||')"
USER="${HOSTINGER_USER:-$ALLOWED_USER}"
KEY_FILE="${HOSTINGER_SSH_KEY_FILE:?Set HOSTINGER_SSH_KEY_FILE}"

if [[ "$USER" != "$ALLOWED_USER" ]]; then
  echo "Refusing deploy: SSH user must be ${ALLOWED_USER} (got ${USER})."
  exit 1
fi
if [[ ! -f "$KEY_FILE" ]]; then
  echo "SSH key file not found: $KEY_FILE"
  exit 1
fi
if [[ -z "$HOST" ]]; then
  echo "HOSTINGER_HOST is empty after cleanup"
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

ssh_base_opts() {
  local port="$1"
  printf '%s\n' \
    -i "$KEY_FILE" \
    -p "$port" \
    -o BatchMode=yes \
    -o IdentitiesOnly=yes \
    -o PreferredAuthentications=publickey \
    -o PubkeyAuthentication=yes \
    -o PasswordAuthentication=no \
    -o KbdInteractiveAuthentication=no \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o GlobalKnownHostsFile=/dev/null \
    -o ConnectTimeout=20 \
    -o ConnectionAttempts=2 \
    -o ServerAliveInterval=10 \
    -o ServerAliveCountMax=3 \
    -o HostKeyAlgorithms=+ssh-rsa,rsa-sha2-256,rsa-sha2-512,ssh-ed25519 \
    -o PubkeyAcceptedAlgorithms=+ssh-rsa,rsa-sha2-256,rsa-sha2-512,ssh-ed25519 \
    -o KexAlgorithms=+diffie-hellman-group14-sha256,diffie-hellman-group-exchange-sha256,curve25519-sha256
}

tcp_probe() {
  local port="$1"
  python3 - "$HOST" "$port" <<'PY'
import socket, sys
host, port = sys.argv[1], int(sys.argv[2])
infos = []
try:
    infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
except socket.gaierror as e:
    print(f"DNS failed for {host}: {e}")
    sys.exit(1)
last_err = None
for family, _, _, _, sockaddr in infos:
    s = socket.socket(family, socket.SOCK_STREAM)
    s.settimeout(12)
    try:
        s.connect(sockaddr)
        print(f"TCP {sockaddr[0]}:{port} open")
        sys.exit(0)
    except OSError as e:
        last_err = e
    finally:
        s.close()
print(f"TCP {host}:{port} closed/filtered ({last_err})")
sys.exit(1)
PY
}

unique_ports() {
  local seen=" "
  local port
  for port in "$@"; do
    [[ -z "$port" ]] && continue
    [[ "$seen" == *" $port "* ]] && continue
    seen+="$port "
    echo "$port"
  done
}

# Hostinger htdocs paths are usually Cloud/shared hosting → SSH port 65002.
# VPS is usually 22. Try configured port first, then both.
PORTS=()
while IFS= read -r port; do
  PORTS+=("$port")
done < <(unique_ports "${HOSTINGER_PORT:-}" "65002" "22")

echo "Deploy target ${USER}@${HOST} → ${ALLOWED_PATH}"
echo "Raw HOSTINGER_HOST='${raw_host}' cleaned='${HOST}'"
echo "SSH key: $(ssh-keygen -l -f "$KEY_FILE" 2>/dev/null || echo unknown)"
echo "Expected public key on server:"
ssh-keygen -y -f "$KEY_FILE" || true
echo "Will try SSH ports: ${PORTS[*]}"

PORT=""
LAST_ERR=""
TCP_OK_ANY=0
for try_port in "${PORTS[@]}"; do
  echo "==== Port ${try_port} ===="
  if ! tcp_probe "$try_port"; then
    continue
  fi
  TCP_OK_ANY=1
  mapfile -t probe_opts < <(ssh_base_opts "$try_port")
  set +e
  LAST_ERR="$(ssh -vv "${probe_opts[@]}" "${USER}@${HOST}" "echo PREFLIGHT_SSH_OK" 2>&1)"
  status=$?
  set -e
  echo "$LAST_ERR" | grep -E 'PREFLIGHT_SSH_OK|Permission denied|Authentications that can continue|Connection refused|Connection timed out|No route|Authenticated|Offering public key|Server accepts key|Authentication succeeded|debug1: Next authentication' | tail -n 40 || true
  if [[ $status -eq 0 ]]; then
    PORT="$try_port"
    echo "SSH ok on port ${PORT}"
    break
  fi
  echo "Port ${try_port}: SSH failed (exit ${status})."
done

if [[ -z "$PORT" ]]; then
  echo "::error::SSH never connected. GitHub could not log into Hostinger."
  if [[ "$TCP_OK_ANY" -eq 0 ]]; then
    echo "::error::No TCP port opened (tried: ${PORTS[*]}). HOSTINGER_HOST is wrong, or firewall blocks GitHub, or use the SSH hostname/IP from hPanel → Advanced → SSH Access (not just the website domain)."
  else
    echo "::error::TCP opened but login failed. Public key mismatch or wrong SSH user."
    echo "::error::On server, authorized_keys must contain exactly this line:"
    ssh-keygen -y -f "$KEY_FILE" || true
  fi
  exit 255
fi

mapfile -t SSH_OPTS < <(ssh_base_opts "$PORT")
SSH_WRAP="$(mktemp)"
{
  printf '#!/usr/bin/env bash\nexec ssh'
  printf ' %q' "${SSH_OPTS[@]}"
  printf ' "$@"\n'
} > "$SSH_WRAP"
chmod 700 "$SSH_WRAP"
trap 'rm -f "$SSH_WRAP"' EXIT

ssh "${SSH_OPTS[@]}" "${USER}@${HOST}" bash -s <<REMOTE
set -euo pipefail
ALLOWED="${ALLOWED_PATH}"
mkdir -p "\$ALLOWED/api" "\$ALLOWED/assets/css" "\$ALLOWED/assets/js" "\$ALLOWED/config" "\$ALLOWED/sql" "\$ALLOWED/scripts"
chmod -R u+rwX "\$ALLOWED" 2>/dev/null || true
echo "PREFLIGHT_OK \$(pwd) user=\$(id -un) path=\$ALLOWED"
REMOTE

echo "Rsync → ${USER}@${HOST}:${ALLOWED_PATH}/"
# Hostinger rsync is often older; avoid permission/owner sync which causes exit 23.
set +e
rsync -rltvz --protocol=29 --delete \
  --no-owner --no-group --no-perms --omit-dir-times \
  --exclude '.git/' \
  --exclude '.github/' \
  --exclude '.gitignore' \
  --exclude '.DS_Store' \
  --exclude 'config/db.local.php' \
  --exclude 'config/db.local.php.example' \
  -e "$SSH_WRAP" \
  "${ROOT}/" "${USER}@${HOST}:${ALLOWED_PATH}/"
rc=$?
set -e
# 0 = ok, 23/24 sometimes still copied app files with harmless attribute warnings
if [[ "$rc" -eq 0 || "$rc" -eq 23 || "$rc" -eq 24 ]]; then
  echo "Rsync finished with code ${rc}"
else
  echo "::error::Rsync failed with exit code ${rc}"
  exit "$rc"
fi

# Verify critical files landed
ssh "${SSH_OPTS[@]}" "${USER}@${HOST}" bash -s <<REMOTE
set -euo pipefail
ALLOWED="${ALLOWED_PATH}"
for f in index.html hello.php db-setup.php api/entries.php api/db-config.php assets/js/app.js assets/css/app.css sql/tables-only.sql scripts/enable-php-for-time.sh; do
  if [[ ! -f "\$ALLOWED/\$f" ]]; then
    echo "Missing after deploy: \$ALLOWED/\$f"
    exit 1
  fi
done
# Hostinger PHP needs world-readable files; rsync --no-perms can leave 600s → HTML 403
find "\$ALLOWED" -type d -exec chmod 755 {} \;
find "\$ALLOWED" -type f -exec chmod 644 {} \;
chmod 755 "\$ALLOWED/api" "\$ALLOWED/config" "\$ALLOWED/scripts" 2>/dev/null || true
chmod 755 "\$ALLOWED/scripts/enable-php-for-time.sh" "\$ALLOWED/scripts/deploy-hostinger.sh" 2>/dev/null || true
echo "Verify OK + permissions fixed"
# Soft PHP health hint (does not fail deploy — nginx may still need enable-php-for-time.sh)
if command -v curl >/dev/null 2>&1; then
  body="\$(curl -fsS --max-time 8 https://cloudmosaic.ai/time/hello.php 2>/dev/null || true)"
  if printf '%s' "\$body" | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then
    echo "PHP health: OK"
  else
    echo "PHP health: NOT executing yet. On VPS run: sudo bash \$ALLOWED/scripts/enable-php-for-time.sh"
  fi
fi
REMOTE

echo "Deployed to ${ALLOWED_PATH}/ only (SSH port ${PORT})."
