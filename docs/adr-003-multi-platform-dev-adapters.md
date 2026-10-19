# ADR 003 — Universal DevPlatform adapters

- **Status:** Accepted (slice 1 implemented in cloud-factory-cf-6to.1)
- **Date:** 2026-10-19
- **Bead:** `cloud-factory-cf-6to` (GitLab, Bitbucket, Gitea/Forgejo integration)

## Context

Every layer of the factory assumed GitHub: webhook headers (`x-github-event`,
`x-github-delivery`), payload shapes (`repository.full_name`, `sender.login`), and
repository addressing (`owner/repo` as the Durable Object name). Publishing to
anything else means either a second code path per provider or, worse, silently
treating two different repositories as one.

## Decision

One platform-neutral event, one adapter per forge.

- **`SdlcEvent`** — the canonical delivery: `platform`, `deliveryId`, `rawEvent`,
  `kind` (`merge_request | pipeline | push | issue | comment | release | ping |
  unknown`), the provider-native `action`, a portable `canonicalAction`
  (`opened | updated | merged | closed | null`), `repository` (`group/project`,
  un-prefixed) and `actor`.
- **`DevPlatformAdapter`** — per forge: `deliveryId(headers)`, `rawEvent(headers)`,
  `normalise(payload, headers)`, `webhookPath(repository)`.
- **Repository identity includes the platform** — `repositoryKey(platform, repo)` is
  `github:acme/widget`, `gitlab:group/project`, … . `acme/widget` on GitHub and on
  GitLab are different repositories and must never share DO storage or memory.
- **Unknown is recorded, not dropped**: an event the factory does not model becomes
  `kind: "unknown"`; only input that is not a webhook payload, or carries no delivery
  id / repository, is refused (no invented events).
- **Verification is not in the SDK.** Signature and token checks need the
  deployment's secrets and the Workers crypto surface, so they stay beside the
  worker route that receives the request (`apps/worker/src/webhooks.ts`). An adapter
  only normalises an already-authenticated payload.

Slices:

1. **Done (6to.1):** interface, `SdlcEvent`, adapters for GitHub / GitLab /
   Gitea-Forgejo, `repositoryKey`/`parseRepositoryKey`, tests.
2. Worker wiring: `POST /webhooks/:platform/:repository` for `gitea`, verification
   per platform, and the queue/ledger carrying the canonical event.
3. DO addressing: prefix `RepoCoordinator` names with the platform and migrate the
   existing `owner/repo` rows.
4. Sinks: speak `SdlcEvent` rather than provider payloads.

## Consequences

- Adding a forge is one adapter file plus a route, not a branch in every consumer.
- Existing GitHub storage keeps working un-prefixed until slice 3 migrates it, so the
  platform key is additive rather than a breaking rename.
- `canonicalAction` is a small vocabulary on purpose: a provider action that does not
  map is still available verbatim in `action`.
