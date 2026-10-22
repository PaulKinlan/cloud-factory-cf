#!/usr/bin/env bash
# Self-test for scripts/changed-tests.sh — the fast gate's own selection logic.
#
# The gate decides what to run from a git delta, and every historical defect here was
# a decision defect (a silent green, a skipped workspace, a false red), not a bug in a
# suite. So this builds a throwaway repo with fake runners — no node_modules, no
# network, well under a second — and asserts what the gate selects and what it exits.
#
# Runs as the changed-tests.sh suite when the gate script itself changes; it is also
# runnable by hand:
#   bash scripts/changed-tests.selftest.sh
set -uo pipefail

SELF_DIR=$(cd "$(dirname "$0")" && pwd)
GATE="$SELF_DIR/changed-tests.sh"
[ -f "$GATE" ] || { echo "selftest: cannot find $GATE" >&2; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
FIX="$TMP/repo"
OUT="$TMP/out"
ERR="$TMP/err"
fails=0
checks=0

mkfixture() {
  rm -rf "$FIX"
  mkdir -p "$FIX"
  ( cd "$FIX"
    git init -q .
    git config user.email selftest@example.invalid
    git config user.name selftest
    cat > package.json <<'JSON'
{ "name": "fixture", "private": true, "workspaces": ["packages/*", "apps/*"] }
JSON
    printf 'node_modules/\n' > .gitignore
    mkdir -p node_modules/.bin
    # Fake runners: the gate prepends $PWD/node_modules/.bin to PATH.
    cat > node_modules/.bin/vitest <<'SH'
#!/usr/bin/env bash
# Fake vitest: `list --changed` reports $FAKE_SELECT (nothing when unset),
# `run` reports it ran and exits $FAKE_VITEST_RC.
case "${1:-}" in
  list) [ -n "${FAKE_SELECT:-}" ] && printf '%s\n' $FAKE_SELECT; exit 0 ;;
  run) echo "FAKE vitest run in $(basename "$PWD")"
       [ -n "${FAKE_BUILD_LOG:-}" ] && echo "run $(basename "$PWD")" >> "$FAKE_BUILD_LOG"
       exit "${FAKE_VITEST_RC:-0}" ;;
  *) exit 0 ;;
esac
SH
    # Fake npm. `run build -w <pkg>` is the gate's dist precondition (cloud-factory-cf-
    # i9mx): it records the package in $FAKE_BUILD_LOG, creates the dist that package
    # would ship, and fails with $FAKE_BUILD_RC when that is set. Everything else is a
    # test run.
    cat > node_modules/.bin/npm <<'SH'
#!/usr/bin/env bash
if [ "${1:-}" = "run" ] && [ "${2:-}" = "build" ]; then
  pkg="${4:-}"
  [ -n "${FAKE_BUILD_LOG:-}" ] && echo "build ${pkg}" >> "$FAKE_BUILD_LOG"
  if [ "${FAKE_BUILD_RC:-0}" != "0" ]; then
    echo "fake build error: ${pkg}" >&2
    exit "$FAKE_BUILD_RC"
  fi
  case "$pkg" in
    @factory-cloud/web) mkdir -p apps/web/dist && printf 'built\n' > apps/web/dist/index.html ;;
    @factory-cloud/sdk) mkdir -p packages/sdk/dist && printf 'built\n' > packages/sdk/dist/index.js ;;
    @factory-cloud/canvas-model) mkdir -p packages/canvas-model/dist && printf 'built\n' > packages/canvas-model/dist/index.js ;;
  esac
  exit 0
fi
echo "FAKE npm test in $(basename "$PWD")"; exit "${FAKE_NPM_RC:-0}"
SH
    chmod +x node_modules/.bin/vitest node_modules/.bin/npm
    # Fake npx. The gate invokes `npx vitest …`, and a REAL npx resolves a command it
    # cannot find in the workspace's own node_modules through the registry: the fixture
    # workspaces have no node_modules, so this self-test silently depended on the network
    # and hit its 60s bound on a loaded VM (case 9, unowned test file -> smoke set).
    cat > node_modules/.bin/npx <<'SH'
