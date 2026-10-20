# Migration Plan: Platform-Prefixed RepoCoordinator Addressing (ADR 003 Slice 3)

- **Bead:** `cloud-factory-cf-6to.3`
- **Status:** Proposed & Implemented
- **Author:** `cloud-factory-cf-imp-2`
- **Related ADR:** [ADR 003 — Universal DevPlatform adapters](./adr-003-multi-platform-dev-adapters.md)

---

## 1. Context & Motivation

Before ADR 003, `RepoCoordinator` Durable Objects were addressed purely by `owner/repo` (e.g. `acme/widget`). Every webhook, event queue, execution trace, canvas document, and persistent memory table assumed GitHub as the sole forge.

In Slices 1, 2, and 4 of ADR 003:
- `@factory-cloud/sdk` introduced `DevPlatformAdapter`, `SdlcEvent`, and `repositoryKey(platform, repo)` (producing `github:acme/widget`, `gitlab:group/project`, `gitea:org/repo`).
- Ingestion (`/webhooks/:provider/:owner/:repo`) and the event queue accepted GitLab and Gitea/Forgejo payloads.
- The pipeline was upgraded to make decisions over canonical `SdlcEvent`s (`canonicalView()`).

However, `RepoCoordinator` Durable Object names remained un-prefixed (`${owner}/${repo}`). Consequently:
1. A GitHub repository and a GitLab repository with the same path (e.g. `acme/widget`) would map to the **same Durable Object instance**, sharing queues, canvas layouts, credentials, and memory.
2. Slices 1 and 2 established that a repository's identity must include its platform.

This slice (Slice 3) addresses `RepoCoordinator` by platform-prefixed keys (`github:org/repo`, `gitlab:group/project`, `gitea:org/repo`) and migrates existing un-prefixed GitHub tenants without data loss or downtime.

---

## 2. Migration Options Considered

### Option A: One-Shot Batch Migration
- **Approach:** Enumerate all existing Durable Objects and copy their SQLite state into new prefixed DOs during a coordinated maintenance window.
- **Drawbacks:**
  - Cloudflare Workers Durable Objects provide **no listing or enumeration API** for instantiated DO IDs.
  - A one-shot migration would require an external database or KV ledger containing every repository ever created. No such global registry exists in the factory.
  - Requires a deploy freeze window where incoming webhooks and canvas edits are blocked.

### Option B: Read-Through Migration on First Access (Selected)
- **Approach:** When a platform-prefixed Durable Object (`github:owner/repo`) is accessed for the first time, it checks whether legacy un-prefixed data exists in `owner/repo`. If un-prefixed data is found, it exports the legacy SQLite state via an internal endpoint and imports it into the new DO within an atomic transaction.
- **Benefits:**
  - **Zero Downtime:** No deployment window or service freeze required.
  - **No Global Index Needed:** Migration happens lazily and deterministically per repository when touched.
  - **No Stranded Tenants:** Existing GitHub tenants immediately load their existing memory, canvas layouts, event queues, and audit traces seamlessly.
  - **Forwarding Support:** If an outdated client or un-updated webhook calls the legacy un-prefixed DO (`owner/repo`), the legacy DO forwards the request to `github:owner/repo`.

---

## 3. Implementation Specification

### 3.1 Addressing & Key Resolution

In `@factory-cloud/sdk`:
- `repositoryKey(platform, repository)`: Returns `${platform}:${repository}`.
- `parseRepositoryKey(key)`: Returns `{ platform, repository }` or `null`.

In Worker route handlers (`webhooks.ts`, `canvas.ts`, `runs.ts`, `trace.ts`, `audit.ts`, `studio.ts`, `admin.ts`):
- A helper `resolveRepoCoordinator(env, repository, platformHint?)`:
  1. If `parseRepositoryKey(repository)` is non-null, use `repository` as-is.
  2. If `platformHint` is provided (e.g. from `/webhooks/:provider` or `?platform=`), use `repositoryKey(platformHint, repository)`.
  3. Otherwise, default to GitHub: `repositoryKey('github', repository)`.

### 3.2 Read-Through Migration Protocol in `RepoCoordinator`

1. **Migration Flag Table**:
   Each `RepoCoordinator` maintains an internal schema migration table:
   ```sql
   CREATE TABLE IF NOT EXISTS _schema_migrations (
     name TEXT PRIMARY KEY,
     migrated_at INTEGER NOT NULL
   );
   ```

2. **Trigger**:
   When `RepoCoordinator` receives a request, if:
   - `this.ctx.id.name` is platform-prefixed (`parseRepositoryKey(this.ctx.id.name)?.platform === 'github'`), AND
   - `SELECT 1 FROM _schema_migrations WHERE name = 'legacy_read_through'` returns empty:
   The coordinator triggers `migrateFromLegacy(legacyRepoName)`.

3. **Export from Legacy DO**:
   - The prefixed DO fetches `https://repo-coordinator.internal/legacy/export` from `env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(legacyRepoName))` passing `x-factory-control-key`.
   - The legacy DO validates `x-factory-control-key` against `env.BROKER_CONTROL_KEY`.
   - If the legacy DO has 0 rows across its tables (e.g. brand new repo), it returns `{ ok: true, empty: true }` without mutating state.
   - Otherwise, it queries its tables (`memory`, `canvas_documents`, `webhook_connect`, `events`, `event_deliveries`, `run_audit`, `run_trace`) and returns the exported records as JSON. Alarms remain active until import confirmation.

4. **Import into Prefixed DO**:
   - The prefixed DO executes an atomic SQLite transaction (`BEGIN TRANSACTION` ... `COMMIT`, with `ROLLBACK` on error):
     - Inserts all exported rows (`INSERT OR IGNORE`).
     - Inserts `('legacy_read_through', Date.now())` into `_schema_migrations`.
   - If the transaction throws or export fails, `_schema_migrations` is NOT written, allowing subsequent requests to retry.
   - Upon successful commit:
     - The prefixed DO calls `https://repo-coordinator.internal/legacy/ack-migrated` with `x-factory-control-key`.
     - The legacy DO marks itself as `migrated_to_prefixed` in `_schema_migrations` and cancels its alarm (`deleteAlarm()`).
     - If the newly imported queue has due events, `armAlarm()` is scheduled on the prefixed DO.

5. **Legacy DO Proxying**:
   - If an un-prefixed DO (`parseRepositoryKey(this.ctx.id.name)` is `null`) receives a non-legacy request, it proxies the request to `github:${this.ctx.id.name}` via internal fetch, ensuring zero stranded requests.

6. **CredentialBroker Scope Note**:
   - `CredentialBroker` DOs are addressed by repository name (`owner/repo`), as credential storage and capability quota are per repository across services. `RepoCoordinator` is platform-prefixed (`github:org/repo`, `gitlab:group/project`, `gitea:org/repo`) for event queue, trace, and memory isolation.

---

## 4. Rollout & Deployment Window

- **Deploy window:** Continuous / Zero-downtime.
- **Rollback safety:** If rolled back, un-prefixed DOs still retain their original rows (import is non-destructive on legacy state).
