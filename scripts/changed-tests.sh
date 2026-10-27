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
# Workspaces are DISCOVERED from the root manifest, not listed here: the previous
# hardcoded pairs of workspace names made every new workspace invisible, so a source
# change inside it was never even checked for coverage and the gate stayed green
# (cloud-factory-cf-9uu). Their test runner is read from each workspace's own `test`
# script, so adding a workspace needs no edit to this file.
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

# ---------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------
is_source() { case "$1" in apps/*/src/*|packages/*/src/*) return 0 ;; *) return 1 ;; esac; }
# A test file is any *.test.ts inside a workspace that is not under that workspace's
# src/ (src files are the change under test, even when a name ends in .test.ts).
is_test() {
  case "$1" in
    */src/*) return 1 ;;
    *.test.*|*.spec.*) case "$1" in apps/*/*|packages/*/*) return 0 ;; esac ;;
  esac
  return 1
}

# The workspace root owning a path: <scope>/<name> (apps/…, packages/…), or empty.
ws_of() {
  case "$1" in
    apps/*/*|packages/*/*)
      local rest="${1#*/}"
      printf '%s/%s\n' "${1%%/*}" "${rest%%/*}" ;;
  esac
}

# ---------------------------------------------------------------------------
# Workspace discovery: read `workspaces` from the root manifest, then read each
# workspace's `test` script to learn which runner (if any) runs its suite.
# Emits "<workspace>\t<kind>" with kind = vitest | node | other | none.
# ---------------------------------------------------------------------------
ws_table=$(
  node --input-type=commonjs -e '
    const fs = require("fs");
    const path = require("path");
    const root = JSON.parse(fs.readFileSync("package.json", "utf8"));
    const ws = root.workspaces;
    const pats = Array.isArray(ws) ? ws : (ws && ws.packages) || [];
    const dirs = [];
    for (const pat of pats) {
      if (typeof pat !== "string") continue;
      const star = pat.indexOf("*");
      if (star < 0) {
        if (fs.existsSync(path.join(pat, "package.json"))) dirs.push(pat);
        continue;
      }
      const base = path.dirname(pat);
      if (!fs.existsSync(base)) continue;
      for (const entry of fs.readdirSync(base).sort()) {
        const dir = path.join(base, entry);
        if (fs.existsSync(path.join(dir, "package.json"))) dirs.push(dir);
      }
    }
    for (const dir of dirs) {
      let script = "";
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
        script = (pkg.scripts && pkg.scripts.test) || "";
      } catch { script = ""; }
      let kind = "none";
      if (/vitest/.test(script)) kind = "vitest";
      else if (/node\s+--test|--experimental-strip-types|node:test/.test(script)) kind = "node";
      else if (script.trim()) kind = "other";
      process.stdout.write(dir + "\t" + kind + "\n");
    }
  ' 2>/dev/null
)
if [ -z "$ws_table" ]; then
  # Enumeration is how coverage is proven; if it breaks the gate must not go green.
  echo "changed-tests: FAIL cannot enumerate workspaces from package.json" >&2
  exit 1
fi

WS_ORDER=()
declare -A WS_KIND=()
while IFS=$'\t' read -r ws kind; do
  [ -n "$ws" ] || continue
  WS_ORDER+=("$ws")
  WS_KIND["$ws"]="$kind"
done <<< "$ws_table"