#!/usr/bin/env bash
# Fake npx: drop the command name (vitest) and run this fixture's fake runner.
shift
exec vitest "$@"
SH
    chmod +x node_modules/.bin/npx
    # apps/* : vitest workspaces. packages/* : node:test, plus a workspace with no
    # test script at all (the unmapped-source case).
    for ws in apps/web apps/worker; do
      mkdir -p "$ws/test" "$ws/src"
      printf '{ "name": "%s", "scripts": { "test": "vitest run" } }\n' "$ws" > "$ws/package.json"
      # apps/web is a real bundler workspace: the gate builds it when dist is missing.
      [ "$ws" = "apps/web" ] && printf 'export default {};\n' > "$ws/vite.config.ts"
      printf 'export const a = 1;\n' > "$ws/src/m.ts"
      printf 'export const entry = 1;\n' > "$ws/src/main.ts"
      printf 'import { a } from "../src/m";\nimport { test } from "vitest";\ntest("x", () => { void a; });\n' > "$ws/test/a.test.ts"
    done
    # a stylesheet is source with no node suite of its own (cloud-factory-cf-9jb)
    printf 'body { margin: 0; }\n' > apps/web/src/styles.css
    # the smoke set names these two worker files explicitly
    for f in worker assets auth git-tree; do
      printf 'export {};\n' > "apps/worker/test/$f.test.ts"
    done
    mkdir -p .fleet apps/worker/src/auth apps/worker/src/routes
    cat > .fleet/coverage-contract.json <<'JSON'
{
  "apps/worker/src/auth/tenant.ts": ["apps/worker/test/auth.test.ts"],
  "apps/worker/src/routes/auth.ts": ["apps/worker/test/auth.test.ts"],
  "apps/worker/src/routes/git-tree.ts": ["apps/worker/test/git-tree.test.ts"]
}
JSON
    # The buildable packages apps/worker imports through their dist entry points; they
    # have a build script and no tests of their own (kind: none).
    for pkg in canvas-model sdk; do
      mkdir -p "packages/$pkg/src"
      printf '{ "name": "@factory-cloud/%s", "scripts": { "build": "tsc -p tsconfig.build.json" } }\n' "$pkg" > "packages/$pkg/package.json"
      printf '{}\n' > "packages/$pkg/tsconfig.build.json"
      printf 'export const p = 1;\n' > "packages/$pkg/src/index.ts"
    done
    mkdir -p packages/specp/tests packages/specp/src
    printf '{ "name": "specp", "scripts": { "test": "node --test tests/**/*.spec.ts" } }\n' > packages/specp/package.json
    printf 'export const sp = 1;\n' > packages/specp/src/s.ts
    printf 'import { test } from "node:test";\ntest("sp", () => {});\n' > packages/specp/tests/x.spec.ts
    mkdir -p packages/nodep/tests packages/nodep/src packages/plain/src
    printf '{ "name": "nodep", "scripts": { "test": "node --test tests/**/*.test.ts" } }\n' > packages/nodep/package.json
    printf 'export const n = 1;\n' > packages/nodep/src/n.ts
    printf 'import { test } from "node:test";\nimport { n } from "../src/n";\ntest("n", () => { void n; });\n' > packages/nodep/tests/n.test.ts
    printf '{ "name": "plain", "scripts": { "build": "tsc" } }\n' > packages/plain/package.json
    printf 'export const p = 1;\n' > packages/plain/src/keep.ts
    mkdir -p docs && printf 'docs\n' > docs/speed.md
    git add -A && git commit -qm fixture
  )
}

# run_gate [env assignments...] -- args...
run_gate() {
  ( cd "$FIX" && timeout -k 5 60 bash "$GATE" "$@" ) >"$OUT" 2>"$ERR"
  RC=$?
}
# reset the fixture's working tree between scenarios
reset_tree() { ( cd "$FIX" && git checkout -q -- . && git clean -qfd ); }

check() { # <description> <shell test...>
  checks=$((checks + 1))
  if eval "$2"; then
    echo "ok   - $1"
  else
    echo "FAIL - $1" >&2
    echo "--- stdout" >&2; sed 's/^/    /' "$OUT" >&2
    echo "--- stderr" >&2; sed 's/^/    /' "$ERR" >&2
    echo "--- rc=$RC" >&2
    fails=$((fails + 1))
  fi
}
out_has() { grep -qF "$1" "$OUT"; }
err_has() { grep -qF "$1" "$ERR"; }
out_lacks() { ! grep -qF "$1" "$OUT"; }

