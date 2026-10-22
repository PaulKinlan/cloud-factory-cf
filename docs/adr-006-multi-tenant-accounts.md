# ADR 006 — Hierarchical multi-tenant accounts and authorisation

- **Status:** Proposed (design only; no code in this slice)
- **Date:** 2026-10-22
- **Bead:** `cloud-factory-cf-w6gj`
- **Builds on:** `docs/credentials.md#control-plane-authentication-who-may-touch-which-tenant`
  (tenant-bound sessions, `cloud-factory-cf-e1ql`), ADR 003 (repository identity
  includes the platform), ADR 004 (3-tier scoped admin — placeholder file, superseded
  in scope by this ADR).
- **Unblocks:** `cloud-factory-cf-ec98` (per-tenant capability issuance so execution
  routes need no master key).

## Context

The deployment can now answer *"is this caller allowed to touch anything?"*. It
cannot answer *"is this caller allowed to do **this** in **that** account?"*.

What exists today, precisely:

| Piece | Reality |
| --- | --- |
| Tenant | The `:owner` path segment. There is no membership record for it. |
| Human identity | A GitHub OAuth login, carried in the `cf_session` cookie (`routes/auth.ts`). |
| Machine identity | `BROKER_CONTROL_KEY` — one key, names no tenant, reaches every repository. |
| Authorisation | `apps/worker/src/auth/tenant.ts`: control key (any tenant) **or** session (only its own login). One rule for every route. |
| Org state | `OrgCoordinator` Durable Object per org: `github_installations(installation_id, account_login, account_type, installed_at)` and `authorized_repos(full_name, owner, name, is_private, default_branch, installation_id, updated_at)`. |
| Repo state | `RepoCoordinator` per `platform:owner/repo` (ADR 003), plus `CredentialBroker` tables `agent_provisioning`, `repo_overrides`, `repo_settings`. |
| Capabilities | `BROKER_SIGNING_KEY`-signed, repo+action scoped, ≤15 min, issued against `BROKER_CONTROL_KEY`. |
| Admin UI | `apps/web/admin.html` edits broker settings, gated by the control-key prompt. |

So "multi-tenant" today means *data* is separated (`platform:owner/repo` DOs) while
*authority* is not: a login that can read one repo of an account can also rewrite
that account's canvas, agent studio and settings, and the only way to run an agent is
still the master key. Three questions the platform cannot answer, all of which block
selling or hosting it:

1. Who administers a customer account, and what may they change?
2. Which of a customer's people may *read* versus *act* (spend credentials, run agents)?
3. Who administers the deployment itself — quotas, which services are offered, which
   models?

A flat "session = the account" rule cannot answer them: read access to a public repo
is not authority over the org, and an org admin is not necessarily the deployment
operator.

## Decision

Three human tiers over one identity source, plus the machine principal.

### 1. Principals

| Tier | Principal | Proof | Scope |
| --- | --- | --- | --- |
| Platform Owner | a login in the deployment allowlist (`PLATFORM_OWNERS`, comma-separated, secret) | session | the whole deployment |
| Customer Org Admin | a login with **admin** permission on a repository of that account, or the `account_login` of an installation | session | that account's repositories |
| End User | a login with **triage/push/pull** permission on one repository | session | that repository, read + run |
| Machine | `BROKER_CONTROL_KEY` | shared key | any tenant, for CI/scheduler/operator paths |

`PLATFORM_OWNERS` is deployment configuration (a secret on the Worker), not customer
data: it answers "who owns this deployment", which no tenant record can.

### 2. Identity resolution — one function, no ambient authority

`auth/tenant.ts` grows from "who presented a credential" to "what may they do":

```
resolvePrincipal(request, env): ControlPrincipal | null      // existing, plus machine
resolveRole(principal, env, { platform, owner, repo }): Role // trusted, cached
authorize(request, env, { platform, owner, repo, need: Need }): Result
```

- `Need` is one of `read` | `write` | `act` | `admin` | `platform`.
- Role is derived, never asserted by the caller: no role is ever taken from a query
  parameter, header or request body.
- Repo permission for a login comes from GitHub, resolved with the **App installation
  token** (the callback already mints one at `routes/auth.ts`,
  `/app/installations/{id}/access_tokens`) against
  `GET /repos/{owner}/{repo}/collaborators/{login}/permission`. The user's own OAuth
  token is **not** stored — the zero-secrets rule in `docs/credentials.md` is not
  relaxed for convenience; slice 1 must confirm the App's granted permission scope
  actually allows this call, and fall back to "installation account only" if not.
- Results are cached per `(login, platform, owner, repo)` for a short TTL (60s) in the
  Worker, because every canvas autosave must not cost a GitHub round trip.
