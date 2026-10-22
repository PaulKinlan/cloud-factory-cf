# DO Event Audit Log API & Historical View

The repository coordinator Durable Object maintains a durable, SQLite-backed audit log of all ingested events and agent deliveries. This document covers the public audit API and CLI historical view tools.

## Architecture & Storage

All webhook events and run executions are recorded within the repository's `RepoCoordinator` Durable Object:

1. **`events` table**: Every ingested webhook payload (`delivery_id`, `provider`, `event`, `action`, `actor`, `received_at`, `payload`, `status`, `attempts`, `last_error`).
2. **`event_deliveries` table**: Idempotent agent delivery ledger tracking which agents executed or skipped each event (`delivery_id`, `agent_id`, `status`, `attempts`, `updated_at`).
3. **`run_audit` table**: Execution records for visual canvas runs (`document_id`, `name`, `agents`, `created_at`).

## Public Audit API

All audit endpoints are control-plane read surfaces and accept either credential
(see [credentials.md](credentials.md#control-plane-authentication-who-may-touch-which-tenant)):
the `x-factory-control-key` header matching `BROKER_CONTROL_KEY` (machine callers,
any tenant), or the browser's `cf_session` cookie, which may only read the account it
was minted for — asking for another `:owner` is `403`. With no credential configured
at all the endpoints return `503 Service Unavailable`; with a missing or invalid
credential `401 Unauthorized`. Non-GET requests return `405 Method Not Allowed`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/audit/events/:owner/:repo` | Query historical ingested events and status breakdown |
| `GET` | `/audit/events/:owner/:repo/:deliveryId` | Detailed audit for a single event including full payload and deliveries |
| `GET` | `/audit/events/:owner/:repo/stats` | Status counts summary (`pending`, `processing`, `processed`, `failed`). If an event with delivery ID `stats` exists, serves its detail view; pass `?counts=1` to explicitly request status counts. |
| `GET` | `/audit/runs/:owner/:repo` | Historical records for canvas runs |

### Query Parameters for `/audit/events/:owner/:repo/stats`

- `counts` (string, optional): Pass `counts=1` to explicitly retrieve the status breakdown counts even if an ingested event has delivery ID `stats`.

### Query Parameters for `/audit/events/:owner/:repo`

- `limit` (number, default: 50, max: 200): Maximum events to return (newest first).
- `status` (string, optional): Filter by event state (`pending`, `processing`, `processed`, `failed`).
- `deliveryId` (string, optional): Filter by exact delivery identifier.
- `event` (string, optional): Filter by event type (e.g. `pull_request`, `issues`, `push`).

### Example Response: `/audit/events/:owner/:repo`

```json
{
  "ok": true,
  "repository": "acme/widgets",
  "count": 2,
  "stats": {
    "processed": 1,
    "failed": 1
  },
  "events": [
    {
      "deliveryId": "deliv-002",
      "provider": "github",
      "event": "issues",
      "action": "opened",
      "repository": "acme/widgets",
      "actor": "octocat",
      "receivedAt": "2026-10-19T13:30:00.000Z",
      "status": "failed",
      "attempts": 5,
      "availableAt": "2026-10-19T13:35:00.000Z",
      "lastError": "upstream rate limit exceeded",
      "leaseId": null
    },
    {
      "deliveryId": "deliv-001",
      "provider": "github",
      "event": "pull_request",
      "action": "opened",
      "repository": "acme/widgets",
      "actor": "alice",
      "receivedAt": "2026-10-19T13:20:00.000Z",
      "status": "processed",
      "attempts": 1,
      "availableAt": "2026-10-19T13:20:00.000Z",
      "lastError": null,
      "leaseId": null
    }
  ]
}
```

### Example Response: `/audit/events/:owner/:repo/:deliveryId`

```json
{
  "ok": true,
  "repository": "acme/widgets",
  "event": {
    "deliveryId": "deliv-001",
    "provider": "github",
    "event": "pull_request",
    "action": "opened",
    "repository": "acme/widgets",
    "actor": "alice",
    "receivedAt": "2026-10-19T13:20:00.000Z",
    "status": "processed",
    "attempts": 1,
    "availableAt": "2026-10-19T13:20:00.000Z",
    "lastError": null,
    "payload": {
      "action": "opened",
      "number": 42,
      "pull_request": {
        "title": "Add feature",
        "user": { "login": "alice" }
      }
    }
  },
  "deliveries": [
    {
      "agentId": "pr-reviewer",
      "status": "delivered",
      "attempts": 1,
      "updatedAt": "2026-10-19T13:20:05.000Z"
    }
  ]
}
```

---

## CLI Historical View

Operators can inspect the DO event audit log directly from their terminal using the `@factory-cloud/cli` tool:

```bash
# View recent events audit log in human-readable table format
factory-cloud audit acme/widgets --control-key "$BROKER_CONTROL_KEY"

# Filter by event status
factory-cloud audit acme/widgets --status failed --limit 10

# Inspect a specific event delivery, including payload and agent deliveries
factory-cloud audit acme/widgets --delivery deliv-001

# Machine-readable JSON output
factory-cloud audit acme/widgets --json
```

Environment variables `FACTORY_WORKER_URL` and `FACTORY_CONTROL_KEY` can be set to omit `--url` and `--control-key` flags.
