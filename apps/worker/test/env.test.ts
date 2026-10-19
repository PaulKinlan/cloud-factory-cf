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

  it("conforms to FactoryEnv interface contracts", () => {
    const factoryEnv: FactoryEnv = {
      REPO_COORDINATOR: env.REPO_COORDINATOR,
      CREDENTIAL_BROKER: env.CREDENTIAL_BROKER,
      ORG_COORDINATOR: env.ORG_COORDINATOR,
      ENVIRONMENT: "test",
    };
    expect(factoryEnv.ENVIRONMENT).toBe("test");
  });
});
