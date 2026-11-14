// Registers the module-customization hook that raises vitest's hardcoded 90s
// pool worker-start timeout (see ./vitest-worker-start-timeout.mjs and bead
// cloud-factory-cf-zcil). Loaded via NODE_OPTIONS "--import" from the worker
// workspace test scripts, so it is active before vitest evaluates its pool
// scheduler chunk.
import { register } from "node:module";

register("./vitest-worker-start-timeout.mjs", import.meta.url);
