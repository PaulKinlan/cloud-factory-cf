# Deploying Cloud Factory CF

One Worker serves the whole deployment: the API, every Durable Object, and the agent
canvas (`apps/web/dist`) from the **same origin**. There is no separate Pages project
and no second Worker to wire up.

```
                        ┌──────────────────────────────┐
  https://<worker>      │  apps/worker (Worker)        │
  ├── /health           │  ├─ /webhooks/…  → RepoCoordinator (per repo)
  ├── /webhooks/…       │  ├─ /canvas/…    → RepoCoordinator
  ├── /canvas/…         │  ├─ /runs/…      → OrgCoordinator
  ├─  /runs/…           │  ├─ /studio/…    → AgentStudio (sdk)
  ├── /studio/…         │  ├─ /broker/…    → CredentialBroker (per repo)
  ├── /broker/…         │  └─ everything else → ASSETS (apps/web/dist)
  └── everything else   │
                        └──────────────────────────────┘
```

What is verified here and what is not: every command in this guide that can run
without a Cloudflare account was executed on this repository
(`wrangler deploy --dry-run` from the repo root, and a local `wrangler dev` whose
responses are quoted below). Anything that needs your account — creating the
Worker, putting secrets, installing a GitHub App — is marked **needs your account**
and was not executed.

---

## 1. Prerequisites

- **Node 22** (CI uses `22.x`; `package.json` requires `>=20`).
- A **Cloudflare account** with Workers enabled and a plan that includes
  **Durable Objects** (this Worker declares three SQLite-backed DO classes). The
  free/paid boundary for Durable Objects changes — check the plan page before you
  start (**needs your account**).
- A GitHub App (**needs your account**) if you want webhooks; see §6.
- The repo checked out, and a Cloudflare login available to wrangler:
  `npx wrangler login` (**needs your account**), or `CLOUDFLARE_API_TOKEN` +
  `CLOUDFLARE_ACCOUNT_ID` in the environment for CI.

## 2. Build it once, locally

The build order is not optional: the Worker binds `apps/web/dist` as the `ASSETS`
directory, and `apps/worker` imports the compiled `@factory-cloud/sdk` and
`@factory-cloud/canvas-model` packages.

```bash
npm ci              # every workspace
npm run build       # canvas-model → sdk → cli → apps/web (vite) → apps/worker (dry-run)
npm run typecheck   # optional; per-workspace tsc --noEmit
```

`npm run build` on the Worker workspace is itself a `wrangler deploy --dry-run`, so
a successful build already proves the Worker bundles, the `wrangler.jsonc` parses,
all three Durable Object bindings resolve, the migration tags are well formed and
`apps/web/dist` exists. Measured cost: ~2s (see [speed.md](speed.md)).

## 3. Configuration and secrets

`apps/worker/wrangler.jsonc` is the single source of truth for bindings, the
compatibility date/flags, the assets binding and the DO migrations. It sets one
plain variable:

| Kind | Name | Value in the repo |
| --- | --- | --- |
| var | `ENVIRONMENT` | `development` in `wrangler.jsonc` — override per deployment |

Everything else is a secret, read through `FactoryEnv` in
[`apps/worker/src/env.ts`](../apps/worker/src/env.ts):

| Secret | Required? | What it does |
| --- | --- | --- |
| `WEBHOOK_SECRET` | **required for GitHub webhooks** | HMAC key for `X-Hub-Signature-256`. Unset ⇒ every GitHub webhook is refused with `503 webhook secret not configured` (fail closed). |
| `GITLAB_WEBHOOK_TOKEN` | required for GitLab webhooks | Compared against `X-Gitlab-Token`; unset ⇒ `503 gitlab token not configured`. |
| `GITEA_WEBHOOK_SECRET` | required for Gitea/Forgejo webhooks | Verified as `X-Gitea-Signature` (HMAC-SHA256 hex of the body) or compared against `X-Gitea-Token`; unset ⇒ `503 gitea webhook secret not configured`. |
| `BROKER_CONTROL_KEY` | required to use the broker control plane | Control-plane key for `POST /broker/…/capabilities`, provisioning, overrides, audit. |
| `BROKER_SIGNING_KEY` | required to mint capabilities | HMAC key for capability tokens. |
| `GITHUB_TOKEN` | for GitHub actions | Credential the broker attaches to `repo.read`, `issue.create`, `issue.comment`, `pr.comment`, `pr.review`. |
| `GITLAB_TOKEN` | for GitLab actions | Credential for `project.read`, `mr.comment`. |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | for the LLM reviewer | Credential the broker attaches to `anthropic:messages.create` / `openai:chat.completions`. Only the service named by `REVIEW_MODEL` needs a key. |
| `BEADS_API_HOST` / `BEADS_TOKEN` | for the beads sink | Unset ⇒ the beads sink reports the service as unconfigured. |
| `TELEMETRY_ENDPOINT` | optional | Where the telemetry sink exports; unset ⇒ structured log. |

