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