mkfixture

# 1. A source file in a directory that is no workspace: FAIL, named on stderr.
mkdir -p "$FIX/packages/ghost/src" && printf 'export const y = 2;\n' > "$FIX/packages/ghost/src/probe.ts"
run_gate
check "source outside any declared workspace FAILs by name" 'test "$RC" -ne 0 && err_has "not inside any workspace" && err_has "packages/ghost/src/probe.ts"'
reset_tree

# 2. A source file in a real workspace that has no test script: FAIL, named on stderr.
printf 'export const y = 2;\n' > "$FIX/packages/plain/src/probe.ts"
run_gate
check "source in a workspace with no test script FAILs by name" 'test "$RC" -ne 0 && err_has "workspace packages/plain has no test script"'
reset_tree

# 3. A test-only delta runs that workspace's whole suite (a deleted/renamed test is
#    never selected by --changed) — bead cloud-factory-cf-8f1.
printf '// edit\n' >> "$FIX/packages/nodep/tests/n.test.ts"
run_gate
check "test-only delta runs the owning workspace suite" 'test "$RC" -eq 0 && out_has "whole suite (test-file delta" && out_has "FAKE npm test in nodep"'
reset_tree

# 3b. A MODIFIED test file in a vitest workspace runs only the affected suites: naming
#     every suite in the workspace because one test file was edited is what put
#     apps/worker's 35-file suite past the fast tier's bound and got unrelated landings
#     KILLED at it (cloud-factory-cf-67sy).
printf '\n// touch\n' >> "$FIX/apps/web/test/a.test.ts"
export FAKE_SELECT="apps/web/test/a.test.ts"
run_gate
check "a modified test file runs the affected suites, not the whole suite" 'test "$RC" -eq 0 && out_has "1 affected test file(s) (test-file delta" && out_has "FAKE vitest run in web"'
run_gate --list
check "--list reports affected suites for a modified test file" 'test "$RC" -eq 0 && out_has "1 affected test file(s) (test-file delta"'
unset FAKE_SELECT
reset_tree

# 3c. ... while a DELETED test file keeps the workspace-wide run, because --changed cannot
#     select a path that no longer exists (cloud-factory-cf-8f1).
rm "$FIX/apps/worker/test/assets.test.ts"
run_gate
check "a deleted test keeps the workspace-wide run" 'test "$RC" -eq 0 && out_has "whole suite (test-file delta" && out_has "FAKE vitest run in worker"'
reset_tree

# 4. THE BUG THIS SELF-TEST EXISTS FOR (bead cloud-factory-cf-9uu): a test change in one
#    workspace must not be skipped because another workspace's SOURCE changed, and its
#    failure must propagate to the gate's exit code.
printf '// now failing\n' >> "$FIX/packages/nodep/tests/n.test.ts"
printf '\n// touch\n' >> "$FIX/apps/web/src/m.ts"
export FAKE_SELECT="apps/web/test/a.test.ts" FAKE_NPM_RC=1
run_gate
unset FAKE_SELECT FAKE_NPM_RC
check "test change is not skipped by another workspace's source change" 'test "$RC" -ne 0 && out_has "FAKE vitest run in web" && out_has "FAKE npm test in nodep"'
reset_tree

# 4b. THE 9ef FINDING: a test edit in the same workspace must not vouch for an
#     unreferenced source edit. m.ts is imported by a.test.ts (covered); probe.ts is
#     referenced by nothing, so the same delta has to stay red.
printf '\n// touch\n' >> "$FIX/apps/web/test/a.test.ts"
printf 'export const probe = 1;\n' > "$FIX/apps/web/src/probe.ts"
export FAKE_SELECT="apps/web/test/a.test.ts"
run_gate
unset FAKE_SELECT
check "a same-workspace test edit cannot mask an unreferenced source" 'test "$RC" -ne 0 && err_has "nothing in this workspace references" && err_has "apps/web/src/probe.ts"'
run_gate --list
check "--list reports the same failure for that delta (no rc split)" 'test "$RC" -ne 0 && err_has "apps/web/src/probe.ts"'
reset_tree

