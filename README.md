# Cloud Factory CF (`cloud-factory-cf`)

Cloudflare-native autonomous SDLC agent cloud built on Pi, Cloudflare Durable Objects, and `@cloudflare/computer`.

## Architecture Highlights
- **Dual-Runtime**: Runs both at the edge (Cloudflare Durable Objects) and locally on developer machines.
- **Hierarchical Memory**: Org-level & Repo-level persistent memory in Durable Object SQLite.
- **Pluggable Sinks**: Logs and acts across GitHub PRs, Issues, Beads, and Cloud Telemetry.
- **Pi Extension Hooks**: Minimal composable lifecycle hooks inspired by the Pi extension API.

## Layout

```
apps/worker/     Cloudflare Worker entry point + per-repo Durable Object
apps/web/        Agent canvas — Isocan-style infinite canvas that exports agent config
packages/canvas-model/  @factory-cloud/canvas-model — DOM-free document model (rules, validation, toAgentConfig), shared by the canvas and the worker
packages/sdk/    @factory-cloud/sdk — Pi-inspired extension hooks (see epic)
```

Gate commands, their measured cost and the test-tier rules live in
[docs/speed.md](docs/speed.md). The credential broker (zero raw secrets in
agent prompts or runtimes) is described in
[docs/credentials.md](docs/credentials.md).

## Local development

```bash
npm install          # from the repo root: installs every workspace
npm test             # Vitest inside workerd (@cloudflare/vitest-plugin)
npm run typecheck    # tsc --noEmit per workspace
npm run build        # wrangler deploy --dry-run (bundles, no upload)

cd apps/worker
cp .dev.vars.example .dev.vars   # set WEBHOOK_SECRET
npm run dev          # wrangler dev on http://localhost:8787
```

Deployment secrets are never committed: `wrangler secret put WEBHOOK_SECRET`
before `npm run deploy`. The Durable Object (`RepoCoordinator`) is created with
the `new_sqlite_classes` migration in `apps/worker/wrangler.jsonc`.

## Agent canvas (`apps/web`)

An infinite canvas for assembling a run: drag event sources, agents, memory hubs
and action sinks onto the board, wire them (source → agent → sink/memory, memory →
agent, enforced in the model), edit each node in the inspector, and **Export
config** to get the `{ agents: [...] }` JSON the control plane consumes. The
layout persists in `localStorage`; nothing is sent to the network.

The canvas is served by the API Worker on the same origin (`apps/worker/wrangler.jsonc`
binds `apps/web/dist` as `ASSETS`, with `run_worker_first: true`):

```bash
npm run dev -w @factory-cloud/worker  # http://localhost:8787 → canvas + API
npm run dev -w @factory-cloud/web     # Vite dev server on :5173 (canvas only)
```

See [apps/web/README.md](apps/web/README.md) for the wiring rules, the exported
contract and the keyboard model.

## Running a stored canvas

`POST /canvas/:owner/:repo/documents/:id/run` (control key) turns a stored
document into work — the layout *is* the agent configuration:

1. the document is read from the repository's coordinator and parsed with the
   shared `@factory-cloud/canvas-model` (`parseDoc` + `toAgentConfig`), so the
   worker derives exactly what the canvas exports;
2. the plan is rejected (400) with a reason if a layout cannot run: no agent
   nodes, an agent without a prompt, or an agent with no event source wired;
3. claim up to `limit` events (default 5, `{ "limit": n }`) for the whole run,
   then **fan out**: each event runs *every* agent whose sources name it
   (`provider` + `event`, `*` matches all), with that agent's prompt, wired
   sinks and memory scope. The event is settled once — ack only when every
   agent succeeded, otherwise `/fail`. A retry is **idempotent per
   (event, agent)**: the coordinator keeps a delivery ledger and skips a pair that
   already delivered, so only the agent that failed runs again. Events no agent
   wanted are **released** back to the queue without counting an attempt;
4. one `run_audit` row records the document, the agents and the delivery ids
   each one consumed (`GET /runs/audit` on the coordinator lists them).

Response: `{ ok, documentId, name, ran, events, failed, agents: [{ agentId, name, sources, sinks, runs, status, error? }] }`
— `ran` counts agent executions (an event wired to two agents counts twice),
`events` counts the events claimed and settled, and `deduped` counts agent
executions skipped because that pair had already delivered.

