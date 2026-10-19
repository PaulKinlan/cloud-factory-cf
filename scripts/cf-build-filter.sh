#!/usr/bin/env bash
set -euo pipefail

# Check branch environment variables provided by Cloudflare
BRANCH="${CF_PAGES_BRANCH:-${WORKERS_BRANCH:-}}"

# If git is available, fallback to current git branch
if [ -z "$BRANCH" ] && command -v git >/dev/null 2>&1; then
  BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)
fi

echo "==> Cloudflare Build Filter checking branch: ${BRANCH:-unknown}"

if [[ "$BRANCH" == *"dolt"* ]]; then
  echo "🛑 Dolt database sync ref detected (${BRANCH}). Skipping preview build."
  exit 0
fi

echo "✅ Proceeding with build for branch: ${BRANCH}"
npm run build
