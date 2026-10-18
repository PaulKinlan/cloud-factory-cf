import type { RepoCoordinator } from "./repo-coordinator";

export interface FactoryEnv {
  /** One Durable Object per repository, addressed by `idFromName("<owner>/<repo>")`. */
  REPO_COORDINATOR: DurableObjectNamespace<RepoCoordinator>;
  /** Shared secret used to validate inbound webhook signatures (never committed). */
  WEBHOOK_SECRET?: string;
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
