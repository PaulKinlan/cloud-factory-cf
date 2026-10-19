# Credential broker proxy

Exe.dev-style capability broker: **agents never see a secret**. A prompt, a
tool's output and an agent runtime only ever hold a short-lived signed
capability naming an action it may take; the broker is the only component that
holds the real credentials and attaches them to an outbound request.

```
control plane ──(BROKER_CONTROL_KEY)──▶ POST /broker/<owner>/<repo>/capabilities
                                                   │  signed capability (≤15 min, repo+action scoped)
agent ──────────────────────────────────────────▶ POST /broker/<owner>/<repo>/proxy
                                                   │  allowlisted resolve -> credential attached
                                                   ▼
                                            api.github.com / gitlab.com
agent ◀── redacted response (no upstream headers, no credential) ──────────────┘
```

## Why it exists

An agent that can read a token in an env var, a prompt or a log line can leak it
through any tool call, any error message and any model context. Here the secret
exists only inside the `CredentialBroker` Durable Object's `env`; the agent's
side of the contract is a capability token plus parameters.

## What an agent can and cannot do

| Can | Cannot |
| --- | --- |
| Ask the control plane for a capability for one `service` + `action` | Choose the upstream host, URL, method or headers |
| Call `/proxy` with that capability and allowlisted params | Use a capability minted for another repository |
| Read `permissions` for a service/action | Restate a capability as a different/wider action |
| Retry until the capability expires | Smuggle extra params (they are refused, not dropped) |
| Read its own audit trail with the control key | See the credential, upstream auth headers or cookies |

Denials never reach the network: the broker resolves the request from its own
policy table (`src/credentials/policy.ts`) before a single byte is sent.

## Services and actions

The table is closed and lives in code so a review can see every capability that
exists. Add an action there, not in a prompt.

| Service | Action | Upstream |
| --- | --- | --- |
| `github` | `repo.read` | `GET /repos/{repository}` |
| `github` | `issue.comment`, `pr.comment` | `POST /repos/{repository}/issues/{number}/comments` |
| `github` | `pr.review` | `POST /repos/{repository}/pulls/{number}/reviews` |
| `gitlab` | `project.read` | `GET /api/v4/projects/{repository}` |
| `gitlab` | `mr.comment` | `POST /api/v4/projects/{repository}/merge_requests/{iid}/notes` |

`{repository}` always comes from the verified capability, never from the request
body; numeric ids must be positive integers and body values refuse control
characters, so path traversal, header injection and log injection are refused
rather than sanitised.

## Bindings

| Binding | Purpose |
| --- | --- |
| `CREDENTIAL_BROKER` | Durable Object namespace (one per repository, migration `v3`) |
| `BROKER_SIGNING_KEY` | HMAC-SHA256 key for capability tokens |
| `BROKER_CONTROL_KEY` | Grants capability issuance and audit read |
| `GITHUB_TOKEN`, `GITLAB_TOKEN` | Upstream credentials, read by the broker only |

Set them with `wrangler secret put <NAME>`; never in `vars`, `.dev.vars` in git,
or a prompt.

## Audit

Every issuance, execution and denial is written to `credential_audit` in the
repository's Durable Object: timestamp, agent, capability `jti`, service,
action, outcome, upstream status, duration and a short reason.

Deliberately **not** stored: the credential, the capability token, request
bodies and response bodies. `GET /broker/<owner>/<repo>/audit` requires the
control key because the metadata names agents and actions.

## Known limits (follow-ups, not hidden)

- Per-agent quota is enforced (see below); nothing yet stops a *holder of the
  control key* from issuing many capabilities, which is the next hardening bead
  (`cloud-factory-cf-2j3`, provisioning records).
- Capability issuance requires a provisioning record per (agent, service,
  action) — see below — but the control key can still create one for any agent:
  the next step is tying provisioning to an authenticated control-plane caller
  rather than a single shared key.
- The policy table is static; per-repo overrides would need a config surface.
- One upstream credential per service, not per installation.

## Quota (per agent, service and action)

A valid capability is replayable until it expires, so the broker also rate-limits
the calls it will make on an agent's behalf:

- Sliding window of 60s per `(agent, service, action)` inside the repository's
  broker object. `BROKER_QUOTA_PER_MINUTE` sets the limit (default `60`). Tests
  bind it to `4`.
- Only a plain non-negative integer is honoured, and only an explicit `"0"`
  disables the throttle. An empty, whitespace, negative, fractional or
  non-numeric value falls back to the default `60` instead of failing open
  (finding `cloud-factory-cf-8ae`).
- The slot is spent **after** the capability, repository, action and policy
  checks (a denied request costs nothing) and **before** the upstream call (a
  failing upstream call still costs a slot, so failures cannot be used to bypass
  the limit).
- Over the limit the broker answers `429` with `retry-after`, `limit` and
  `windowSeconds`, and writes an audit row with outcome `quota_exceeded` and
  status `429` — no upstream request is made.
- Expired rows are pruned on every check, so the table is bounded by the quota
  itself rather than by traffic history.

## Provisioning (who may receive a capability)

The control key alone no longer mints a capability for any agent id. Issuance
also needs a provisioning record for the exact `(agent, service, action)`, or a
record with `action = "*"` for that service:

| Route (broker object) | Purpose |
| --- | --- |
| `POST /provisioning` | add `{agent, service, action}` (`action: "*"` allows every action the policy permits) |
| `DELETE /provisioning` | revoke `{agent, service, action}` (404 when there is nothing to revoke) |
| `GET /provisioning` | list records, plus whether enforcement is on |

All three require `x-factory-control-key`. Provisioning cannot widen the policy
table: a record for an action the policy does not permit is refused with 403, and
a wildcard record still leaves policy-denied actions denied at issuance.

- Enforcement is **on by default**. `BROKER_REQUIRE_PROVISIONING=0` (or `false`/`no`)
  turns the check off for a deployment that provisions elsewhere.
- Issuance without a record returns `403` with `error: "agent is not provisioned
  for this action"` and writes an audit row (outcome `denied`) so a probing agent
  leaves a trace.
- Provisioning writes are audited too (`provisioned` / `deprovisioned`).
