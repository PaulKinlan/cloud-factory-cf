# AGENTS.md — Cloud Factory CF (`cloud-factory-cf`)

> Autonomous SDLC agent cloud built on Pi, Cloudflare Durable Objects, and `@cloudflare/computer`.
> Repo: `PaulKinlan/cloud-factory-cf`

## 1. What this is

Cloud Factory CF is a Cloudflare-native autonomous SDLC software factory operating across edge Durable Objects and local developer environments.

- **Dual-Runtime**: Edge execution via Cloudflare Durable Objects (`RepoCoordinator`, `CredentialBroker`, `OrgCoordinator`) and local execution via `@factory-cloud/cli` runner.
- **Hierarchical Memory**: Org-level and Repo-level persistent memory in Durable Object SQLite.
- **Pluggable Sinks**: Dispatches actions to GitHub PR reviews, GitHub Issues, Beads tasks, and Cloud Telemetry.
- **Agent Studio & Canvas**: Visual infinite canvas (`apps/web`) exporting declarative agent wiring documents, and natural language prompt-to-agent authoring/simulation (`@factory-cloud/sdk`).
- **Credential Broker**: Zero raw secrets in agent prompts or runtimes; capability-based signed requests with quota and audit controls.

---

## 2. Monorepo Layout

```
cloud-factory-cf/
  packages/
    canvas-model/       # @factory-cloud/canvas-model: DOM-free document model & graph validation
    sdk/                # @factory-cloud/sdk: Pi-inspired lifecycle hooks, sinks, studio, memory store
    cli/                # @factory-cloud/cli: Local agent runner, queue worker, dogfooding PR reviewer
  apps/
    web/                # @factory-cloud/web: Vite infinite canvas web interface (served via ASSETS)
    worker/             # @factory-cloud/worker: Cloudflare Worker API & Durable Object coordinators
      src/routes/       # Modular domain route handlers (broker, studio, canvas, runs, webhooks, assets)
  docs/                 # Architecture & operational guides (speed.md, credentials.md, roles.md, etc.)
  scripts/              # Operational and dogfooding utility scripts
```

---

## 3. Build Order & Dependency Graph

`dist/` directories are gitignored. The actual workspace package dependencies are:

```
packages/canvas-model ──────┬──► apps/web ──(ASSETS)──┐
                            │                         ▼
                            └──► apps/worker ◄── packages/sdk ◄── packages/cli
```

- **`packages/canvas-model`**: standalone document model (no internal dependencies).
- **`packages/sdk`**: standalone extension and studio SDK (no internal dependencies).
- **`packages/cli`**: CLI tools and runner; depends on `@factory-cloud/sdk`.
- **`apps/web`**: canvas UI; depends on `@factory-cloud/canvas-model`.
- **`apps/worker`**: Cloudflare Worker; depends on `@factory-cloud/canvas-model` and `@factory-cloud/sdk`, and binds `apps/web/dist` as static assets (`ASSETS`).

### Compilation Order
Because `dist/` is gitignored, clean-tree compilation builds shared packages before consumers:
1. `packages/canvas-model` (`tsc -p tsconfig.build.json`)
2. `packages/sdk` (`tsc -p tsconfig.build.json`)
3. `packages/cli` (`tsc -p tsconfig.build.json`)
4. `apps/web` (`vite build`)
5. `apps/worker` (`wrangler deploy --dry-run --outdir dist`)

Run root compilation with:
```bash
npm run build           # compiles workspaces in dependency order
```

---

## 4. Test Tiers & Gate Budget (docs/speed.md)

Gate speed is a design constraint. Follow the tiers documented in [docs/speed.md](docs/speed.md):

| Tier | When to Run | Command | Budget |
|---|---|---|---|
| **Iterating** | While editing a single file/feature | `npm run test:file -w <workspace> -- <path>` | ≤ 3s |
| **Implementer Fast Gate** | Once per committed tree before handoff | `fleet-check --fast` | ≤ 60s |
| **Clean-Tree Full Gate** | Monorepo CI verification (all workspaces) | `npm run ci` | ≤ 120s |
| **Landing Gate** | Merger only, once per merged union | `fleet-check` | ≤ 120s |

### Focused Testing While Iterating
- **Worker workspace**: `npm run test:file -w @factory-cloud/worker -- test/worker.test.ts` (runs in workerd via `@cloudflare/vitest-plugin`).
- **Web workspace**: `npm run test:file -w @factory-cloud/web -- test/sync.test.ts` (runs in Vitest Node mode).
- **SDK & CLI workspaces**: `node --test --experimental-strip-types tests/**/*.test.ts` (Node native test runner).

### Gate Rules
- **Never re-gate an unchanged tree**: `fleet-check --status [<sha>]` reads cached verdicts without re-running.
- **Implementers run `fleet-check --fast`**: detached background run; wakes with `[check]`. End your turn after launching; never poll.
- **Merger runs full `fleet-check`**: implementers do not run full `fleet-check`.

---

## 5. Credential Broker & Zero-Secrets Policy (docs/credentials.md)

All secrets management follows the architecture in [docs/credentials.md](docs/credentials.md):
- **Never commit secrets, tokens, or private keys.**
- **No raw credentials in agent prompts or runtimes**: agents receive capability tokens issued by `CredentialBroker`, not raw GitHub or cloud provider tokens.
- **Capabilities are scoped and ephemeral**: minted for specific actions (`pr.review`, `issue.comment`, etc.) and verified against policy.
- **Fail closed**: unregistered capabilities or sinks are rejected immediately.

---

## 6. Beads Task Workflow

This repository uses Beads (`bd`) for durable task tracking across all lanes:

- **Check ready work**: `bd ready`
- **Claim an issue**: `bd update <id> --claim` (claim immediately upon creating or starting)
- **Sync issue state**: `bd dolt pull` before claiming, `bd dolt push` after updates
- **Comment progress**: `bd comment <id> "..."`
- **Handoff for review**:
  1. Commit work to branch `fleet/<lane>[-<slug>]` and push to origin.
  2. Run `fleet-check --fast` and confirm `PASS`.
  3. Add `LAND-SUMMARY` comment on bead (`WHAT:`, `WHY:`, `EFFECT:`).
  4. Execute `fleet-handoff <id>`.

---

## 7. Working in Git Worktrees

- **All file modifications happen in worktrees** (`~/worktrees/cloud-factory-cf-<lane>`).
- **Never write in the canonical checkout** (`~/cloud-factory-cf` is auto-reset by sync timer).
- **Fetch origin before decisions**: run `git fetch origin` before branching or rebasing.
- **Dependencies**: use `fleet-deps` or preserve workspace dependencies; never run `npm ci` from scratch without workspace awareness.
