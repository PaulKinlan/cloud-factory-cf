import {
  isDevPlatform,
  parseRepositoryKey,
  repositoryKey,
  type DevPlatform,
} from "@factory-cloud/sdk";
import type { Env } from "./env";
import type { RepoCoordinator } from "./repo-coordinator";

/**
 * Resolves a canonical platform-prefixed repository key for addressing RepoCoordinator
 * and CredentialBroker Durable Objects (ADR 003 Slice 3, cloud-factory-cf-6to.3).
 *
 * Rules:
 *   1. If `repository` is already prefixed (`github:owner/repo`, `gitlab:group/project`, `gitea:org/repo`), returns it.
 *   2. If `platformHint` is given (e.g. from `/webhooks/:provider` or `?platform=`), use `repositoryKey(platformHint, repository)`.
 *   3. Otherwise, defaults to "github": `repositoryKey("github", repository)`.
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
    if (!hinted || parsed.platform === hinted) return trimmed;
    return repositoryKey(hinted, parsed.repository);
  }
  return repositoryKey(hinted ?? "github", trimmed);
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