Two further variables are read from the environment and are **not** secrets — set
them as `vars` if you need them: `BROKER_REQUIRE_PROVISIONING` (`"0"`/`"false"`
disables the provisioning requirement) and `BROKER_QUOTA_PER_MINUTE` (default 60,
`"0"` disables the quota).

Put secrets with wrangler (**needs your account**). Run it from the repo root with
the config path, or from `apps/worker` without `-c`:

```bash
npx wrangler secret put WEBHOOK_SECRET -c apps/worker/wrangler.jsonc
npx wrangler secret put BROKER_CONTROL_KEY -c apps/worker/wrangler.jsonc
npx wrangler secret put BROKER_SIGNING_KEY -c apps/worker/wrangler.jsonc
npx wrangler secret list -c apps/worker/wrangler.jsonc   # names only, never values
```

Secrets are never committed: `.dev.vars` is gitignored, and
`apps/worker/.dev.vars.example` holds only placeholders.

## 4. Deploy

From the repo root (the path in `-c` is resolved relative to the repository root,
and everything inside the config — `main`, `assets.directory` — is resolved
relative to **the config file**, so it works from either directory):

```bash
npm ci && npm run build
npx wrangler deploy -c apps/worker/wrangler.jsonc
```

or, equivalently, from the Worker workspace:

```bash
npm run deploy -w @factory-cloud/worker    # wrangler deploy, cwd=apps/worker
```

Both paths were verified with `--dry-run` on this repo: the bundle uploads
~200 KiB (39 KiB gzip), reads 5 files from `apps/web/dist`, and reports
`REPO_COORDINATOR`, `CREDENTIAL_BROKER`, `ORG_COORDINATOR`, `ASSETS` and
`ENVIRONMENT`. The deploy prints the Worker URL
(`https://cloud-factory-cf.<subdomain>.workers.dev` unless you set a route/domain).

**Do not** run `wrangler deploy` from the repo root without `-c`: there is no
root-level wrangler config, so wrangler would fail to find one.

## 5. Post-deploy checks

Run these against the deployed URL. The expected responses below are the ones
observed locally from `wrangler dev` on this commit, so a mismatch means the
deployment differs from the repo.

```bash
BASE=https://cloud-factory-cf.<subdomain>.workers.dev

curl -s $BASE/health
# 200 {"ok":true,"service":"cloud-factory-cf","environment":"development"}
#   -> "environment" is your ENVIRONMENT var; set it per deployment for clarity.

curl -s -o /dev/null -w '%{http_code}\n' $BASE/
# 200 -> the canvas is served from ASSETS (apps/web/dist was built and uploaded)

# unsigned webhook must be refused, not accepted:
curl -s -X POST -H 'x-github-event: pull_request' -H 'content-type: application/json' \
  --data '{"action":"opened","repository":{"full_name":"acme/widget"}}' \
  $BASE/webhooks/github/acme/widget
# 401 {"ok":false,"error":"invalid signature"}          (secret set, signature wrong)
# 503 {"ok":false,"error":"webhook secret not configured"}   (secret missing — fail closed)
```

Guarded routes fail closed the same way: with `BROKER_CONTROL_KEY` unset,
`POST /runs/<owner>/<repo>` and `POST /canvas/<owner>/<repo>/documents/<id>/run`
both answer `503 {"ok":false,"error":"control key not configured"}` (observed
locally), and `401 not authorised …` when the key is set but the
`x-factory-control-key` header is missing or wrong.

A correctly signed delivery needs all three headers (`X-GitHub-Event`,
`X-GitHub-Delivery`, `X-Hub-Signature-256`), and answers
`202 {"ok":true,"queued":true,"deliveryId":"…"}`; replaying the same delivery id
answers `200 {"ok":true,"duplicate":true,…}` and enqueues nothing. A valid
signature without a delivery id is `400 {"ok":false,"error":"missing delivery id"}`.
GitHub sends all of them, so this only bites hand-rolled curl requests.

## 6. GitHub App (webhooks)

**Needs your account.** Create a GitHub App for the repositories the factory may
work on, then point it at this deployment:

1. **Webhook URL** — one path per repository, so the coordinator can address the
   right Durable Object without inspecting the payload:
   `https://<worker-url>/webhooks/github/<owner>/<repo>`.
   (`/webhooks/gitlab/<owner>/<repo>` is the GitLab equivalent.)
