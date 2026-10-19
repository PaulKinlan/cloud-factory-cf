# Dogfooding & Self-Hosting Integration

Cloud Factory CF self-hosts on its own repository (`PaulKinlan/cloud-factory-cf`) to continuously validate agent execution, pull request reviews, and event webhook pipelines.

## Architectural Overview

Cloud Factory CF supports two complementary runtime modes for self-hosting:

```
                          ┌────────────────────────┐
                          │  GitHub Pull Request   │
                          └───────────┬────────────┘
                                      │
               ┌──────────────────────┴──────────────────────┐
               ▼                                             ▼
  ┌─────────────────────────┐                   ┌─────────────────────────┐
  │  Cloudflare Worker API  │                   │  GitHub Actions Runner  │
  │  (Serverless / Edge)    │                   │  (Local Dual-Runtime)   │
  └────────────┬────────────┘                   └────────────┬────────────┘
               │                                             │
               │ POST /webhooks/github/...                   │ factory-cloud review
               ▼                                             ▼
  ┌─────────────────────────┐                   ┌─────────────────────────┐
  │     RepoCoordinator     │                   │    LocalAgentRunner     │
  │      Durable Object     │                   │     (@factory-cloud/    │
  │       Event Queue       │                   │          cli)           │
  └────────────┬────────────┘                   └────────────┬────────────┘
               │                                             │
               │ POST /runs/... (drain)                      │ Sinks / PR Review
               ▼                                             ▼
  ┌─────────────────────────┐                   ┌─────────────────────────┐
  │   Credential Broker +   │                   │    GitHub PR Review     │
  │   GitHubPRReviewSink    │                   │   Summary / Comments    │
  └─────────────────────────┘                   └─────────────────────────┘
```

1. **GitHub Actions Runner Mode (`@factory-cloud/cli review`)**:
   - Executes inside GitHub Actions runners during pull requests.
   - Fast, deterministic evaluation of pull request changes, test coverage guard, lockfile synchronization, and credential leak scans.
   - Publishes automated markdown summaries directly to `$GITHUB_STEP_SUMMARY` and posts PR reviews when `GITHUB_TOKEN` is supplied.
   - Fully sandboxed with workspace boundary enforcement.

2. **Cloudflare Worker & Durable Objects Mode (`/webhooks/github` & `/runs`)**:
   - Ingests signed GitHub webhooks via HMAC-SHA256 verification.
   - Durable Object `RepoCoordinator` buffers events in a durable SQLite queue with lease management.
   - The execution pipeline drains batches, resolves permissions through `CredentialBroker`, executes agent logic using `@factory-cloud/sdk`, and emits actions to `GitHubPRReviewSink`.

---

## 1. GitHub Actions Workflow

The automated PR review workflow lives at `.github/workflows/dogfood.yml`:

```yaml
name: Cloud Factory Dogfood Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  dogfood-review:
    name: Agent PR Review & Verification
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22.x
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Build workspaces
        run: npm run build

      - name: Run Self-Hosted PR Reviewer
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          node packages/cli/dist/bin.js review \
            --event "$GITHUB_EVENT_PATH" \
            --out "$GITHUB_STEP_SUMMARY"
```

---

## 2. Local Dogfood Execution

Developers and implementers can run the self-hosted reviewer locally using the helper script:

```bash
# Dry run review on current workspace
./scripts/dogfood.sh --dry-run

# Output markdown review to a file
./scripts/dogfood.sh --dry-run --out /tmp/review.md

# Strict mode: fail with exit code 1 if findings or changes requested
./scripts/dogfood.sh --strict
```

Or invoke `@factory-cloud/cli` directly:

```bash
npx @factory-cloud/cli review --pr 42 --repo PaulKinlan/cloud-factory-cf --dry-run
```

---

## 3. Webhook Simulation & Testing

To test the Cloudflare Worker webhook pipeline locally or against staging:

```bash
# Dispatch a signed webhook payload to the worker and immediately drain the queue
npx @factory-cloud/cli webhook \
  --url http://localhost:8787 \
  --secret "$WEBHOOK_SECRET" \
  --event pull_request \
  --repo PaulKinlan/cloud-factory-cf \
  --payload test/fixtures/pr-opened.json \
  --drain \
  --control-key "$CONTROL_KEY"
```

The CLI:
1. Calculates `x-hub-signature-256` HMAC-SHA256 signature using the secret.
2. Generates unique `x-github-delivery` UUID.
3. Dispatches HTTP POST to `/webhooks/github/:owner/:repo`.
4. Optionally calls `/runs/:owner/:repo` with Bearer auth to trigger queue processing and prints the execution report.

---

## 4. Required Secrets & Configuration

| Secret / Environment Var | Location | Description |
|--------------------------|----------|-------------|
| `GITHUB_TOKEN` | GitHub Actions / Env | GitHub token with `pull-requests: write` permission to post review comments. |
| `WEBHOOK_SECRET` | Worker / Repository Secrets | Secret key used to verify incoming GitHub webhook signatures (`x-hub-signature-256`). |
| `CONTROL_KEY` | Worker / Repository Secrets | Bearer token required to trigger `/runs/:owner/:repo` queue draining. |
