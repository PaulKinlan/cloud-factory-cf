import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * A repository-wide guard for the class of bug behind cloud-factory-cf-o1os and
 * cloud-factory-cf-khnm: a value the application does not control (a repository name from the
 * GitHub API, a passkey label the registrant chose) interpolated into markup and executed in
 * an admin page - root's session on a factory deployment.
 *
 * Fixing each site as a reviewer finds it leaves the next one to be found the same way. This
 * test is the standing rule for apps/web: markup may be written as a static string (clearing a
 * container, a fixed notice), and must never be assembled from a value. Anything that needs
 * data builds nodes and uses textContent / setAttribute.
 *
 * Comments are stripped first: several source files name `innerHTML` in a comment explaining
 * why it is not used, and a rule that fires on its own explanation cannot stay green.
 */
const SRC = new URL("../src/", import.meta.url);

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Every rule is a way to build markup from a value; each has an exact safe alternative. */
const SINKS: Array<{ name: string; pattern: RegExp }> = [
  { name: "innerHTML assigned a template literal with an interpolation", pattern: /innerHTML\s*\+?=\s*`[^`]*\$\{/ },
  { name: "innerHTML assigned by concatenation", pattern: /innerHTML\s*\+=\s*[^;]*\+/ },
  { name: "insertAdjacentHTML", pattern: /insertAdjacentHTML\s*\(/ },
  { name: "outerHTML assignment", pattern: /outerHTML\s*=/ },
  { name: "document.write", pattern: /document\.write(?:ln)?\s*\(/ },
];

const files = readdirSync(SRC)
  .filter((name: string) => name.endsWith(".ts"))
  .sort();

describe("apps/web never assembles markup from data (cloud-factory-cf-o1os)", () => {
  it("scans every source file, so a new module is covered by default", () => {
    expect(files.length).toBeGreaterThan(5);
    expect(files).toContain("admin.ts");
  });

  for (const { name, pattern } of SINKS) {
    it(`has no ${name}`, () => {
      const offenders = files.filter((file: string) =>
        pattern.test(stripComments(readFileSync(new URL(file, SRC), "utf8"))),
      );
      expect(offenders, `use textContent/setAttribute instead (see admin.ts repoItem)`).toEqual([]);
    });
  }
});
