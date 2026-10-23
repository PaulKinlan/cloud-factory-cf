import {
  isDevPlatform,
  parseRepositoryKey,
  repositoryKey,
  type DevPlatform,
} from "@factory-cloud/sdk";
import type { Env } from "./env";
import type { RepoCoordinator } from "./repo-coordinator";
import type { CredentialBroker } from "./credential-broker-object";

/**
 * Resolves a canonical platform-prefixed repository key for addressing RepoCoordinator
 * Durable Objects.
 *
 * All repository keys are canonicalized to lowercase so that addressing is
 * case-insensitive across webhooks, trace, API routes, and session authentication.
 */
export function resolveRepositoryKey(repository: string, platformHint?: string | null): string {
  const trimmed = repository.trim();
  const parsed = parseRepositoryKey(trimmed);
  if (parsed) {
    return repositoryKey(parsed.platform, parsed.repository.toLowerCase());
  }
  const platform: DevPlatform =
    platformHint && isDevPlatform(platformHint) ? platformHint : "github";
  return repositoryKey(platform, trimmed.toLowerCase());
}

/**
 * Resolves a canonical repository key for addressing CredentialBroker Durable Objects.
 *
 * Strips any platform prefix and canonicalizes to lowercase. Special single-name
 * targets like "default" and "global" are preserved in lowercase.
 */
export function resolveBrokerKey(repository: string): string {
  const trimmed = repository.trim();
  const parsed = parseRepositoryKey(trimmed);
  const repo = parsed ? parsed.repository : trimmed;
  return repo.toLowerCase();
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

/**
 * Returns a DurableObjectStub to the CredentialBroker instance.
 */
export function getCredentialBroker(
  env: Env,
  repository: string,
): DurableObjectStub<CredentialBroker> {
  const key = resolveBrokerKey(repository);
  return env.CREDENTIAL_BROKER.get(env.CREDENTIAL_BROKER.idFromName(key));
}
