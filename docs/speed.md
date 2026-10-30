# Speed: gate budget for cloud-factory-cf

Landing speed is the fleet's throughput, so this repo states what a gate costs
and what each tier is expected to run. Times measured on the fleet VM (2026-10-18 baseline, updated 2026-10-22 for
workerd serialization; node 24, vitest 4.1.12, wrangler 4.151.1), warm `node_modules`
served by `fleet-deps`.

## Commands and what they cost

| Command | What it does | Measured |
| --- | --- | --- |
| `npm run build` | `vite build` for `apps/web`, then `wrangler deploy --dry-run` — bundles the Worker, validates `wrangler.jsonc`, DO bindings, migrations and the `ASSETS` directory | 2.0–2.3s |
| `npm run typecheck` | `tsc --noEmit` per workspace (sdk, cli, worker, web) | 4.0–4.4s |
| `npm test` | `vitest run` inside workerd (`@cloudflare/vitest-plugin`, serialized via `fileParallelism: false`), `node:test` for packages (`canvas-model`, `sdk`, `cli`), and Vitest for `apps/web` | ~185–400s full suite under VM load (78s for 6 files); deterministic pass |
| `npm run ci` | build + typecheck + test | ~190–410s loaded VM (build ~2s + typecheck ~4s + test); test step dominates |
| `npm run test:file -- test/<file>.test.ts` | one workerd test file | 2–3s |
| `npm run test -w @factory-cloud/canvas-model` | `node:test` model tests (`packages/canvas-model`) | 0.2s |
| `npm run test -w @factory-cloud/web` | one node-mode test file set (canvas model) | 0.9s |
| `npm run test:changed` | dev-loop only, **not the gate** — see "Fast tier" | affected suites; fails when a source change maps to none |

`apps/web` is in those numbers: its unit tests run in plain Node (≈0.2s) and its
build is a 0.1s `vite build`. The root `build` chain builds the canvas bundle
exactly once before `apps/worker`, so `ASSETS` points at a directory that exists
without any `prebuild`/`pretest` hook (see "Build each workspace once"). Measured 2026-10-19: the assets binding
itself adds no measurable test time (15.12s with `assets` vs 14.98s without, same
loaded machine — the earlier 7.4s figure was a quiet VM).

Per file (inside the workerd suite): `test/computer-dependency.test.ts` ≈ 1.0s
(it imports the 11 MB `@cloudflare/computer` bundle, which is the point of the
test), `test/queue.test.ts` ≈ 0.6s, `test/ingest.test.ts` ≈ 0.2s,
`test/worker.test.ts` ≈ 0.2s, `test/repo-coordinator.test.ts` ≈ 0.1s. The rest
is vitest + workerd pool startup.

## Tiers

- **Iterating (everyone):** run the tests for what you changed —
  `npm run test:file -- test/<file>.test.ts` — in the foreground with a
  `timeout`. Do not run the full suite per edit.
- **Implementers:** `fleet-check --fast` on the committed tree — `npm run build &&
  npm run typecheck && bash scripts/changed-tests.sh` (see "Fast tier" below).
- **Mergers:** `fleet-check` once on the merged union, not per branch.
- Never re-gate an unchanged tree: verdicts are cached per commit tree.

### Fast tier for this repo

`~/.fleet/check.conf` (installed 2026-10-19, bead `cloud-factory-cf-cn8`):

```conf
CHECK_FAST_CMD="npm run build && npm run typecheck && bash scripts/changed-tests.sh"
```

The fast tier must be a **strict subset** of the full gate and must never report a
pass for a change nothing covered. `scripts/changed-tests.sh` is written to that
contract:

- the delta is `origin/main...HEAD` **plus** working-tree changes, so a committed
  branch is not invisible (the failure mode of `vitest run --changed` with no ref,
  findings `cloud-factory-cf-gy5`/`l0q`);
- a changed **source** file (`apps/*/src`, `packages/*/src`) that selects **no**
  suite is a **failure named on stderr**, not a silent pass (files tested outside
  Node like `apps/web/src/main.ts`—which is driven in Chrome via CDP—are explicitly
  listed in `DECLARED_UNVERIFIED` referencing `cloud-factory-cf-5e8`/`d8s`, and trigger
  the workspace smoke suite instead of failing);