# 4c. ... while a source that its tests do import stays green in the same shape.
printf '\n// touch\n' >> "$FIX/apps/web/test/a.test.ts"
printf '\n// touch\n' >> "$FIX/apps/web/src/m.ts"
export FAKE_SELECT="apps/web/test/a.test.ts"
run_gate
unset FAKE_SELECT
check "a referenced source plus a test edit in the same workspace stays green" 'test "$RC" -eq 0 && out_lacks "references these changed source files"'
reset_tree

# 4d. rev-gate6: the same rule holds for a node:test workspace, not just vitest ones.
printf '\n// touch\n' >> "$FIX/packages/nodep/tests/n.test.ts"
printf 'export const orphan = 1;\n' > "$FIX/packages/nodep/src/orphan.ts"
run_gate
check "a node:test workspace cannot mask an unreferenced source either" 'test "$RC" -ne 0 && err_has "packages/nodep/src/orphan.ts" && err_has "nothing in this workspace references"'
reset_tree

# 4e. ... and a source its tests do import stays green there too.
printf '\n// touch\n' >> "$FIX/packages/nodep/tests/n.test.ts"
printf '\n// touch\n' >> "$FIX/packages/nodep/src/n.ts"
run_gate
check "a referenced source plus a test edit in a node:test workspace stays green" 'test "$RC" -eq 0 && out_has "FAKE npm test in nodep"'
reset_tree

# 4f. The same rule must not fire on things that cannot be imported: a stylesheet has no
#     module graph, so a CSS delta beside a test edit is covered by the suite it runs
#     (found by the 2ng fast gate with apps/web/src/styles.css).
printf '\n/* touch */\n' >> "$FIX/apps/web/styles.css"
printf '\n// touch\n' >> "$FIX/apps/web/test/a.test.ts"
export FAKE_SELECT="apps/web/test/a.test.ts"
run_gate
unset FAKE_SELECT
check "an asset delta is covered by the suite instead of failing the reference rule" 'test "$RC" -eq 0 && out_has "FAKE vitest run in web" && out_lacks "references these changed source files"'
reset_tree

# 4g. A barrel (src/dir/index.ts) is imported by its directory, so the reference rule
#     has to resolve the directory form too — apps/worker/src/events/index.ts failed it.
mkdir -p "$FIX/apps/web/src/dir"
printf 'export const inner = 1;\n' > "$FIX/apps/web/src/dir/index.ts"
printf 'import { inner } from "../src/dir";\n// touch\n' >> "$FIX/apps/web/test/a.test.ts"
export FAKE_SELECT="apps/web/test/a.test.ts"
run_gate
unset FAKE_SELECT
check "a barrel file counts as referenced through its directory import" 'test "$RC" -eq 0 && out_lacks "references these changed source files"'
reset_tree

# 5. A source delta selects the affected vitest files.
printf '\n// touch\n' >> "$FIX/apps/web/src/m.ts"
export FAKE_SELECT="apps/web/test/a.test.ts"
run_gate
unset FAKE_SELECT
check "source delta runs the affected vitest files" 'test "$RC" -eq 0 && out_has "1 affected test file(s)" && out_has "FAKE vitest run in web"'
reset_tree

# 6. A source delta that selects no suite is a FAIL, never a silent green.
printf '\n// touch\n' >> "$FIX/apps/web/src/m.ts"
run_gate
check "source delta that selects no suite FAILs" 'test "$RC" -ne 0 && err_has "match no suite in this workspace"'
reset_tree

# 6b. Edge-routed modules are not imported directly by tests; a changed test can
#     otherwise hide their unmapped state behind the workspace's selected suites.
for route in auth/tenant routes/auth routes/git-tree; do
  mkdir -p "$FIX/apps/worker/src/${route%/*}"
  printf 'export const routed = 1;\n' > "$FIX/apps/worker/src/$route.ts"
  export FAKE_SELECT="apps/worker/test/assets.test.ts"
  run_gate
  check "edge-routed $route selects its pinned integration suite" 'test "$RC" -eq 0 && out_has "pinned suite apps/worker/test/"'
  run_gate --list
  check "--list includes the pinned suite for $route" 'test "$RC" -eq 0 && out_has "pinned suite apps/worker/test/"'
  unset FAKE_SELECT
  reset_tree
