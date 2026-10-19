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
  run) echo "FAKE vitest run in $(basename "$PWD")"; exit "${FAKE_VITEST_RC:-0}" ;;
  *) exit 0 ;;
esac
SH
    cat > node_modules/.bin/npm <<'SH'
#!/usr/bin/env bash
echo "FAKE npm test in $(basename "$PWD")"; exit "${FAKE_NPM_RC:-0}"
SH
    chmod +x node_modules/.bin/vitest node_modules/.bin/npm
    # apps/* : vitest workspaces. packages/* : node:test, plus a workspace with no
    # test script at all (the unmapped-source case).
    for ws in apps/web apps/worker; do
      mkdir -p "$ws/test" "$ws/src"
      printf '{ "name": "%s", "scripts": { "test": "vitest run" } }\n' "$ws" > "$ws/package.json"
      printf 'export const a = 1;\n' > "$ws/src/m.ts"
      printf 'export const entry = 1;\n' > "$ws/src/main.ts"
      printf 'import { a } from "../src/m";\nimport { test } from "vitest";\ntest("x", () => { void a; });\n' > "$ws/test/a.test.ts"
    done
    # the smoke set names these two worker files explicitly
    for f in worker assets; do
      printf 'export {};\n' > "apps/worker/test/$f.test.ts"
    done
    mkdir -p packages/nodep/tests packages/nodep/src packages/plain/src
    printf '{ "name": "nodep", "scripts": { "test": "node --test tests/**/*.test.ts" } }\n' > packages/nodep/package.json
    printf 'export const n = 1;\n' > packages/nodep/src/n.ts
    printf 'import { test } from "node:test";\ntest("n", () => {});\n' > packages/nodep/tests/n.test.ts
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
reset_tree

# 4c. ... while a source that its tests do import stays green in the same shape.
printf '\n// touch\n' >> "$FIX/apps/web/test/a.test.ts"
printf '\n// touch\n' >> "$FIX/apps/web/src/m.ts"
export FAKE_SELECT="apps/web/test/a.test.ts"
run_gate
unset FAKE_SELECT
check "a referenced source plus a test edit in the same workspace stays green" 'test "$RC" -eq 0 && out_lacks "references these changed source files"'
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

# 7. DECLARED_UNVERIFIED source still runs the workspace suite for evidence.
printf '\n// touch\n' >> "$FIX/apps/web/src/main.ts"
run_gate
check "declared-unverified source runs the whole suite" 'test "$RC" -eq 0 && out_has "declared-unverified source" && out_has "FAKE vitest run in web"'
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

echo "selftest: ${checks} checks, ${fails} failure(s)"
[ "$fails" -eq 0 ] || exit 1
exit 0
