// In-memory patch for vitest's hardcoded pool worker-start timeout (bead
// cloud-factory-cf-zcil).
//
// vitest (4.1.12, still hardcoded in 5.1.0) gives a pool runner exactly 90s to
// start: `const WORKER_START_TIMEOUT = 9e4;` in dist/chunks/cli-api.*.js, with
// no env var or option to change it. A workerd (`cloudflare-pool`) runner start
// costs ~15-50s on this fleet's 2-core VMs when idle, so any concurrent gate
// load pushes the start past 90s and vitest fails with
// "[vitest-pool]: Timeout starting cloudflare-pool runner." before a single
// test runs.
//
// node_modules is a read-only hard-linked fleet-deps store, so the dist file
// cannot be edited on disk. Instead this module-customization hook rewrites the
// constant as the chunk is loaded into the main vitest process (the pool
// scheduler runs there, so this is the only process that needs the patch).
//
// The timeout defaults to 240s here (2.6x the worst observed loaded start of
// ~91s) and can be overridden with VITEST_WORKER_START_TIMEOUT=<ms>.

const timeoutMs =
  Number(process.env.VITEST_WORKER_START_TIMEOUT) > 0
    ? Number(process.env.VITEST_WORKER_START_TIMEOUT)
    : 240_000;

const NEEDLE = "WORKER_START_TIMEOUT";
const PATTERN = /const WORKER_START_TIMEOUT = [^;]+;/;
const REPLACEMENT = `const WORKER_START_TIMEOUT = ${timeoutMs};`;

let patched = false;
let warned = false;

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!url.includes("/vitest/dist/chunks/") || result.source == null) {
    return result;
  }
  const source =
    typeof result.source === "string"
      ? result.source
      : Buffer.from(result.source).toString("utf8");
  if (!source.includes(NEEDLE)) {
    return result;
  }
  if (PATTERN.test(source)) {
    result.source = source.replace(PATTERN, REPLACEMENT);
    if (!patched) {
      patched = true;
      console.error(
        `[vitest-worker-start-timeout] patched ${NEEDLE} to ${timeoutMs}ms (cloud-factory-cf-zcil)`,
      );
    }
    return result;
  }
  if (!warned) {
    warned = true;
    console.error(
      `[vitest-worker-start-timeout] WARNING: ${NEEDLE} found in ${url} but the ` +
        `declaration did not match ${PATTERN}; vitest internals changed and the ` +
        `90s default is still in force. Update this hook or the vitest pin.`,
    );
  }
  return result;
}
