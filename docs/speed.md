# Speed: gate budget for cloud-factory-cf

Landing speed is the fleet's throughput, so this repo states what a gate costs
and what each tier is expected to run. Times measured on the fleet VM
(2026-10-18, node 24, vitest 4.1.12, wrangler 4.151.1), warm `node_modules`
served by `fleet-deps`.

## Commands and what they cost

| Command | What it does | Measured |
| --- | --- | --- |
| `npm run build` | `wrangler deploy --dry-run` — bundles the Worker, validates `wrangler.jsonc`, DO bindings and migrations | 1.9s |
| `npm run typecheck` | `tsc --noEmit` per workspace | 4.0s |
| `npm test` | `vitest run` inside workerd (`@cloudflare/vitest-plugin`) | 7.4s |
| `npm run ci` | build + typecheck + test | 13–15s |
| `npm run test:file -- test/<file>.test.ts` | one workerd test file | 2–3s |
| `vitest run --changed` | dev-loop only, **not a gate** — see below | selects 0 tests in a committed worktree |

Per file (inside the 7.4s suite): `test/computer-dependency.test.ts` ≈ 1.0s
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
CHECK_CMD="npm run ci"          # ~13-15s
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

Verified on this tree (vitest 4.1.12, 2026-10-18) — `vitest run --changed`
reported **"No test files found, exiting with code 0"**, i.e. a green run that
executed nothing, in all three states:

1. clean committed worktree (the state `fleet-check` requires),
2. after an uncommitted edit to `apps/worker/src/webhooks.ts`,
3. with an explicit ref, `vitest run --changed=origin/main`.

The mechanism (finding `cloud-factory-cf-gy5`): the change list comes from
staged/unstaged git state, not from the branch's commits, so a committed branch
looks unchanged and selects no tests. The `test:changed` npm scripts are removed
for that reason: a gate whose "nothing to test" is indistinguishable from a
green suite is worse than no gate. Use `npm run test:file -- test/<file>.test.ts`
while iterating, and `npm run ci` for any verdict.

## Budgets

- Fast tier target: **≤ 60s**. Escalate before it crosses that on an ordinary
  change.
- Full gate target: **≤ 120s**. A change that pushes past it must say so with a
  measurement in its `LAND-SUMMARY`.
- Adding a test that costs ~1s (like the `@cloudflare/computer` resolution
  guard) is fine when it protects a real contract; say so in the summary.

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