done
mkdir -p "$FIX/apps/worker/src/routes"
printf 'export const routed = 1;\n' > "$FIX/apps/worker/src/routes/auth.ts"
rm "$FIX/apps/worker/test/auth.test.ts"
run_gate
check "a removed contracted suite FAILs rather than silently passing" 'test "$RC" -ne 0 && err_has "contracted suite apps/worker/test/auth.test.ts is missing"'
reset_tree

# 7. DECLARED_UNVERIFIED source still runs the workspace suite for evidence.
printf '\n// touch\n' >> "$FIX/apps/web/src/main.ts"
run_gate
check "declared-unverified source runs the whole suite" 'test "$RC" -eq 0 && out_has "declared-unverified source" && out_has "FAKE vitest run in web"'
reset_tree

# 7b. A stylesheet is source with no node suite at all: declared unverified, so the
#     workspace suite runs for evidence rather than a false red (cloud-factory-cf-9jb).
printf '\n/* touch */\n' >> "$FIX/apps/web/src/styles.css"
run_gate
check "declared-unverified stylesheet runs the workspace suite" 'test "$RC" -eq 0 && out_has "declared-unverified source" && out_has "FAKE vitest run in web"'
reset_tree

# 8. Nothing source/test changed: the smoke set runs, never an empty green.
printf 'more docs\n' >> "$FIX/docs/speed.md"
run_gate
check "docs-only delta runs the smoke set" 'test "$RC" -eq 0 && out_has "FAKE vitest run in web" && out_has "FAKE vitest run in worker"'
reset_tree

# 9. A test file no workspace runs is named, and the smoke set still runs (never a red).
mkdir -p "$FIX/apps/ghost/test" && printf 'export {};\n' > "$FIX/apps/ghost/test/ghost.test.ts"
run_gate
check "unowned test file is named and does not hard-FAIL" 'test "$RC" -eq 0 && out_has "not part of the gate" && out_has "ghost.test.ts" && out_has "FAKE vitest run in web"'
reset_tree

# 9b. Deleting every test file of a workspace is a named no-op, never a red: vitest
#     exits 1 on 'No test files found', which is a mapping artifact, not a broken change
#     (bead cloud-factory-cf-u8k).
rm -rf "$FIX/apps/web/test"
run_gate
check "deleting a workspace's only tests is a named no-op, not a red" 'test "$RC" -eq 0 && out_has "apps/web: no test files remain" && out_has "skipped in the smoke set"'
check "the smoke fallback names the removed tests, not 'outside every runnable workspace'" 'out_has "test files removed from apps/web" && out_lacks "outside every runnable workspace"'
run_gate --list
check "--list names the deleted tests instead of claiming a whole-suite run" 'test "$RC" -eq 0 && out_has "no test files remain" && out_lacks "whole suite (test-file delta)"'
reset_tree

# 9c. r0r: a workspace on vitest's other default convention (*.spec.*) is classified
#     and no-op-protected like any other test file.
printf '\n// edit\n' >> "$FIX/packages/specp/tests/x.spec.ts"
run_gate
check "a *.spec.* delta is a test-file delta" 'test "$RC" -eq 0 && out_has "packages/specp: whole suite (test-file delta" && out_has "FAKE npm test in specp"'
reset_tree
rm "$FIX/packages/specp/tests/x.spec.ts"
run_gate
check "deleting a *.spec.* workspace's only tests is a named no-op" 'test "$RC" -eq 0 && out_has "packages/specp: no test files remain"'
reset_tree

# 9d. Deleting a workspace's last test must not vouch for a source change beside it:
#     with no test files left that source runs no suite at all (u8k review follow-up).
rm -rf "$FIX/apps/web/test"
printf 'export const orphan = 1;\n' > "$FIX/apps/web/src/orphan.ts"
run_gate
check "a deleted last test cannot hide an uncovered source beside it" 'test "$RC" -ne 0 && err_has "apps/web has no test files left" && err_has "apps/web/src/orphan.ts"'
run_gate --list
check "--list agrees with run mode when tests are deleted under a source change" 'test "$RC" -ne 0 && err_has "apps/web has no test files left"'
reset_tree

# 9e. ... and the same delta with no source change stays the named no-op.
rm -rf "$FIX/apps/web/test"
run_gate
check "deleting tests alone is still a no-op, not a red" 'test "$RC" -eq 0 && out_has "apps/web: no test files remain"'
reset_tree

