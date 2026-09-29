#!/usr/bin/env bash
# Sync this repo into ONE Hostinger folder only:
#   /home/cloudmosaicaissh/htdocs/cloudmosaic.ai
# Other sites on the VPS are never touched.
# time/config/db.local.php on the server is never overwritten.
set -euo pipefail

ALLOWED_USER="cloudmosaicaissh"
ALLOWED_PATH="/home/cloudmosaicaissh/htdocs/cloudmosaic.ai"

raw_host="${HOSTINGER_HOST:?Set HOSTINGER_HOST}"
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

PORTS=()
while IFS= read -r port; do
  PORTS+=("$port")
done < <(unique_ports "${HOSTINGER_PORT:-}" "65002" "22")

echo "Deploy target ${USER}@${HOST} → ${ALLOWED_PATH}"
echo "Raw HOSTINGER_HOST='${raw_host}' cleaned='${HOST}'"
echo "SSH key: $(ssh-keygen -l -f "$KEY_FILE" 2>/dev/null || echo unknown)"
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
    echo "::error::No TCP port opened (tried: ${PORTS[*]}). Check HOSTINGER_HOST / firewall / SSH Access hostname."
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
case "\$ALLOWED" in
  */cloudmosaic.ai|*/cloudmosaic.ai/) ;;
  *)
    echo "Refusing remote path outside cloudmosaic.ai: \$ALLOWED"
    exit 1
    ;;
esac

# Ensure target exists and is writable by the deploy user.
mkdir -p "\$ALLOWED" "\$ALLOWED/time/api" "\$ALLOWED/time/assets" "\$ALLOWED/time/config" "\$ALLOWED/scripts"
if ! touch "\$ALLOWED/_write_test" 2>/dev/null; then
  echo "::error::Site root is not writable by \$(id -un): \$ALLOWED"
  echo "::error::On the VPS (as root), run once:"
  echo "::error::  sudo chown -R cloudmosaicaissh:cloudmosaicai \$ALLOWED"
  echo "::error::  sudo chmod -R u+rwX,g+rwX \$ALLOWED"
  exit 1
fi
rm -f "\$ALLOWED/_write_test"

# Root-owned images/static (common after panel uploads) block rsync temp files.
# If the parent is writable, rename them aside and recreate empty dirs we own.
ensure_writable_dir() {
  local dir="\$1"
  local path="\$ALLOWED/\$dir"
  if [[ -d "\$path" ]] && touch "\$path/.write_probe" 2>/dev/null; then
    rm -f "\$path/.write_probe"
    return 0
  fi
  if [[ -e "\$path" ]]; then
    echo "Path not writable by deploy user: \$path (owner=\$(stat -c '%U:%G' "\$path" 2>/dev/null || echo unknown))"
    # Prefer a dot-dir so leftovers are less web-exposed; root must delete later.
    local aside="\$ALLOWED/.\${dir}.__root_old.\$(date +%s)"
    if mv "\$path" "\$aside" 2>/dev/null; then
      echo "Moved unwritable '\$dir' aside → \$aside"
      echo "Ask root to delete later: sudo rm -rf \$aside"
    else
      echo "::error::Cannot write to \$path and cannot rename it aside."
      echo "::error::On the VPS (as root), run once:"
      echo "::error::  sudo chown -R cloudmosaicaissh:cloudmosaicai \$ALLOWED/images \$ALLOWED/static"
      echo "::error::  sudo chmod -R u+rwX,g+rwX \$ALLOWED/images \$ALLOWED/static"
      exit 1
    fi
  fi
  mkdir -p "\$path"
  chmod 775 "\$path" || true
  if ! touch "\$path/.write_probe" 2>/dev/null; then
    echo "::error::Still cannot write \$path after recreate."
    exit 1
  fi
  rm -f "\$path/.write_probe"
}

ensure_writable_dir images
ensure_writable_dir static
mkdir -p "\$ALLOWED/static/css" "\$ALLOWED/static/js" "\$ALLOWED/static/media"
chmod -R u+rwX "\$ALLOWED" 2>/dev/null || true
echo "PREFLIGHT_OK user=\$(id -un) path=\$ALLOWED"
REMOTE

echo "Rsync → ${USER}@${HOST}:${ALLOWED_PATH}/"
set +e
rsync -rltvz --protocol=29 --delete \
  --no-owner --no-group --no-perms --omit-dir-times \
  --exclude '.git/' \
  --exclude '.github/' \
  --exclude '.gitignore' \
  --exclude 'README.md' \
  --exclude '_write_test' \
  --exclude '.DS_Store' \
  --exclude 'scripts/start-local.sh' \
  --exclude 'scripts/local-router.php' \
  --exclude 'time/config/db.local.php' \
  --exclude 'time/config/db.local.php.example' \
  --exclude '.images.__root_old/' \
  --exclude '.static.__root_old/' \
  --exclude 'images.__root_old/' \
  --exclude 'static.__root_old/' \
  --exclude '*.__root_old/' \
  --exclude '*.__root_old.*/' \
  -e "$SSH_WRAP" \
  "${ROOT}/" "${USER}@${HOST}:${ALLOWED_PATH}/"
rc=$?
set -e
if [[ "$rc" -eq 0 || "$rc" -eq 23 || "$rc" -eq 24 ]]; then
  echo "Rsync finished with code ${rc}"
else
  echo "::error::Rsync failed with exit code ${rc}"
  exit "$rc"
fi

ssh "${SSH_OPTS[@]}" "${USER}@${HOST}" bash -s <<REMOTE
set -euo pipefail
ALLOWED="${ALLOWED_PATH}"
for f in index.html static/js time/index.html time/api/entries.php time/hello.php; do
  if [[ ! -e "\$ALLOWED/\$f" ]]; then
    echo "Missing after deploy: \$ALLOWED/\$f"
    exit 1
  fi
done
# Keep production DB override if present
if [[ -f "\$ALLOWED/time/config/db.local.php" ]]; then
  echo "Preserved time/config/db.local.php"
fi
find "\$ALLOWED" -path '*/.*__root_old*' -prune -o -type d -exec chmod 755 {} \; 2>/dev/null || true
find "\$ALLOWED" -path '*/.*__root_old*' -prune -o -type f -exec chmod 644 {} \; 2>/dev/null || true
chmod 755 "\$ALLOWED/scripts" "\$ALLOWED/time/scripts" 2>/dev/null || true
find "\$ALLOWED" -path '*/.*__root_old*' -prune -o -type f -name '*.sh' -exec chmod 755 {} \; 2>/dev/null || true
echo "Verify OK + permissions fixed → \$ALLOWED only"
if command -v curl >/dev/null 2>&1; then
  body="\$(curl -fsS --max-time 8 https://cloudmosaic.ai/time/hello.php 2>/dev/null || true)"
  if printf '%s' "\$body" | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then
    echo "PHP health: OK"
  else
    echo "PHP health: check https://cloudmosaic.ai/time/hello.php if needed"
  fi
fi
REMOTE

echo "Deployed to ${ALLOWED_PATH}/ only (SSH port ${PORT})."
