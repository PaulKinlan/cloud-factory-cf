# ADR 005 — GitHub OAuth session as the tenant boundary; retire the master control key

- **Status:** Accepted; slices 1–2 landing (see *Slices*)
- **Date:** 2026-10-22
- **Bead:** `cloud-factory-cf-oa4u`
- **Related:** ADR 006 (account hierarchy — who may do what), `docs/credentials.md`
  (mechanism and bindings), `cloud-factory-cf-e1ql` (implementation),
  `cloud-factory-cf-ec98` (remaining routes), `cloud-factory-cf-qdud` (UI),
  `cloud-factory-cf-aqq3` (trace WebSocket ticket)

## Context

Every control-plane route was guarded by one condition:

```ts
if (!(await sameSecret(env.BROKER_CONTROL_KEY, request.headers.get("x-factory-control-key"))))
  return 401;
```

That has three properties, and only the first was ever intended:

1. It is a sound check of *a* credential.
2. The credential names **no tenant**. Anything holding it — a curious operator, a CI
   script, a pasted key in a browser dialog, a log line, a screenshot — reaches every
   repository in the deployment. `:owner` in a path was a routing hint, not a boundary.
3. A browser cannot hold a server secret safely. `apps/web` therefore *prompted the
   user for it*, which normalised pasting the master key into an input field
   (`apps/web/src/sync.ts`, `admin.html`).

Two narrow fixes already shipped pointed at the real answer without completing it: a
signed `cf_session` cookie for `/api/repos` (`cloud-factory-cf-d33`), and the rule that
install-only callbacks must never mint a session because an installation id proves no
identity (`cloud-factory-cf-dnrm`). What was missing was the decision to make the
session the *general* control-plane credential and to say what happens to the key.

## Decision

**The browser's GitHub OAuth session is the only human control-plane credential, and
`:owner` is the tenant boundary.**

- The session is an HMAC-signed cookie `cf_session = <login>.<exp>.<sig>`, minted only
  after a GitHub OAuth `code` exchange has named the login (`routes/auth.ts`). It is
  `HttpOnly`, `SameSite=Lax`, `Secure` on https, 8h TTL, and bound to one login.
- Authorisation is one function, `apps/worker/src/auth/tenant.ts`
  (`authorizeControlPlane`): the machine key first (unchanged contract), then the
  session, which may only act for its own login — a valid session asking for another
  `:owner` is a typed `cross-tenant` 403, never a retry with a weaker credential.
- Sessions are signed with `BROKER_SIGNING_KEY`, falling back to
  `BROKER_CONTROL_KEY`/`WEBHOOK_SECRET`, so a deployment serves browsers with the
  master key **unset**. With neither configured, routes fail closed with 503.
- **The master key survives only as a machine credential**: CI, the scheduler, the CLI
  and an operator's break-glass path. It is not a user credential, it must never be
  requested by the UI, and each route that still needs it is a tracked debt, not a
  design.
- Routes that spend credentials on a tenant's behalf (`/runs/*`,
  `/canvas/.../run`, `/broker/*`, `/admin/*`, `/trace/*`) keep the key **for now**:
  they mint capabilities with it server-side or forward it to a Durable Object that
  verifies it. Retiring the key there requires issuing capabilities against a
  *principal* rather than a master key — that is `cloud-factory-cf-ec98`, and ADR 006
  defines the principals.
- **The UI must never ask for the key.** A prompt is how a server secret becomes a
  user habit; the session is already in the browser (`cloud-factory-cf-qdud`).

## Operator guide

To run without the master key:

1. Set `BROKER_SIGNING_KEY` (long random, `wrangler secret put`). This signs both
   capabilities and sessions.
2. Keep `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` / the App private key: the login
   and callback are the identity source.
3. Leave `BROKER_CONTROL_KEY` unset **unless** you use the CLI, a scheduler, or the
   execution routes above. Set it only if `docs/credentials.md`'s "still
   control-key-only" list matters to you.
