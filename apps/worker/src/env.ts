import type { OrgCoordinator } from "./org-coordinator";
import type { CredentialBroker } from "./credential-broker-object";
import type { RepoCoordinator } from "./repo-coordinator";

export interface FactoryEnv {
  /**
   * Static assets for the agent canvas (`apps/web/dist`). Requests that match a
   * file are served by the asset layer before the Worker runs, except for the
   * API prefixes listed in `assets.run_worker_first`.
   */
  ASSETS?: Fetcher;
  /** One Durable Object per repository, addressed by `idFromName("<owner>/<repo>")`. */
  REPO_COORDINATOR: DurableObjectNamespace<RepoCoordinator>;
  /** One Durable Object per organization, addressed by `idFromName("<owner>")`. */
  ORG_COORDINATOR?: DurableObjectNamespace<OrgCoordinator>;
  /** Shared secret used to validate inbound GitHub webhook signatures. Never committed. */
  WEBHOOK_SECRET?: string;
  /** Shared token GitLab sends verbatim in `X-Gitlab-Token`. Never committed. */
  GITLAB_WEBHOOK_TOKEN?: string;
  /** Per-repository credential broker (holds the real credentials, never agents). */
  CREDENTIAL_BROKER: DurableObjectNamespace<CredentialBroker>;
  /** HMAC key for signing capability tokens. Never committed. */
  BROKER_SIGNING_KEY?: string;
  /** Control-plane key required to issue a capability. Never committed. */
  BROKER_CONTROL_KEY?: string;
  /** Upstream credentials the broker may attach - one binding per service. */
  GITHUB_TOKEN?: string;
  GITLAB_TOKEN?: string;
  ENVIRONMENT: string;
}

/** The bindings the Worker itself sees. */
export type Env = FactoryEnv;

declare global {
  namespace Cloudflare {
    // Lets tests (which type `env` as Cloudflare.Env) see the same bindings as
    // the Worker. Generated `worker-configuration.d.ts` would declare this too.
    interface Env extends FactoryEnv {}
  }
}
