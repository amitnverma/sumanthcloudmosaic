#!/usr/bin/env bash
# One-time: init git, push to GitHub, print Hostinger secret checklist.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

REPO_HTTPS="https://github.com/amitnverma/sumanthcloudmosaic.git"
REPO_SSH="git@github.com:amitnverma/sumanthcloudmosaic.git"

if [[ ! -d .git ]]; then
  git init -b main
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  git remote add origin "$REPO_HTTPS"
fi

git add -A
if git status --short | grep -E 'db\.local|\.env' ; then
  echo "Refusing: secrets would be committed. Fix .gitignore first."
  exit 1
fi

if [[ -z "$(git status --porcelain)" ]] && git rev-parse HEAD >/dev/null 2>&1; then
  echo "Nothing new to commit."
else
  git commit -m "$(cat <<'EOF'
Initial import of CloudMosaic site with Hostinger auto-deploy.

Includes marketing SPA, /time PHP app, and GitHub Actions deploy scoped to cloudmosaic.ai only.
EOF
)" || git commit --allow-empty -m "chore: ensure main branch exists for deploy workflow"
fi

git branch -M main

echo "Pushing to $REPO_HTTPS ..."
if ! git push -u origin main; then
  echo "HTTPS push failed — trying SSH remote..."
  git remote set-url origin "$REPO_SSH"
  git push -u origin main
fi

echo
echo "=== Done. Next: add GitHub Actions secrets ==="
echo "Open: https://github.com/amitnverma/sumanthcloudmosaic/settings/secrets/actions"
echo
echo "HOSTINGER_HOST  = SSH host/IP from hPanel → Advanced → SSH Access"
echo "HOSTINGER_SSH_KEY = contents of ~/.ssh/hostinger_timetracking (private key)"
echo "HOSTINGER_PORT  = 65002 or 22 (optional; workflow tries both)"
echo
echo "Deploy target (hardcoded, safe): /home/cloudmosaicaissh/htdocs/cloudmosaic.ai"
echo "Public key that must be in server authorized_keys:"
cat ~/.ssh/hostinger_timetracking.pub 2>/dev/null || true
echo
echo "Actions: https://github.com/amitnverma/sumanthcloudmosaic/actions"
