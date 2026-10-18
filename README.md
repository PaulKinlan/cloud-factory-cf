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