# Files that are source but have no suite yet. They are named loudly rather than
# silently passing, and the bead tracks adding a test (cloud-factory-cf-5e8, cloud-factory-cf-d8s).
# The canvas UI entry point and its stylesheet are exercised in the browser (headless
# Chrome over CDP, e.g. the 390x844 layout pass for cloud-factory-cf-9jb), not in node.
DECLARED_UNVERIFIED="apps/web/src/main.ts apps/web/src/styles.css"
is_declared() { case " $DECLARED_UNVERIFIED " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

declare -A SRC_BY_WS=()
declare -A TEST_BY_WS=()
sources_n=0
tests_n=0
unmapped_sources=""
unmapped_tests=""
while IFS= read -r path; do
  [ -n "$path" ] || continue
  if is_source "$path"; then
    sources_n=$((sources_n + 1))
    ws=$(ws_of "$path")
    if [ -n "$ws" ] && [ -n "${WS_KIND[$ws]:-}" ] && [ "${WS_KIND[$ws]}" != "none" ]; then
      SRC_BY_WS["$ws"]+="$path"$'\n'
    else
      unmapped_sources+="$path"$'\n'
    fi
  elif is_test "$path"; then
    tests_n=$((tests_n + 1))
    ws=$(ws_of "$path")
    if [ -n "$ws" ] && [ -n "${WS_KIND[$ws]:-}" ] && [ "${WS_KIND[$ws]}" != "none" ]; then
      TEST_BY_WS["$ws"]+="$path"$'\n'
    else
      unmapped_tests+="$path"$'\n'
    fi
  fi
done <<< "$changed"

# Does anything in the workspace reference this source module? `vitest list --changed`
# cannot answer it when the workspace also has a changed test file (that file is selected
# for its own change), so look for the module path in the workspace's imports: a source
# nothing references has no suite, and running the whole suite cannot invent one
# (cloud-factory-cf-9ef).
source_is_referenced() { # <workspace> <source path>
  local ws="$1" src="$2" stem
  case "$src" in
    # Assets carry no module graph, so no import can vouch for them: the workspace
    # suite the caller is about to run is the only coverage that can exist
    # (cloud-factory-cf-2ng: a stylesheet delta was failing the gate by name).
    *.css|*.html|*.htm|*.md|*.json|*.svg|*.txt) return 0 ;;
  esac
  stem="${src#*/src/}"
  stem="${stem%.*}"
  case "$stem" in
    # A barrel (`src/events/index.ts`) is imported by its directory, never by name.
    */index) stem="${stem%/index}" ;;
  esac
  [ -n "$stem" ] || return 1
  grep -rqE "(^|[/'\"])${stem//./\\.}(\\.(m|c)?(t|j)s)?['\"]" "$ws" \
    --include='*.ts' --include='*.tsx' --include='*.js' --include='*.mjs' \
    --include='*.mts' --include='*.cts' \
    --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=coverage 2>/dev/null
}

has_test_files() { # <workspace> — is there anything for its runner to pick up?
  [ -n "$(find "$1" -type f \( -name '*.test.*' -o -name '*.spec.*' \) -not -path '*/node_modules/*' -print -quit 2>/dev/null)" ]
}

# ---------------------------------------------------------------------------
# Build preconditions (cloud-factory-cf-i9mx)
#
# dist/ is gitignored, but a workspace's suite imports its dependencies through their
# dist entry points (`@factory-cloud/sdk`, `@factory-cloud/canvas-model`) and the
# worker's vitest config binds ASSETS to `apps/web/dist`. A worktree that has never
# been built therefore fails for a MISSING ARTIFACT, not for a defect in the change:
# a fresh implementer worktree got a red from `test/assets.test.ts` and could not even
# resolve `@factory-cloud/sdk`, and the same tree went green once it was built.
#
# So build exactly the dist a workspace needs, and only when it is missing: warm
# worktrees pay one `[ -d ]`, a fresh one pays the tsc/vite build once (~3s). A build
# failure is a gate FAILURE with its log — the suites below would prove nothing.
# ---------------------------------------------------------------------------
BUILD_LOG="${TMPDIR:-/tmp}/changed-tests-build.$$.log"
trap 'rm -f "$BUILD_LOG"' EXIT
ensure_dist() { # <dir> <npm workspace name>
  local dir=$1 name=$2
  [ -d "$dir/dist" ] && return 0
  # The gate self-test drives fake runners: no build config, nothing to build.
  [ -f "$dir/tsconfig.build.json" ] || [ -f "$dir/vite.config.ts" ] || return 0
  echo "changed-tests: building ${name} — ${dir}/dist is missing (a fresh worktree has no build artifacts)"
  if ! npm run build -w "$name" >>"$BUILD_LOG" 2>&1; then
    echo "changed-tests: FAIL ${dir} did not build, so its suite cannot say anything about this delta. Log: $BUILD_LOG" >&2
    tail -20 "$BUILD_LOG" >&2
    return 1
  fi
}

