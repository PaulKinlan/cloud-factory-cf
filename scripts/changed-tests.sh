#!/usr/bin/env bash
# changed-tests.sh — the project's FAST gate (cloud-factory-cf-cn8).
#
# Contract (docs/speed.md, "The fast gate is the contract"):
#   * it is a strict SUBSET of the full gate: it only runs suites that also run there;
#   * a changed SOURCE file that maps to no suite is a FAILURE named on stderr, never a
#     silent no-op — a gate that runs nothing still exits 0 and reports a pass, which is
#     the false green the standard forbids;
#   * docs/config changes are exempt (nothing to run), and it says so;
#   * the merger's full gate stays the oracle for the merged union.
#
# Usage: bash scripts/changed-tests.sh [--base <rev>] [--list]
set -uo pipefail

export PATH="$PWD/node_modules/.bin:$PATH"
BASE=""
LIST=0
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="${2:-}"; shift 2 ;;
    --list) LIST=1; shift ;;
    *) echo "changed-tests: unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -n "$BASE" ] || BASE=$(git merge-base origin/main HEAD 2>/dev/null || git rev-parse HEAD)

changed=$(
  { git diff --name-only "$BASE"...HEAD; git diff --name-only; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u
)
if [ -z "$changed" ]; then
  echo "changed-tests: no changes against $BASE — nothing to run"
  exit 0
fi

is_source() { case "$1" in apps/*/src/*|packages/*/src/*) return 0 ;; *) return 1 ;; esac; }

# Files that are source but have no suite yet. They are named loudly rather than
# silently passing, and the bead tracks adding a test (cloud-factory-cf-5e8, cloud-factory-cf-d8s).
# The canvas UI entry point is exercised in the browser, not in node.
DECLARED_UNVERIFIED="apps/web/src/main.ts"
is_declared() { case " $DECLARED_UNVERIFIED " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

sources=$(echo "$changed" | while read -r path; do is_source "$path" && echo "$path"; done)
if [ -z "$sources" ]; then
  # Build/config/docs only: nothing maps to a suite, but a gate that runs no suite
  # at all cannot be told apart from one whose selection broke (the fleet gate
  # reports coverage UNKNOWN). Run a fixed smoke set so the verdict has evidence.
  echo "changed-tests: $(echo "$changed" | wc -l | tr -d ' ') changed path(s), none of them source — running the smoke set"
  echo "$changed" | sed 's/^/  /'
  if [ "$LIST" -eq 1 ]; then
    echo "changed-tests: smoke = apps/web (whole node suite), apps/worker test/worker.test.ts test/assets.test.ts"
    exit 0
  fi
  smoke_status=0
  (cd apps/web && npx vitest run) || smoke_status=1
  (cd apps/worker && npx vitest run test/worker.test.ts test/assets.test.ts) || smoke_status=1
  exit "$smoke_status"
fi

status=0
ran=0

# Vitest workspaces: ask what this delta actually affects, and refuse to pass when a
# source change selects nothing (that is the unmapped-file false green).
for ws in apps/web apps/worker; do
  ws_sources=$(echo "$sources" | grep -E "^${ws}/src/" || true)
  selected=$( (cd "$ws" && npx vitest list --changed "$BASE" --filesOnly 2>/dev/null) | grep -cE '\.test\.ts$' || true)
  if [ "$selected" -eq 0 ]; then
    if [ -n "$ws_sources" ]; then
      undeclared=$(echo "$ws_sources" | while read -r path; do is_declared "$path" || echo "$path"; done)
      if [ -n "$undeclared" ]; then
        echo "changed-tests: FAIL ${ws} — these changed source files match no suite in this workspace:" >&2
        echo "$undeclared" | sed 's/^/  /' >&2
        status=1
      fi
      has_declared=0
      while read -r path; do
        if is_declared "$path"; then
          has_declared=1
          echo "changed-tests: DECLARED UNVERIFIED $path (no suite yet — cloud-factory-cf-5e8, cloud-factory-cf-d8s)"
        fi
      done <<< "$ws_sources"
      if [ "$has_declared" -eq 1 ] && [ -z "$undeclared" ]; then
        if [ "$LIST" -eq 1 ]; then
          echo "changed-tests: ${ws}: whole suite (smoke)"
          continue
        fi
        ran=$((ran + 1))
        (cd "$ws" && npx vitest run) || status=1
      fi
    fi
    continue
  fi
  echo "changed-tests: ${ws}: ${selected} affected test file(s)"
  if [ "$LIST" -eq 1 ]; then
    (cd "$ws" && npx vitest list --changed "$BASE" --filesOnly 2>/dev/null) | sed 's/^/  /'
    continue
  fi
  ran=$((ran + 1))
  (cd "$ws" && npx vitest run --changed "$BASE") || status=1
done

# The node:test packages: their suites are seconds, so changed means run them.
for ws in packages/sdk packages/cli packages/canvas-model; do
  ws_sources=$(echo "$sources" | grep -E "^${ws}/src/" || true)
  [ -n "$ws_sources" ] || continue
  if [ "$LIST" -eq 1 ]; then echo "changed-tests: ${ws}: whole suite (node:test)"; continue; fi
  echo "changed-tests: ${ws}: whole suite (node:test)"
  ran=$((ran + 1))
  (cd "$ws" && npm test --silent) || status=1
done

if [ "$LIST" -eq 0 ] && [ "$ran" -eq 0 ] && [ "$status" -eq 0 ]; then
  echo "changed-tests: no suite covers this delta — say why on the bead" >&2
  status=1
fi
exit "$status"