- **Platform is part of the identity check.** A GitHub login that happens to match a
  GitLab namespace name grants nothing on GitLab (ADR 003: `github:acme/x` and
  `gitlab:acme/x` are different repositories). Cross-platform accounts are an explicit
  binding, never a name match.

### 3. Permission matrix

| Surface | End User | Org Admin | Platform Owner | Machine key |
| --- | --- | --- | --- | --- |
| `GET /trace/*`, `/audit/*` (own repo) | read | read | read | any tenant |
| `/canvas/*/documents` read | read | read | read | any tenant |
| `/canvas/*/documents` write, `/studio/*` author | act | write | write | any tenant |
| `/canvas/.../run`, `/runs/*` (spend credentials) | act | act | act | any tenant |
| `/api/admin/settings/*` (broker settings, BYOK keys) | — | admin | admin | any tenant |
| `/broker/*/provisioning`, `/overrides` (what agents may do) | — | admin | admin | any tenant |
| `/api/repos` (account inventory) | read (own login) | read (own account) | read (any) | any tenant |

`act` requires `write`-or-better repository permission, because running an agent posts
comments and takes actions on the customer's repo: read-only callers get `read`.

### 4. Capabilities carry the principal

The capability token gains `sub` (login) and `role` claims next to the existing
repository/action binding. Then:

- the broker can enforce quota and audit per **person**, not just per agent;
- issuance no longer needs a master key to name the tenant: `ec98` becomes "sign a
  capability for the resolved principal with `BROKER_SIGNING_KEY`" instead of "hold the
  one key that can reach everyone";
- a capability cannot be replayed by a different login (the claim is in the signature).

Provisioning authority splits accordingly: the **platform owner** decides which
services/actions exist for the deployment, the **org admin** decides which agents of
their account are provisioned for them. Today both are `BROKER_CONTROL_KEY`.

### 5. Denials are typed and auditable

Every refusal is one of `unauthenticated` (401), `cross-tenant` (403), `role-too-low`
(403, names the need), or `unconfigured` (503) — the four `auth/tenant.ts` already
returns plus one. Each is written to the repo's `credential_audit` with the resolved
principal, so "who tried what" is answerable per tenant rather than per deployment.

## Consequences

**Positive.** Customers can be given an account and an admin without handing them a
key that reaches every other customer. The master key stops being required for the
product to work (`ec98`), which is also the prerequisite for removing it entirely.
Quota and audit become per-person, which is what a hosted product bills on.

**Negative / costs.**

- Every authorised request may add one GitHub API call; the 60s cache bounds it, but
  cache invalidation on permission change is best-effort (documented, not silent).
- Org roles live in `OrgCoordinator`; platform owners live in Worker secrets — two
  places to look when debugging "why was I refused".
- More states to test: role × route × platform is a matrix, and the tests must be
  generated from the matrix rather than hand-written per route.

**Not addressed here.** Billing and quotas per account, invitations/offboarding
(GitHub is the source of truth), SSO/SAML, per-repo roles distinct from org roles,
and audit retention. Files as separate beads when needed.

## Slices

| Slice | Deliverable | Bead |
| --- | --- | --- |
| 1 | `resolveRole()` + `authorize({need:"read"})` on `/audit`, `/trace`; matrix-driven tests; confirm GitHub permission lookup works with the App installation token | new |
| 2 | `write`/`act` on canvas + studio for end users, `admin` on settings for org admins (`PLATFORM_OWNERS` allowlist, org role from `OrgCoordinator`) | new |
| 3 | Capability `sub`/`role` claims, per-tenant issuance, execution routes drop the master key | `cloud-factory-cf-ec98` |
| 4 | Platform owner console: provisioning catalogue, quotas, cross-tenant audit | new |

Detail for slice 4 is deliberately omitted until slices 1–3 exist: it is the part
most likely to change once real tenants use slices 1–3.

## Alternatives considered

- **Per-user API tokens.** Simplest to implement and the worst to operate: another
  long-lived secret per person to leak, rotate and revoke, and it reintroduces the
  prompt this ADR exists to delete. Rejected.
- **Free-form RBAC with custom roles and policies.** Correct for a mature product,
  premature here: nobody can yet name the second role they want beyond "admin" and
  "user", and a policy language is a security surface of its own. The three tiers are
  the smallest set that answers the three questions in *Context*.
- **Membership tokens minted per org (an "org session").** Would work, but duplicates
  what GitHub already knows about who may touch a repository, and drifts the moment
  someone is removed from the org. GitHub stays the source of truth; we cache.
- **Keep the master key and add per-route tenant checks only.** That is what
  `cloud-factory-cf-e1ql` already did for reads. It cannot reach the goal, because the
  key itself is the authority: any holder is every tenant. Hence this ADR's slice 3.