# 10. --list on an affected-source delta reports the selection and stays green (it runs
#     nothing, so "ran nothing" must not be read as "nothing covers this").
printf '\n// touch\n' >> "$FIX/apps/web/src/m.ts"
export FAKE_SELECT="apps/web/test/a.test.ts"
run_gate --list
unset FAKE_SELECT
check "--list on an affected delta reports the selection and exits 0" 'test "$RC" -eq 0 && out_has "1 affected test file(s)" && out_has "apps/web/test/a.test.ts" && out_lacks "FAKE"'
reset_tree

# 11. --list never runs anything, but still reports a FAIL verdict.
printf 'export const y = 2;\n' > "$FIX/packages/plain/src/probe.ts"
run_gate --list
check "--list reports the FAIL verdict without running suites" 'test "$RC" -ne 0 && err_has "no test script" && out_lacks "FAKE"'
reset_tree

# 12-12c. The dist preconditions (cloud-factory-cf-i9mx, reviewer note cloud-factory-cf-
#     nbeb): a workspace whose suite imports a missing dist must have it built BEFORE the
#     suite runs, an existing dist must not be rebuilt, and a failed build must FAIL the
#     gate instead of letting the suite speak for a tree it cannot load.
#     apps/worker is the workspace with the whole chain: canvas-model, sdk, then the web
#     bundle its ASSETS binding points at.
export FAKE_BUILD_LOG="$TMP/build.log"
rm -rf "$FIX/packages/canvas-model/dist" "$FIX/packages/sdk/dist" "$FIX/apps/web/dist"
: > "$FAKE_BUILD_LOG"
printf '\n// touch\n' >> "$FIX/apps/worker/test/worker.test.ts"
run_gate
check "a missing dist is built before the suite that imports it" 'test "$RC" -eq 0 && out_has "building @factory-cloud/canvas-model" && out_has "FAKE vitest run in worker"'
check "the chain builds in dependency order, all before the suite" 'b1=$(grep -n "^build @factory-cloud/canvas-model\$" "$FAKE_BUILD_LOG" | cut -d: -f1); b2=$(grep -n "^build @factory-cloud/sdk\$" "$FAKE_BUILD_LOG" | cut -d: -f1); b3=$(grep -n "^build @factory-cloud/web\$" "$FAKE_BUILD_LOG" | cut -d: -f1); r=$(grep -n "^run worker\$" "$FAKE_BUILD_LOG" | cut -d: -f1); test -n "$b1" && test -n "$b2" && test -n "$b3" && test -n "$r" && test "$b1" -lt "$b2" && test "$b2" -lt "$b3" && test "$b3" -lt "$r"'
check "the built dists are in place for the suite" 'test -f "$FIX/packages/canvas-model/dist/index.js" && test -f "$FIX/packages/sdk/dist/index.js" && test -f "$FIX/apps/web/dist/index.html"'
reset_tree

for d in packages/canvas-model/dist packages/sdk/dist apps/web/dist; do mkdir -p "$FIX/$d"; done
printf 'built\n' > "$FIX/packages/canvas-model/dist/index.js"
printf 'built\n' > "$FIX/packages/sdk/dist/index.js"
printf 'built\n' > "$FIX/apps/web/dist/index.html"
: > "$FAKE_BUILD_LOG"
printf '\n// touch\n' >> "$FIX/apps/worker/test/worker.test.ts"
run_gate
check "an existing dist is not rebuilt (a warm worktree pays nothing)" 'test "$RC" -eq 0 && out_lacks "building @factory-cloud/" && ! grep -q "^build " "$FAKE_BUILD_LOG" && out_has "FAKE vitest run in worker"'
reset_tree

: > "$FAKE_BUILD_LOG"
printf '\n// touch\n' >> "$FIX/apps/worker/test/worker.test.ts"
export FAKE_BUILD_RC=1
run_gate
unset FAKE_BUILD_RC
check "a failed dist build FAILs the gate and names the build" 'test "$RC" -ne 0 && err_has "did not build"'
check "the suite never runs against a missing dist" 'out_lacks "FAKE vitest run in worker"'
unset FAKE_BUILD_LOG
reset_tree

echo "selftest: ${checks} checks, ${fails} failure(s)"
[ "$fails" -eq 0 ] || exit 1
exit 0