ensure_workspace_deps() { # <workspace> — the dist its own suite needs
  case "$1" in
    apps/web) ensure_dist packages/canvas-model @factory-cloud/canvas-model ;;
    apps/worker)
      ensure_dist packages/canvas-model @factory-cloud/canvas-model || return 1
      ensure_dist packages/sdk @factory-cloud/sdk || return 1
      ensure_dist apps/web @factory-cloud/web ;;
    packages/cli) ensure_dist packages/sdk @factory-cloud/sdk ;;
  esac
}

# A single suite may not eat the whole gate budget, and its output must not be the gate's
# own stdout: when a cloudflare/workerd pool fails to start, vitest reports "no tests" and
# leaves a runner child behind, which keeps the inherited pipe open and makes a finished
# gate look like a hang until the wrapper's bound kills it (cloud-factory-cf-8xzi: three
# bound-kills at 900s for a delta whose suite had already errored at 115s). The suite
# writes to a private log that is copied out afterwards, so a leaked child holds the log,
# never the gate's stdout, and a bound that fires names itself instead of looking like a
# timeout of everything.
SUITE_BOUND="${CHANGED_TESTS_SUITE_BOUND:-900}"

run_ws_tests() { # <workspace> <command...> — build what it needs, then run it there
  local ws=$1
  shift
  ensure_workspace_deps "$ws" || return 1
  local log rc
  log=$(mktemp "${TMPDIR:-/tmp}/changed-tests.XXXXXX")
  ( cd "$ws" && timeout -k 15 "$SUITE_BOUND" "$@" ) >"$log" 2>&1
  rc=$?
  cat "$log"
  rm -f "$log"
  case "$rc" in
    124|137|143)
      echo "changed-tests: ${ws}: suite stopped after ${SUITE_BOUND}s (bound reached; a hung runner pool or a leaked child from it)" >&2
      return 1 ;;
  esac
  return "$rc"
}

run_smoke() { # <reason>
  echo "changed-tests: $1 — running the smoke set"
  if [ "$LIST" -eq 1 ]; then
    echo "changed-tests: smoke = apps/web (whole node suite), apps/worker test/worker.test.ts test/assets.test.ts"
    return 0
  fi
  local smoke_status=0
  # A workspace whose tests were just deleted has nothing for vitest to find, and
  # vitest exits 1 on that: name it as a no-op instead of a false red.
  if has_test_files apps/web; then
    run_ws_tests apps/web npx vitest run || smoke_status=1
  else
    echo "changed-tests: apps/web: no test files remain — skipped in the smoke set"
  fi
  if [ -f apps/worker/test/worker.test.ts ] || [ -f apps/worker/test/assets.test.ts ]; then
    run_ws_tests apps/worker npx vitest run test/worker.test.ts test/assets.test.ts || smoke_status=1
  else
    echo "changed-tests: apps/worker: smoke tests removed — skipped in the smoke set"
  fi
  return "$smoke_status"
}

# The gate's own decision logic has no workspace suite, so its test is the self-test
# (fake runners in a throwaway repo, no deps). It runs whenever the gate changes.
SELFTEST="scripts/changed-tests.selftest.sh"
selftest_wanted=0
if echo "$changed" | grep -qxE 'scripts/changed-tests(\.selftest)?\.sh'; then selftest_wanted=1; fi
run_selftest() {
  echo "changed-tests: gate self-test (${SELFTEST})"
  bash "$SELFTEST"
}