- a delta that contains **test files** runs the suites that delta affects — the
  changed test files plus the suites of the changed sources beside them — and falls
  back to the owning workspace's whole suite only when `vitest --changed` cannot
  select the delta (a **deleted or renamed** test is never selected, so asking for
  the delta would run nothing: bead `cloud-factory-cf-8f1`); test files no workspace
  runs are named as "not part of the gate"; it never hard-FAILs on a test-only
  delta — that red means the *mapping* is wrong, not the change. Naming every suite
  in the workspace because one test file was edited put `apps/worker`'s 35-file
  suite past the fast tier's bound and got unrelated landings killed at it, so only
  the deleted/renamed case pays for a workspace-wide run now (bead
  `cloud-factory-cf-67sy`);
- a test-file delta that removes **every** test file of a workspace is named as a no-op
  ("no test files remain") instead of running a suite that can only answer
  `No test files found` — vitest exits 1 for that, which would be a red for a mapping
  reason, not a broken change (bead `cloud-factory-cf-u8k`). The no-op is reported by
  `--list` too, the smoke set skips that workspace and names the removal, and still runs
  the others; a genuinely failing test stays red. Test files are recognised by vitest's
  own defaults, `*.test.*` and `*.spec.*` (bead `cloud-factory-cf-a5s`, `r0r`). A
  deleted last test does **not** vouch for a source change beside it: with no test files
  left in the workspace that source is named as a failure, not skipped. Source
  validation runs before the selection report, so `--list` gives the same verdict as a
  real run (bead `cloud-factory-cf-ryb`);
- a test-file delta does **not** vouch for a source change in the same workspace, for
  **every** runner: if the workspace's tests and sources reference that module nowhere,
  the source still fails by name, because a whole-suite run cannot invent a test for it
  (bead `cloud-factory-cf-9ef`; the vitest-only version of this check was itself a
  finding, rev-gate6);
- a delta with no source changes runs a fixed **smoke set** (`apps/web`'s node
  suite, `apps/worker`'s `worker`/`assets` tests) instead of nothing: a gate that
  executes no suite at all cannot be distinguished from one whose selection broke,
  which is exactly how the fleet gate reports `coverage UNKNOWN`;
- workspaces are **discovered from the root `package.json`** `workspaces` globs and
  each workspace's runner is read from its own `test` script (`vitest` → affected
  files only, `node --test`/any other script → whole suite). Nothing in the gate
  lists workspace names, so a new workspace is covered the day it lands: a source
  change in a directory that is no workspace, or in a workspace with no `test`
  script, is a **FAILURE named on stderr** (bead `cloud-factory-cf-9uu`);
- tests and sources are decided **per workspace**: a test-file change in one
  workspace still runs that workspace's suite when another workspace's source also
  changed (the old gate only consulted test files when *no* source changed, so a
  failing test delta rode in green behind an unrelated source edit);
- for `vitest` workspaces it asks `vitest list --changed --filesOnly` what is
  affected; `node:test` workspaces are seconds, so a change there runs their whole
  suite;
- a source delta that runs nothing exits non-zero rather than reporting green;
- the gate's own logic has no workspace suite, so `scripts/changed-tests.selftest.sh`
  (fake runners in a throwaway repo — no deps, ~5s) runs whenever the gate changes.

Measured on an ordinary source-only delta it selects a handful of files instead of
19; for a manifest change vitest conservatively selects the whole workspace, which
is the honest answer rather than a guess. The merger's full gate remains the oracle
for the merged union. Discovered workspaces also mean the gate no longer pays for a
`vitest list` query in a workspace the delta never touched.

### Build each workspace once

