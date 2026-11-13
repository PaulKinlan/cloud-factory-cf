import {
  isDevPlatform,
  parseRepositoryKey,
  repositoryKey,
  type DevPlatform,
} from "@factory-cloud/sdk";
import type { Env } from "./env";
import type { RepoCoordinator } from "./repo-coordinator";

/**
 * Folds a repository's owner/repo text to the canonical lowercase spelling
 * (cloud-factory-cf-n23o). The key IS the Durable Object name, and two spellings of
 * one repository were two objects: a delivery stored under GitHub's own casing was
 * invisible to a trace read typed in any other casing, and both showed 0 evidence.
 * One canonical spelling for every caller is the fix; the migration in
 * RepoCoordinator recovers state already stored under older spellings.
 */
function foldRepository(repository: string): string {
  const parsed = parseRepositoryKey(repository);
  return parsed ? `${parsed.platform}:${parsed.repository.toLowerCase()}` : repository.toLowerCase();
}

/**
 * Resolves the canonical platform-prefixed repository key for addressing RepoCoordinator
 * and CredentialBroker Durable Objects (ADR 003 Slice 3, cloud-factory-cf-6to.3).
 *
 * Rules:
 *   1. If `repository` is already prefixed (`github:owner/repo`, `gitlab:group/project`, `gitea:org/repo`), returns it.
 *   2. If `platformHint` is given (e.g. from `/webhooks/:provider` or `?platform=`), use `repositoryKey(platformHint, repository)`.
 *   3. Otherwise, defaults to "github": `repositoryKey("github", repository)`.
 *
 * The owner/repo part is canonicalised to lowercase in EVERY case (cloud-factory-cf-n23o):
 * callers spell the same repository differently (a webhook payload carries GitHub's own
 * casing, a trace URL carries the operator's typing), and the key must not fork into two
 * objects because of it. The platform prefix is already lowercase.
 */
export function resolveRepositoryKey(repository: string, platformHint?: string | null): string {
  const trimmed = repository.trim();
  const parsed = parseRepositoryKey(trimmed);
  const hinted: DevPlatform | null =
    platformHint && isDevPlatform(platformHint) ? platformHint : null;

  if (parsed) {
    // A prefix written into the text is authoritative only when nothing contradicts it. An
    // explicit hint means the caller routed on that platform - an API path segment or
    // `?platform=` - so a prefix naming a DIFFERENT platform must not win: returning it
    // unchanged is how a delivery or request addressed to one provider reached the other
    // provider's coordinator for the same owner/repo (cloud-factory-cf-6eqm).
    if (!hinted || parsed.platform === hinted) return foldRepository(trimmed);
    return foldRepository(repositoryKey(hinted, parsed.repository));
  }
  return foldRepository(repositoryKey(hinted ?? "github", trimmed));
}

/**
 * Canonical CredentialBroker name for a repository: the bare `owner/repo`, lowercased
 * (cloud-factory-cf-n23o). The broker namespace is un-prefixed (ADR 003 Slice 3), so this
 * is the broker-side twin of `resolveRepositoryKey` - and both must fold the same way, or
 * a coordinator holding `github:acme/widget` asks a broker the settings UI never wrote to
 * (the g5c0 split). Strips a platform prefix if a caller passes the prefixed key.
 */
export function resolveBrokerRepository(repository: string): string {
  const trimmed = repository.trim();
  const parsed = parseRepositoryKey(trimmed);
  return (parsed ? parsed.repository : trimmed).toLowerCase();
}

/**
 * Returns a DurableObjectStub to the platform-prefixed RepoCoordinator instance.
 */
export function getRepoCoordinator(
  env: Env,
  repository: string,
  platformHint?: string | null,
): DurableObjectStub<RepoCoordinator> {
  const key = resolveRepositoryKey(repository, platformHint);
  return env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(key));
}

/** The broker stub shape the pipeline depends on (see PipelineDeps in pipeline.ts). */
export interface BrokerStub {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

/**
 * A canonical CredentialBroker stub whose every request declares the repository spelling
 * the caller used (cloud-factory-cf-n23o). Settings stored pre-canonicalisation live under
 * that spelling; the broker probes it when its canonical store misses, so a run or canvas
 * drain keeps its credentials without waiting for an admin re-save.
 */
export function brokerWithOriginalRepository(env: Env, repository: string): BrokerStub {
  const stub = env.CREDENTIAL_BROKER.get(
    env.CREDENTIAL_BROKER.idFromName(resolveBrokerRepository(repository)),
  );
  const spelling = repository.trim();
  return {
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("x-factory-original-repository", spelling);
      return stub.fetch(input, { ...init, headers });
    },
  };
}
