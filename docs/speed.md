# Speed: gate budget for cloud-factory-cf

Landing speed is the fleet's throughput, so this repo states what a gate costs
and what each tier is expected to run. Times measured on the fleet VM
(2026-10-18, node 24, vitest 4.1.12, wrangler 4.151.1), warm `node_modules`
served by `fleet-deps`.

## Commands and what they cost

| Command | What it does | Measured |
| --- | --- | --- |
| `npm run build` | `vite build` for `apps/web`, then `wrangler deploy --dry-run` — bundles the Worker, validates `wrangler.jsonc`, DO bindings, migrations and the `ASSETS` directory | 2.0–2.3s |
| `npm run typecheck` | `tsc --noEmit` per workspace (sdk, cli, worker, web) | 4.0–4.4s |
| `npm test` | `vitest run` inside workerd (`@cloudflare/vitest-plugin`) + node-mode model tests for `apps/web` | 7.5–9s |
| `npm run ci` | build + typecheck + test | 14–17s idle VM; 45s+ when the VM is loaded |
| `npm run test:file -- test/<file>.test.ts` | one workerd test file | 2–3s |
| `npm run test -w @factory-cloud/web` | one node-mode test file set (canvas model) | 0.9s |
| `vitest run --changed` | dev-loop only, **not a gate** — see below | selects 0 tests in a committed worktree |

`apps/web` is in those numbers: its unit tests run in plain Node (≈0.2s) and its
build is a 0.1s `vite build`. `apps/worker` builds the canvas before its own
dry-run deploy and before its tests (`prebuild`/`pretest`), which is what keeps
`ASSETS` pointing at a directory that exists; the cost is that `vite build` runs
twice per `npm run ci` (≈0.2s total). Measured 2026-10-19: the assets binding
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
- **Implementers:** `fleet-check --fast` on the committed tree (this repo's fast
  tier, once installed, is `npm run ci` — it runs everything).
- **Mergers:** `fleet-check` once on the merged union, not per branch.
- Never re-gate an unchanged tree: verdicts are cached per commit tree.

### Fast tier for this repo

This repo currently has **no fast tier configured**, so `fleet-check --fast`
exits 2 for every lane and each implementer either runs focused tests by hand or
pays the full gate. The gate is small enough that a second command set buys
little, so the proposal is the same command for both tiers:

```conf
CHECK_CMD="npm run ci"          # ~14-17s idle, longer when the VM is loaded
CHECK_FAST_CMD="npm run ci"     # same: the whole gate is already "fast"
CHECK_TIMEOUT=300
CHECK_FAST_TIMEOUT=180
```

`~/.fleet/check.conf` is host-wide machine state, so the coordinator/hub owns
writing it; this file only records the values and the measurements behind them.
If the suite grows past ~60s, split the tier by *scope*, not by change
detection: keep `npm run ci` as the fast tier and move the slow suite (browsers,
integration journeys) behind its own npm script that the full gate adds. A fast
tier must run tests unconditionally (see the next section).

### Why `vitest --changed` is not a gate here

Background: this section started as a "changed tests" fast tier. It is not one,
for two different reasons (findings `cloud-factory-cf-gy5`, `cloud-factory-cf-l0q`):

**No ref** (`vitest run --changed`, vitest 4.1.12, verified on this tree
2026-10-18) — the change list comes from staged/unstaged git state only, never
from the branch's commits. A committed branch therefore looks unchanged, and
`fleet-check` only accepts a committed tree, so this mode reported
**"No test files found, exiting with code 0"** on the state a gate actually
verifies. (On this pool it also selected nothing with an uncommitted edit to
`apps/worker/src/webhooks.ts`, which is why it is not trusted here at all.)

**Explicit ref** (`vitest run --changed=origin/main`) — vitest diffs
`ref...HEAD` in addition to staged/unstaged files, so a branch that only touches
docs or manifests legitimately selects zero tests. That zero is correct, not a
bug; the problem is that it still exits 0, so "no affected tests" is
indistinguishable from "the selection broke" or "there are no tests".

Either way a green run can mean nothing ran. Gates here run tests
unconditionally: `npm run test:file -- test/<file>.test.ts` while iterating,
`npm run ci` for any verdict. The `test:changed` npm scripts were removed so the
false-green path cannot be reached by habit or by a copied gate config.

## Budgets

- Fast tier target: **≤ 60s**. Escalate before it crosses that on an ordinary
  change.
- Full gate target: **≤ 120s**. A change that pushes past it must say so with a
  measurement in its `LAND-SUMMARY`.
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
- a workspace that must exist before tests run should say so with a
  `prebuild`/`pretest` hook (as `apps/worker` does for the canvas bundle).

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
- **One workerd at a time.** The pool starts one runtime; do not launch a second
  `wrangler dev` or browser in a test.

## Adding coverage without slowing the gate

- Pure logic (`src/webhooks.ts`: signature verification, normalisation) needs no
  Durable Object and no storage — those tests are the cheapest and should carry
  most of the table-driven cases.
- Integration paths (ingest → queue → claim/ack/fail) get one test each, in the
  file that owns the behaviour.
- If the suite ever needs both a Node-only project and the workerd project, use
  vitest projects and keep the Node project first: it is the part that can run
  without the pool.