4. Verify what a keyless deployment actually serves **today** (see the table below).

### What works with the key unset — as of `a902a86`

| Surface | Keyless behaviour | Blocked on |
| --- | --- | --- |
| `/audit/*`, `/canvas/<owner>/<repo>/documents`, `/studio/*`, `/analysis/*/tree` | serves the session's own tenant; 403 for another `:owner` | — |
| `/api/repos` (the canvas repository list) | **still 503** — `handleApiRepos` returns early when `BROKER_CONTROL_KEY` is unset, before it looks at a session | `cloud-factory-cf-owqq` (implemented on `fleet/imp-admin`, unmerged) |
| The web UI | **still prompts** for a control key in the connect dialog and admin panel | `cloud-factory-cf-qdud` |
| `/runs/*`, `/canvas/.../run`, `/broker/*`, `/admin/*`, `/trace/*` | 503/401 without the key | `cloud-factory-cf-ec98` |

So a keyless deployment is a *supported target*, not a finished state: the tenant
boundary is real on the routes listed as serving sessions, and the three rows above say
what is not. Do not read this ADR as a claim that the key is already unnecessary.

Rollback is setting `BROKER_CONTROL_KEY` again: the machine path is checked first and
was never removed, so no route becomes unusable while the debts are open.

## Consequences

**Positive.** Removing one shared secret removes the blast radius that made a hosted,
multi-customer deployment impossible. A leaked browser credential is one login's
read access, revocable by expiring a cookie, not every tenant's data. Once slice 2
lands, the prompt disappears, so nobody has a habit of pasting the master key (until
then it still appears — see the keyless table above).

**Negative / accepted.** Two credentials to reason about instead of one; a session
cannot act for an org it merely has read access to (that is ADR 006's org role), so an
org admin must sign in as themselves; a GitLab/Gitea namespace that shares a name with
a GitHub login is reachable only with the machine key, because permission data comes
from GitHub (documented in `docs/credentials.md`).

**Explicitly not decided here.** Who administers an account and what each tier may do
(ADR 006); whether sessions gain refresh/rotation (they are re-minted on each login);
whether the machine key is deleted outright rather than kept as break-glass (`ec98`
closes this).

## Slices

| Slice | Work | Bead | State |
| --- | --- | --- | --- |
| 1 | Session as tenant-bound control-plane credential on `/audit`, `/canvas` documents, `/studio`, `/analysis` tree | `cloud-factory-cf-e1ql` | implemented, cleared for landing |
| 2 | UI stops prompting for the control key; repo connect via browser session (`/api/repos` keyless fix is `owqq`) | `cloud-factory-cf-qdud` | open |
| 3 | Trace WebSocket stops carrying the key in a query string (ephemeral ticket) | `cloud-factory-cf-aqq3` | branch exists (`fleet/imp-2-aqq3`); its lane is gone and the bead is `review-failed`/`waiting` — orphaned, needs re-routing |
| 4 | Per-tenant capability issuance; execution routes drop the master key | `cloud-factory-cf-ec98` | open (needs ADR 006 slices 1–2) |

## Alternatives considered

- **Bearer token in `localStorage`.** Rejected: readable by any script on the origin and
  by any XSS, and it must be minted, stored and revoked by hand. The cookie is
  `HttpOnly` and minted by the OAuth callback already in place.
- **Per-user GitHub PAT pasted into the canvas.** Rejected: that is the prompt problem
  again, with a credential that never expires and cannot be scoped per repo by us. It
  also puts a raw token in the browser, against the zero-secrets policy in
  `docs/credentials.md`.
- **Signed URLs for every read.** Rejected: unguessable is not authorised, links leak
  (referrers, screenshots, logs), and every route would grow its own signing scheme.
- **Keep the key, add `:owner` checks per route.** Rejected: the key still *is* the
  authority — any holder is every tenant — so the blast radius is unchanged. That is
  why this ADR pairs with `ec98` rather than stopping at the route guard.
