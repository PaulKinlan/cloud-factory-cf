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
  if (parseRepositoryKey(trimmed)) {
    return trimmed;
  }
  const platform: DevPlatform =
    platformHint && isDevPlatform(platformHint) ? platformHint : "github";
  return repositoryKey(platform, trimmed);
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
