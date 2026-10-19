import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { REQUIRED_WORKER_BINDINGS, type Env, type FactoryEnv } from "../src/env";

describe("Worker environment configuration", () => {
  it("provides expected core Durable Object and environment bindings", () => {
    const workerEnv: Env = env;
    expect(workerEnv).toBeDefined();

    for (const binding of REQUIRED_WORKER_BINDINGS) {
      expect(workerEnv[binding]).toBeDefined();
    }

    expect(typeof workerEnv.REPO_COORDINATOR.get).toBe("function");
    expect(typeof workerEnv.REPO_COORDINATOR.idFromName).toBe("function");

    expect(workerEnv.CREDENTIAL_BROKER).toBeDefined();
    expect(typeof workerEnv.CREDENTIAL_BROKER.get).toBe("function");
    expect(typeof workerEnv.CREDENTIAL_BROKER.idFromName).toBe("function");

    expect(workerEnv.ORG_COORDINATOR).toBeDefined();
    expect(typeof workerEnv.ORG_COORDINATOR?.get).toBe("function");
    expect(typeof workerEnv.ORG_COORDINATOR?.idFromName).toBe("function");

    expect(workerEnv.ENVIRONMENT).toBe("development");
  });

  it("detects when a required binding is missing from an environment record", () => {
    const incompleteEnv: Record<string, unknown> = {
      REPO_COORDINATOR: env.REPO_COORDINATOR,
      // CREDENTIAL_BROKER and ENVIRONMENT intentionally omitted
    };

    const missing = REQUIRED_WORKER_BINDINGS.filter((binding) => incompleteEnv[binding] === undefined);
    expect(missing).toEqual(["CREDENTIAL_BROKER", "ENVIRONMENT"]);
  });
});