if [ "$sources_n" -eq 0 ] && [ "$tests_n" -eq 0 ]; then
  # Build/config/docs only: nothing maps to a suite, but a gate that runs no suite at
  # all cannot be told apart from one whose selection broke (the fleet gate reports
  # coverage UNKNOWN). Run a fixed smoke set so the verdict has evidence.
  echo "changed-tests: $(echo "$changed" | wc -l | tr -d ' ') changed path(s), none of them source or test:"
  echo "$changed" | sed 's/^/  /'
  # A delta confined to the gate's own decision logic cannot change app behaviour, and the
  # precise check for it is the self-test. The browser/workerd smoke set buys nothing there
  # and cost a whole 900s bound on a loaded VM, which killed the gate with no verdict
  # (cloud-factory-cf-xszd). Any other path in the delta keeps the smoke set: that is what
  # catches a gate that fails open on a real workspace.
  selftest_only=0
  if [ "$selftest_wanted" -eq 1 ] && ! echo "$changed" | grep -qvxE 'scripts/changed-tests(\.selftest)?\.sh'; then
    selftest_only=1
  fi
  if [ "$LIST" -eq 1 ]; then
    if [ "$selftest_only" -eq 1 ]; then
      echo "changed-tests: ${SELFTEST}: gate self-test only (delta is confined to the gate's own logic)"
      exit 0
    fi
    [ "$selftest_wanted" -eq 1 ] && echo "changed-tests: ${SELFTEST}: gate self-test"
    echo "changed-tests: smoke = apps/web (whole node suite), apps/worker test/worker.test.ts test/assets.test.ts"
    exit 0
  fi
  smoke_status=0
  if [ "$selftest_wanted" -eq 1 ]; then run_selftest || smoke_status=1; fi
  if [ "$selftest_only" -eq 1 ]; then
    # Positive evidence of what ran. Without it the coverage reader sees a log that names
    # no suite and reports the changed files as "NOT demonstrated to be exercised", which
    # is the opposite of what happened: the self-test is the whole check for this delta.
    if [ "$smoke_status" -eq 0 ]; then
      echo "fast-gate: passed: ${SELFTEST}"
    else
      echo "fast-gate: failed: ${SELFTEST}"
    fi
    exit "$smoke_status"
  fi
  run_smoke "nothing mapped to a suite" || smoke_status=1
  exit "$smoke_status"
fi

status=0
ran=0
noop_ws=""   # workspaces whose test files this delta removed (a5s)

# A source file in a directory that is no workspace, or in a workspace with no test
# script, maps to no suite: that is the unmapped-source false green, named on stderr.
if [ -n "$unmapped_sources" ]; then
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    ws=$(ws_of "$path")
    if is_declared "$path"; then
      echo "changed-tests: DECLARED UNVERIFIED $path (no suite yet — cloud-factory-cf-5e8, cloud-factory-cf-d8s)"
      continue
    fi
    if [ -z "$ws" ] || [ -z "${WS_KIND[$ws]:-}" ]; then
      echo "changed-tests: FAIL ${path} — not inside any workspace declared in package.json, so no suite can cover it" >&2
    else
      echo "changed-tests: FAIL ${path} — workspace ${ws} has no test script, so this source change runs no suite" >&2
    fi
    status=1
  done <<< "$unmapped_sources"
fi
if [ -n "$unmapped_tests" ]; then
  echo "changed-tests: not part of the gate (no workspace runs these):"
  echo "$unmapped_tests" | grep -v '^$' | sed 's/^/  /'
fi

