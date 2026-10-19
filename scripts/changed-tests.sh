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
  { git diff --name-only "$BASE"...HEAD
    git diff --cached --name-only        # staged but uncommitted
    git diff --name-only                 # unstaged
    git ls-files --others --exclude-standard; } 2>/dev/null | sort -u
)
if [ -z "$changed" ]; then
  echo "changed-tests: no changes against $BASE — nothing to run"
  exit 0
fi

is_source() { case "$1" in apps/*/src/*|packages/*/src/*) return 0 ;; *) return 1 ;; esac; }
is_test() { case "$1" in apps/*/test/*.test.ts|packages/*/tests/*.test.ts) return 0 ;; *) return 1 ;; esac; }
is_runnable() { is_source "$1" || is_test "$1"; }

# Workspaces this gate can actually run, and where their tests live.
VITEST_WORKSPACES="apps/web apps/worker"
NODE_TEST_WORKSPACES="packages/sdk packages/cli packages/canvas-model"
owns_tests() { # <workspace> <path>
  case "$1" in
    apps/*) case "$2" in "$1"/test/*.test.ts) return 0 ;; esac ;;
    *)      case "$2" in "$1"/tests/*.test.ts) return 0 ;; esac ;;
  esac
  return 1
}
run_workspace_suite() { # <workspace>
  case "$1" in
    apps/*) (cd "$1" && npx vitest run) ;;
    *)      (cd "$1" && npm test --silent) ;;
  esac
}

# Files that are source but have no suite yet. They are named loudly rather than
# silently passing, and the bead tracks adding a test (cloud-factory-cf-5e8, cloud-factory-cf-d8s).
# The canvas UI entry point is exercised in the browser, not in node.
DECLARED_UNVERIFIED="apps/web/src/main.ts"
is_declared() { case " $DECLARED_UNVERIFIED " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

runnables=$(echo "$changed" | while read -r path; do is_runnable "$path" && echo "$path"; done)
sources=$(echo "$changed" | while read -r path; do is_source "$path" && echo "$path"; done)
if [ -z "$sources" ]; then
  # No source changed. A test-file delta runs its workspace's whole suite — a
  # deleted or renamed test is never selected by `vitest --changed`, so asking for
  # the delta would run nothing — and anything else falls back to a fixed smoke
  # set. Neither may hard-FAIL: "no suite covers this" for a test-only delta is a
  # false red (cloud-factory-cf-8f1).
  tests=$(echo "$changed" | while read -r path; do is_test "$path" && echo "$path"; done)
  test_status=0
  ran_tests=0
  if [ -n "$tests" ]; then
    for ws in $VITEST_WORKSPACES $NODE_TEST_WORKSPACES; do
      mine=$(echo "$tests" | while read -r path; do owns_tests "$ws" "$path" && echo "$path"; done)
      [ -n "$mine" ] || continue
      ran_tests=1
      if [ "$LIST" -eq 1 ]; then
        echo "changed-tests: ${ws}: whole suite (test-file delta)"
        echo "$mine" | sed 's/^/  /'
        continue
      fi
      echo "changed-tests: ${ws}: whole suite (test-file delta: $(echo "$mine" | tr '\n' ' '))"
      run_workspace_suite "$ws" || test_status=1
    done
    uncovered=$(echo "$tests" | while read -r path; do
      owned=0
      for ws in $VITEST_WORKSPACES $NODE_TEST_WORKSPACES; do owns_tests "$ws" "$path" && owned=1; done
      [ "$owned" -eq 0 ] && echo "$path"
    done)
    if [ -n "$uncovered" ]; then
      echo "changed-tests: not part of the gate (no workspace runs these):"
      echo "$uncovered" | sed 's/^/  /'
    fi
  fi
  if [ "$ran_tests" -eq 1 ]; then
    [ "$LIST" -eq 1 ] && exit 0
    exit "$test_status"
  fi
fi
if [ -z "$runnables" ]; then
  # Build/config/docs only: nothing maps to a suite, but a gate that runs no suite
  # at all cannot be told apart from one whose selection broke (the fleet gate
  # reports coverage UNKNOWN). Run a fixed smoke set so the verdict has evidence.
  echo "changed-tests: $(echo "$changed" | wc -l | tr -d ' ') changed path(s), none of them source or test — running the smoke set"
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
  ws_runnables=$(echo "$runnables" | grep -E "^${ws}/(src|tests)/" || true)
  [ -n "$ws_runnables" ] || continue
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