Delivery is idempotent **per action**, not only per agent: an agent wired to two
sinks (an issue and a beads task, say) records `delivered` for the action that
succeeded, so a retry caused by the other sink failing re-runs only that one
(`agentId#actionType` rows in the same ledger). Without that, a partially failed
multi-sink run created the issue twice (finding `cloud-factory-cf-j1y`).

The delivery ledger is `event_deliveries` in the repository's coordinator
(`POST /deliveries/claim`, `POST /deliveries/complete`, `GET /deliveries?deliveryId=`).
A pair is `started` while a run is in flight, then `delivered`, `failed` (which
is retried) or `skipped`. A `started` row from a crashed attempt is retried —
at-least-once is the honest choice when the process may have died mid-request.

The ledger is enforced inside `runEvent`, so **every** runner is covered: the
canvas run, the queue drain behind `POST /runs/:owner/:repo`, and the scheduled
handler. The drain has no agent identity of its own, so it asks the ledger to skip
an event that any agent already delivered and hands it back to the queue
(`release`) — it neither re-posts a review nor acknowledges a failure belonging to
a canvas agent.

If the ledger cannot record a run after the side effects happened (a rejected or
unreachable write), the run is retried three times; if it still fails the outcome
carries `deliveryError` and the event is acknowledged anyway. That choice is
deliberate: retrying would post the review twice, so the gap is reported instead
of hidden (`ledgerErrors` in the run report).

In a fan-out that cuts both ways: if one agent delivered but its ledger write was
lost, the event is acknowledged even when another agent failed — retrying would
repeat the delivered agent — and the report names both the failed agent and the
ledger gap.

Today's deterministic runtime can deliver `github-pr-review` and
`github-issue-comment`; a sink type it does not know is ignored rather than
invented, and a model runtime can replace the decision function without touching
the route.

## Canvas documents (per repository Durable Object)

A canvas layout can be stored with the repository so it is not stuck in one
operator's browser. Documents live in the repository's `RepoCoordinator` SQLite
and are control-plane data (a layout names agents and actions), so every call
needs `x-factory-control-key`:

| Route | Purpose |
| --- | --- |
| `GET /canvas/:owner/:repo/documents` | list (id, name, timestamps) |
| `PUT /canvas/:owner/:repo/documents` | create — server assigns the id (201) |
| `PUT /canvas/:owner/:repo/documents/:id` | create-or-update that id (200/201) |
| `GET /canvas/:owner/:repo/documents/:id` | fetch name + document |
| `DELETE /canvas/:owner/:repo/documents/:id` | delete (404 when absent) |

The document is validated before storage: `version: 1`, `nodes`/`edges` arrays,
at most 500 nodes and 2 000 edges, at most 256 KiB, names under 120 characters,
and at most 200 documents per repository. A body the canvas could not load is a
400 rather than a stored trap.

## Event pipeline (per repository Durable Object)

Each `<provider>/<owner>/<repo>` endpoint maps to one `RepoCoordinator` Durable
Object, which verifies the payload, dedupes it on the provider delivery id and
persists it in SQLite. A runner consumes the queue with claim/ack/fail:

| Route (on the object) | Purpose |
| --- | --- |
| `POST /events?provider=github\|gitlab` | verify + enqueue (202 new, 200 duplicate) |
| `GET /events?status=&limit=` | inspect the queue |
| `POST /claim {limit, visibilityMs}` | lease up to `limit` due events (`processing`, `attempts + 1`) |
| `POST /ack {deliveryIds}` | mark leased events `processed` (no-op unless leased) |
| `POST /fail {deliveryIds, error}` | retry with backoff, dead-letter after 5 attempts |
| `POST /drain` | mark every due event processed (tools/tests) |
| `GET /stats` | counts per status |

Delivery is **at-least-once**: a lease that is not acked is handed back by the
Durable Object alarm, so a crashed runner cannot lose an event. Verification is
provider-specific — GitHub signs the raw body with HMAC-SHA256
(`WEBHOOK_SECRET`), GitLab sends `X-Gitlab-Token` (`GITLAB_WEBHOOK_TOKEN`) — and
a payload naming a different repository than its endpoint is refused with 400.