# Per-workspace execution. Tests and sources are decided independently: a test-file
# delta in one workspace is never skipped because another workspace's source changed.
for ws in "${WS_ORDER[@]}"; do
  kind="${WS_KIND[$ws]}"
  [ "$kind" = "none" ] && continue
  ws_tests="${TEST_BY_WS[$ws]:-}"
  ws_sources="${SRC_BY_WS[$ws]:-}"
  [ -n "$ws_tests" ] || [ -n "$ws_sources" ] || continue

  if [ -n "$ws_tests" ]; then
    # Source validation comes FIRST and in every mode, --list included, and for every
    # runner (vitest and node:test alike): a test-file delta never vouches for the changed
    # sources beside it (cloud-factory-cf-9ef, rev-gate6), and a deleted last test leaves
    # them nothing to run (cloud-factory-cf-u8k). --list used to report a clean selection
    # here while the run mode failed the same delta (cloud-factory-cf-ryb).
    ws_has_tests=1
    has_test_files "$ws" || ws_has_tests=0
    if [ -n "$ws_sources" ]; then
      unreferenced=""
      while IFS= read -r path; do
        [ -n "$path" ] || continue
        if is_declared "$path"; then
          echo "changed-tests: DECLARED UNVERIFIED $path (no suite yet — cloud-factory-cf-5e8, cloud-factory-cf-d8s)"
        elif [ "$ws_has_tests" -eq 0 ]; then
          echo "changed-tests: FAIL ${path} — ${ws} has no test files left, so this source change runs no suite" >&2
          status=1
        elif ! source_is_referenced "$ws" "$path"; then
          unreferenced+="$path"$'\n'
        fi
      done <<< "$ws_sources"
      if [ -n "$unreferenced" ]; then
        echo "changed-tests: FAIL ${ws} — nothing in this workspace references these changed source files, so its test-file delta cannot cover them:" >&2
        echo "$unreferenced" | grep -v '^$' | sed 's/^/  /' >&2
        status=1
      fi
    fi

    if [ "$ws_has_tests" -eq 0 ]; then
      # Nothing for the runner to pick up: name the lost coverage (a5s) and let the smoke
      # set supply evidence from the workspaces that still have tests.
      [ -n "$ws_sources" ] || echo "changed-tests: ${ws}: no test files remain — nothing to run (this delta removes the workspace's only coverage; say why on the bead)"
      noop_ws+=" ${ws}"
      continue
    fi

    # Is this delta removing a test file? `vitest --changed` can only select a path that
    # still exists, so a deleted or renamed test keeps the workspace-wide run
    # (cloud-factory-cf-8f1).
    test_gone=""
    while IFS= read -r path; do
      [ -n "$path" ] || continue
      [ -f "$path" ] || test_gone+="$path"$'\n'
    done <<< "$ws_tests"

    selected_files=""
    selected=0
    if [ -z "$test_gone" ] && [ "$kind" = "vitest" ]; then
      selected_files=$( (cd "$ws" && npx vitest list --changed "$BASE" --filesOnly 2>/dev/null) | grep -E '\.(test|spec)\.[cm]?[jt]sx?$' || true)
      selected=$(printf '%s' "$selected_files" | grep -c . || true)
      case "$selected" in ''|*[!0-9]*) selected=0 ;; esac
    fi

    if [ -z "$test_gone" ] && [ "$selected" -gt 0 ]; then
      # Every changed test file still exists and vitest can attribute this delta to suites:
      # run exactly those. Naming every suite in the workspace because one test file was
      # edited is what put apps/worker's 35-file suite past the fast tier's bound and got
      # unrelated landings KILLED at it (cloud-factory-cf-67sy).
      if [ "$LIST" -eq 1 ]; then
        echo "changed-tests: ${ws}: ${selected} affected test file(s) (test-file delta)"
        printf '%s\n' "$selected_files" | sed 's/^/  /'
        continue
      fi
      echo "changed-tests: ${ws}: ${selected} affected test file(s) (test-file delta: $(echo "$ws_tests" | tr '\n' ' '))"
      ran=$((ran + 1))
      # Name the selected files instead of asking vitest to re-derive them with
      # `--changed`. Two reasons: it is one whole vitest bootstrap cheaper per gate
      # (the selection above already paid for a `list --changed`), and in apps/worker
      # the `--changed` run never reached a test at all - the banner printed and then
      # nothing for 900s, twice, killing the fast gate at its bound (8xzi's delta),
      # while the very same file runs by name in about two minutes.
      files=()
      while IFS= read -r f; do [ -n "$f" ] && files+=("$f"); done <<< "$selected_files"
      run_ws_tests "$ws" npx vitest run "${files[@]}" || status=1
      continue
    fi

    # Whole suite: a deleted or renamed test is never selected by `vitest --changed`, so
    # asking for the delta would run nothing, and a delta vitest cannot attribute at all
    # must not pass on an empty run (cloud-factory-cf-8f1).
    if [ "$LIST" -eq 1 ]; then
      echo "changed-tests: ${ws}: whole suite (test-file delta)"
      echo "$ws_tests" | grep -v '^$' | sed 's/^/  /'
      continue
    fi
    echo "changed-tests: ${ws}: whole suite (test-file delta: $(echo "$ws_tests" | tr '\n' ' '))"
    ran=$((ran + 1))
    if [ "$kind" = "vitest" ]; then run_ws_tests "$ws" npx vitest run || status=1
    else run_ws_tests "$ws" npm test --silent || status=1; fi
    continue
  fi

  # Source-only delta for this workspace. The selection is captured as a LIST, not just
  # a count: it is what gets run below, so the gate never pays a second `--changed`
  # bootstrap to re-derive a selection it already has (cloud-factory-cf-56j5, the same
  # mechanism the test-file path above uses).
  selected_files=""
  if [ "$kind" = "vitest" ]; then
    selected_files=$( (cd "$ws" && npx vitest list --changed "$BASE" --filesOnly 2>/dev/null) | grep -E '\.(test|spec)\.[cm]?[jt]sx?$' || true)
    selected=$(printf '%s' "$selected_files" | grep -c . || true)
    case "$selected" in ''|*[!0-9]*) selected=0 ;; esac
  else
    selected=1   # node:test packages run their whole suite, so a source change is covered
  fi
  undeclared=$(echo "$ws_sources" | grep -v '^$' | while read -r path; do is_declared "$path" || echo "$path"; done)

  if [ "$kind" = "vitest" ] && [ "$selected" -eq 0 ]; then
    if [ -n "$undeclared" ]; then
      echo "changed-tests: FAIL ${ws} — these changed source files match no suite in this workspace:" >&2
      echo "$undeclared" | sed 's/^/  /' >&2
      status=1
      continue
    fi
    # Every changed source here is DECLARED UNVERIFIED: run the whole workspace suite
    # so the verdict still has evidence instead of an empty pass.
    echo "changed-tests: ${ws}: whole suite (declared-unverified source)"
    if [ "$LIST" -eq 1 ]; then continue; fi
    if ! has_test_files "$ws"; then
      echo "changed-tests: ${ws}: no test files in the workspace — nothing to run"
      continue
    fi
    ran=$((ran + 1))
    run_ws_tests "$ws" npx vitest run || status=1
    continue
  fi

  if [ "$kind" = "vitest" ]; then
    echo "changed-tests: ${ws}: ${selected} affected test file(s)"
    if [ "$LIST" -eq 1 ]; then
      printf '%s\n' "$selected_files" | sed 's/^/  /'
      continue
    fi
    ran=$((ran + 1))
    # Run the selection by name rather than asking vitest to re-derive it with
    # `--changed`: one vitest bootstrap cheaper per source delta, and the invocation
    # shape the fast tier can afford (cloud-factory-cf-56j5).
    files=()
    while IFS= read -r f; do [ -n "$f" ] && files+=("$f"); done <<< "$selected_files"
    run_ws_tests "$ws" npx vitest run "${files[@]}" || status=1
    continue
  fi

  # node:test / other runners: their suites are seconds, so changed means run them.
  if [ "$LIST" -eq 1 ]; then echo "changed-tests: ${ws}: whole suite (${kind})"; continue; fi
  echo "changed-tests: ${ws}: whole suite (${kind})"
  ran=$((ran + 1))
  run_ws_tests "$ws" npm test --silent || status=1
done

if [ "$selftest_wanted" -eq 1 ]; then
  if [ "$LIST" -eq 1 ]; then
    echo "changed-tests: ${SELFTEST}: gate self-test"
  else
    ran=$((ran + 1))
    run_selftest || status=1
  fi
fi

# --list only reports; it never runs a suite, so "ran nothing" is not a failure there.
if [ "$ran" -eq 0 ] && [ "$status" -eq 0 ] && [ "$LIST" -eq 0 ]; then
  if [ "$sources_n" -eq 0 ]; then
    # Only test files ran nothing: either they belong to no runnable workspace, or the
    # delta removed the only tests a workspace had. Name which, then run the smoke set
    # rather than hard-failing on a mapping detail (cloud-factory-cf-8f1, a5s).
    if [ -n "$noop_ws" ]; then
      run_smoke "test files removed from${noop_ws}"
    else
      run_smoke "test-file delta outside every runnable workspace"
    fi
    exit $?
  fi
  echo "changed-tests: no suite covers this delta — say why on the bead" >&2
  status=1
fi
exit "$status"
