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
3. for each agent, in document order: claim queued events, keep the ones its
   source nodes name (`provider` + `event`, `*` matches all), run each through
   the execution pipeline with the agent's prompt, its wired sinks and its
   memory scope, then ack/fail; events no agent wanted are **released** back to
   the queue without counting an attempt;
4. one `run_audit` row records the document, the agents and the delivery ids
   each one consumed (`GET /runs/audit` on the coordinator lists them).

Response: `{ ok, documentId, name, ran, failed, agents: [{ agentId, name, sources, sinks, runs, status, error? }] }`.

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
