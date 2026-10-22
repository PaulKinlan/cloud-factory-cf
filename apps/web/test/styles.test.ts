import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

/** The app-shell rule: the `body {` block that lays the shell out as a column. */
const shellRule = (): string => {
  const match = /body\s*\{[^}]*display:\s*flex[^}]*\}/.exec(styles);
  return match ? match[0] : "";
};

describe("app shell containment (cloud-factory-cf-7j7i)", () => {
  it("clips the shell instead of hiding overflow", () => {
    const rule = shellRule();
    expect(rule, "the app-shell body rule must exist").not.toBe("");
    expect(rule).toContain("overflow: clip;");
    // `hidden` would make the shell a programmatically scrollable container: script,
    // scrollIntoView and assistive tech can scroll it while the affordance stays hidden.
    expect(rule).not.toContain("overflow: hidden;");
  });

  it("keeps the focus-ring case covered rather than relying on the shell padding", () => {
    // Focus rings are drawn outside the element box, so clipping at the shell edge could
    // eat them. The shell must not turn into a scroll container to avoid that - the
    // controls sit inside the topbar padding instead.
    const topbar = /\.topbar\s*\{[^}]*\}/.exec(styles)?.[0] ?? "";
    expect(topbar).toContain("padding: 12px 18px;");
  });
});