`npm run ci` used to build `apps/web` **three times**: twice inside `npm run build`
(root `--workspaces` sweep plus `apps/worker`'s `prebuild`) and once more from
`apps/worker`'s `pretest`. The hooks are gone and the root build is an explicit
chain:

```
canvas-model → sdk → cli → web → worker
```

Every workspace that ships a `dist/` is on that chain, because `--workspaces` is no
longer the sweep: a package missing from it silently has no `dist/` after a clean
build (the `cloud-factory-cf-cn8` review caught `@factory-cloud/cli`).

Measured (`npm run build`, same VM, alternating runs): **8.3–9.0s → 5.2–7.7s**, one
vite build instead of three. A consequence worth knowing: `npm test` on its own no
longer builds the canvas bundle, so **`npm run ci` (or `fleet-check`) is the entry
point from a clean tree**; that was already the rule for `packages/sdk/dist`.

The fast gate is an entry point too (`cloud-factory-cf-i9mx`). `scripts/changed-tests.sh`
builds the `dist` its suite imports, and only what is missing: `canvas-model` for
`apps/web`; `canvas-model`, `sdk` and the `apps/web` bundle for `apps/worker`, whose
vitest config binds `ASSETS` to it. A warm worktree pays one `[ -d ]`; a fresh one pays
**3.6s** once (measured 2026-10-20: three `-w` builds from no `dist`). A build failure
is a gate FAILURE carrying its log, because a suite run against a missing artifact says
nothing about the delta — a fresh implementer worktree went red on
`test/assets.test.ts` (404 from the asset layer) for exactly that reason, and the same
tree went green once `apps/web/dist` existed.

## Budgets

- Fast tier target: **≤ 60s** for focused source deltas (~65–250s under VM load when running the smoke set on docs/config deltas). Escalate before it crosses that on an ordinary change.
- Full gate target: **≤ 120s** (historical baseline; under serialized workerd suites on a loaded VM, the full gate ranges ~185–400s). A change that pushes past current ranges must say so with a measurement in its `LAND-SUMMARY`.
- Adding a test that costs ~1s (like the `@cloudflare/computer` resolution
  guard) is fine when it protects a real contract; say so in the summary.

## Order matters from a clean tree: `npm run ci`, not `npm test`

`dist/` is gitignored, and `@factory-cloud/cli` resolves `@factory-cloud/sdk`
through `packages/sdk/dist`. So in a **clean** checkout — a new worktree, a fresh
clone, or right after a `dist` cleanup — `npm test` on its own fails before it
runs anything:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../node_modules/@factory-cloud/sdk/dist/index.js'
  imported from .../packages/cli/src/runner/local-runner.ts
```

That is not a broken test: the root `build` script deliberately builds the SDK
first (`npm run build -w @factory-cloud/sdk && npm run build --workspaces`), and
`ci` is `build && typecheck && test`, so **`npm run ci` is the command that works
from clean** (verified 2026-10-19: `npm test` fails in ~1s from a cleaned tree,
`npm run ci` from the same tree passes). Rules for adding a workspace package:

- build it **before** everything that imports it: put it on the explicit
  `-w <package>` chain in the root `build` script, not only inside the
  `--workspaces` sweep (that sweep follows `workspaces` order, not the
  dependency graph);
- add it to `workspaces` in dependency position so `typecheck`/`test` see the
  same order;
- a workspace whose output another workspace *bundles* (as `apps/worker` embeds
  `apps/web/dist`) belongs on that chain too — do not reach for
  `prebuild`/`pretest` hooks: they rebuild it once per workspace command, which is
  how `apps/web` came to be built three times (bead `cloud-factory-cf-cn8`).

## Test independence (why the suite stays cheap and green)

These are the pathologies that turn one lane's change red for everyone else:

- **Shared machine state.** Each test file owns separate repositories: the
  Durable Object identity is `acme/<slug>` with one slug per file (`claim`,
  `ack`, `retry`, `lease`, `persist`, ...). Never reuse another file's slug and
  never assert on a queue you did not create.
- **Wall-clock sleeps.** Lease expiry and retry backoff are tested by ageing
  the row (`runInDurableObject` → `UPDATE events SET available_at = ...`) and
  firing the real alarm with `runDurableObjectAlarm`, never by `sleep`ing.
- **Order dependence.** No test depends on another test's insert order; claims
  are asserted as sets or by `delivery_id`, and SQL that feeds assertions orders
  by `received_at, delivery_id`.
- **Machine assertions.** Nothing reads the VM's files, env or network; all
  bindings come from `vitest.config.ts` (`WEBHOOK_SECRET`,
  `GITLAB_WEBHOOK_TOKEN` are fixed test values).
- **Serialize workerd test files (`fileParallelism: false`).** Without serialization,
  Vitest dispatches test files concurrently across multiple runner workers. While this
  overlaps initial import/transform time, parallel execution causes SQLite DO migration
  concurrency races (e.g. `no such table: run_trace: SQLITE_ERROR`), cross-test fetch
  mock collisions, and severe CPU starvation under VM load. In `apps/worker/vitest.config.ts`,
  `fileParallelism: false` runs workerd test files sequentially. While serialization
  adds ~+31% wall-clock to partial runs (measured in A/B: 59.97s parallel vs 78.41s
  serialized across 6 worker files), it eliminates race flakes and drops full gate
  runtime under load from >2000s (with recurring migration errors) to ~185s with 100%
  deterministic passes (257/257 tests).
- **Do not launch ad-hoc runtimes.** Tests must execute inside the configured Vitest
  workerd pool; do not start secondary `wrangler dev` processes or headless browsers
  inside unit tests.

## Adding coverage without slowing the gate

- Pure logic (`src/webhooks.ts`: signature verification, normalisation) needs no
  Durable Object and no storage — those tests are the cheapest and should carry
  most of the table-driven cases.
- Integration paths (ingest → queue → claim/ack/fail) get one test each, in the
  file that owns the behaviour.
- If the suite ever needs both a Node-only project and the workerd project, use
  vitest projects and keep the Node project first: it is the part that can run
  without the pool.

## Worker suite cost against the fast-tier bound (measured 2026-10-30)

The fast tier (`.fleet` gate, 900s bound) cannot currently gate a delta that touches a
widely imported worker module, and this is measurable rather than mysterious. Each worker
test file boots its own workerd, so a delta's cost is the SUM of the selected files:

| suite | tests | wall clock at 60s timeout |
|---|---|---|
| `test/audit.test.ts` | 14 | ~70s |
| `test/pipeline.test.ts` | 23 | ~60s |
| `test/auth.test.ts` | 21 | ~68s |
| `test/tenant-authz.test.ts` | 13 | ~60s |
| `test/worker.test.ts` | 7 | ~74s |
| `test/connect.test.ts` | 7 | ~331s |

A change to `apps/worker/src/routes/auth.ts`, `src/auth/tenant.ts` or
`src/credential-broker-object.ts` selects 7–9 of those files, i.e. ~700–1100s of work
against a 900s budget. Four deltas died that way on 2026-10-30 (`999a5bd` 902–907s,
`be64ee2` 907s, `htc0` 901s, `yvlp` 907s), every one of them mid-run with nothing failing
in the log. That is not a signal about the change; it is the tier being too small for the
selection.

Two ways out, in order of cost:

1. **Raise the bound for worker-touching deltas** (~1500s) while keeping 900s for web/SDK
   deltas. Cheap, no code change, and the merger's full gate already runs for minutes.
2. **Let worker deltas skip the fast tier** and go straight to the merger's full gate,
   accepting that an implementer then hands off on local evidence plus review.

What does NOT work is retrying the same delta at 900s: the cost is deterministic, and each
retry spends a heavy slot that the merger needs.

### Serial versus bounded parallel (supersedes the `fileParallelism: false` note above)

`fileParallelism: false` was chosen for determinism, but on a saturated 2 vCPU VM it turns
"slow" into "never": two small worker files took 292s in parallel versus a run killed at
351s serial. Unbounded parallel then stampeded the pool - each file starts a workerd, and
runs reported `Timeout starting cloudflare-pool runner` with `Test Files no tests`
(transform 0ms). The setting that gates is **bounded** parallel: `maxWorkers: 2` together
with a 60s `testTimeout`, which passed the fast tier in 491s on a tree that included the
web smoke set (`cloud-factory-cf-t8mu`, `cloud-factory-cf-j998`). Keep the bound low; the
point is to overlap Durable Object waits, not to start one runner per file.

A 20s `testTimeout` is what makes a busy VM look like a broken branch: `connect.test.ts` is
4/7 red at 20s (per-test 21–25s) and 7/7 at 60s with no source change.

### The 90-second runner start is hard-coded (measured 2026-10-30)

A run can also fail with `Error: [vitest-pool]: Timeout starting cloudflare-pool runner.`
and `Test Files  no tests` / `Tests  no tests` with `transform 0ms, import 0ms`. That is not
a test failure and not a pool stampede: vitest 4.1.12 hard-codes the runner start budget in
`node_modules/vitest/dist/chunks/cli-api.*.js` as `const WORKER_START_TIMEOUT = 9e4`, i.e.
**90 seconds**, and there is no `startupTimeout` / `poolOptions` knob in this version to
raise it. On a loaded 2 vCPU VM, booting workerd for the first file can exceed that and the
whole run is discarded before a single test executes.

What this means in practice:

- Treat `no tests` + `transform 0ms` as **no verdict**, never as a red branch. Delete the
  cached `.fast.json` and re-run instead of "fixing" code that was never exercised. Five
  runs and three gate slots were lost to this on 2026-10-30 before the cause was found.
- It correlates with load, not with the delta: the same file passes in ~240s at load 9 and
  fails to start at load 7.4 minutes later.
- Nothing in this repository can raise the limit. The levers are the size of the selection
  (fewer files to boot) and the machine's load, which is why the bounded-parallel setting
  above keeps `maxWorkers` low: each worker is another workerd boot that has to fit in the
  same 90 seconds.
