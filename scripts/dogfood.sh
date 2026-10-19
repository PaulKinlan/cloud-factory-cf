#!/usr/bin/env bash
set -euo pipefail

# Dogfood runner for Cloud Factory CF
# Runs the self-hosted reviewer agent on the current git workspace/branch

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "🏭 [dogfood] Building workspace packages..."
npm run build -w @factory-cloud/sdk
npm run build -w @factory-cloud/cli

echo "🔍 [dogfood] Running self-hosted PR review agent..."
node packages/cli/dist/bin.js review --cwd "$ROOT_DIR" "$@"
