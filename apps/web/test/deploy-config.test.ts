import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Deployment-config regression pins (cloud-factory-cf-nmjd).
 *
 * These read repo files, which only a Node-runtime suite can do (the worker suites run in
 * workerd, where there is no filesystem). The web workspace is in every fast-gate smoke
 * set, so a deploy-config regression cannot slip through a docs-only landing.
 *
 * The property: the committed wrangler configs set NO `ENVIRONMENT`. A deployment without
 * it enforces the strict session-cookie policy (plain `cf_session` honoured only below the
 * legacy migration cutoff). The old committed `development` default silently re-opened the
 * sibling-subdomain set 79jv closed, on every deployment that did not override it. Local
 * `wrangler dev` gets `ENVIRONMENT=development` from `.dev.vars` instead.
 */
describe("wrangler deploy configs", () => {
  it("commit no ENVIRONMENT default (cloud-factory-cf-nmjd)", () => {
    for (const config of ["wrangler.jsonc", "apps/worker/wrangler.jsonc"]) {
      const text = readFileSync(new URL(`../../../${config}`, import.meta.url), "utf8");
      expect({ config, setsEnvironment: /"ENVIRONMENT"\s*:/.test(text) }).toEqual({
        config,
        setsEnvironment: false,
      });
    }
  });

  it("ship the local-mode var in .dev.vars.example, never as a deploy var", () => {
    // The one sanctioned place for ENVIRONMENT=development is the copy-me file for
    // `wrangler dev`: plain http there cannot hold a __Host- cookie, so local login needs
    // the plain name and the explicit local marking.
    const example = readFileSync(new URL("../../../apps/worker/.dev.vars.example", import.meta.url), "utf8");
    expect(example).toMatch(/^ENVIRONMENT=development$/m);
  });
});