2. **Webhook secret** — the same value you put in `WEBHOOK_SECRET`.
3. **Permissions** — derived from the broker policy in
   [`apps/worker/src/credentials/policy.ts`](../apps/worker/src/credentials/policy.ts):
   - *Contents: read* (`repo.read`),
   - *Issues: write* (`issue.create`, `issue.comment`, `pr.comment`),
   - *Pull requests: write* (`pr.review`).
   Nothing wider is called by the code.
4. **Events** — the Worker does not allow-list event names: it normalises
   `action`, `repository` and `sender.login` from whatever arrives and enqueues
   the event keyed by the `X-GitHub-Delivery` id. Subscribe to the events you want
   the factory to react to; `pull_request` and `issues` are the ones the sinks act on.

The webhook is a POST to the Worker only — the signature is verified **inside** the
`RepoCoordinator` over the raw body, so there is no unauthenticated parse of the
payload.

## 7. Local development (no account needed)

```bash
cd apps/worker
cp .dev.vars.example .dev.vars     # set WEBHOOK_SECRET (and GITLAB_WEBHOOK_TOKEN if used)
npm run dev                        # wrangler dev on http://localhost:8787
```

`.dev.vars` is gitignored; the example file contains placeholders only. `wrangler
dev` runs the DOs locally (miniflare), persists their SQLite in `.wrangler/`, and
serves `apps/web/dist` when it exists — run `npm run build -w @factory-cloud/web`
first if `GET /` is a 404.

## 8. Durable Object migrations

`apps/worker/wrangler.jsonc` declares three SQLite classes:

| Tag | Class |
| --- | --- |
| `v1` | `RepoCoordinator` |
| `v2` | `OrgCoordinator` |
| `v3` | `CredentialBroker` |

Rules that keep existing deployments alive:

- **Never edit or reuse a tag that has shipped.** Adding a class means appending a
  new tag with `new_sqlite_classes`; renaming a class means `renamed_classes` on a
  new tag.
- Tags are applied at deploy time and cannot be rolled back with the code — a
  rollback to a build that expects an older schema will still see the new one.
- Local `.wrangler/` state is disposable: delete it if a local migration confuses
  the dev server.

## 9. Updating and rolling back

```bash
git pull && npm ci && npm run build
npx wrangler rollback -c apps/worker/wrangler.jsonc     # to the previous version, if needed
```

`wrangler rollback` reverts the Worker code; Durable Object storage keeps its data
(event queues, hierarchical memory, canvas documents) and keeps any migrations
already applied — see §8.

## 10. Dashboard / "1-click" import

**Needs your account.** Cloudflare's Workers Builds can deploy this repo on every
push without a local checkout:

- **Root directory:** repository root (`/`).
- **Build command:** `npm ci && npm run build`
  (root build: canvas-model → sdk → cli → web → worker).
- **Deploy command:** `npx wrangler deploy -c apps/worker/wrangler.jsonc`
  (verified above to work from the repo root).
- **Environment/secrets:** add `WEBHOOK_SECRET` and the broker keys as build-time
  secrets; runtime secrets are better put with `wrangler secret put` so they never
  pass through a build.

The one-click *Deploy to Cloudflare* button expects a wrangler config at the top of
the repository; this repo keeps its only config at `apps/worker/wrangler.jsonc`, so
the button cannot be used as-is. Importing the repository through the dashboard
(above) is the supported one-click path today. Duplicating the config at the root
is deliberately not done: two configs drift, and a stale second copy would deploy
the wrong bindings.

## 11. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `wrangler deploy` says *"Couldn't find a wrangler.toml or wrangler.jsonc"* | run from the repo root without `-c` | add `-c apps/worker/wrangler.jsonc` or `cd apps/worker` |
| `GET /` is a 404 after deploy | `apps/web/dist` was missing at build time, so `ASSETS` uploaded nothing | run `npm run build` (root) before deploying |
| Webhook answers `503 webhook secret not configured` | `WEBHOOK_SECRET` not set for the deployed Worker | `wrangler secret put WEBHOOK_SECRET -c apps/worker/wrangler.jsonc` |
| Webhook answers `401 invalid signature` | secret differs between GitHub App and Worker, or a proxy rewrote the body | re-copy the secret; send the raw body |
| Webhook answers `400 missing delivery id` | hand-rolled request without `X-GitHub-Delivery` | send the header (GitHub always does) |
| `/canvas/…` or `/runs/…` answers `503 control key not configured` | `BROKER_CONTROL_KEY` unset | `wrangler secret put BROKER_CONTROL_KEY …`; the control plane fails closed |
| `/canvas/…` or `/runs/…` answers `401 not authorised …` | `x-factory-control-key` header missing or wrong | send the header with `BROKER_CONTROL_KEY` |
| Studio execution is refused | it needs a capability token, not the raw control key | see [credentials.md](credentials.md) |
| Deploy fails on Durable Objects | plan does not include Durable Objects, or a migration tag was reused | check the plan; append a new migration tag |
