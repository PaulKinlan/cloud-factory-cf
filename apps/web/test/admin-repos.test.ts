import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The admin repository list renders data that comes from the GitHub API for a repository the
 * App was installed on: `fullName`, `defaultBranch`, `owner` and `name` are all attacker-
 * chosen text if someone installs the App on a repository they control and names it
 * `<img src=x onerror=...>`. That list is an admin surface, so rendering those fields as
 * markup is stored XSS in the operator's - possibly root's - session (cloud-factory-cf-o1os).
 *
 * Same shape as admin-passkeys.test.ts: there is no DOM in this suite by design, so the
 * assertion is on the render path - the row must be built with textContent and setAttribute,
 * and no repository field may appear inside an HTML template.
 */
const admin = readFileSync(new URL("../src/admin.ts", import.meta.url), "utf8");

/**
 * Comments are stripped before asserting: the builder's own doc comment names `innerHTML`
 * while explaining why it must not be used, and a check that fails on the explanation is a
 * check nobody can keep green.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** The body of `repoItem`, the single place a repository row is built. */
function repoItemBody(): string {
  const start = admin.indexOf("const repoItem = (");
  expect(start, "repoItem must exist - it is the single repository row builder").toBeGreaterThan(-1);
  const open = admin.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < admin.length; i += 1) {
    if (admin[i] === "{") depth += 1;
    else if (admin[i] === "}") {
      depth -= 1;
      if (depth === 0) return stripComments(admin.slice(open, i + 1));
    }
  }
  throw new Error("unbalanced braces after repoItem");
}

/** The two builders the list renders through: the action element and the row. */
function repoRowRegion(): string {
  const start = admin.indexOf("const repoAction = (");
  const end = admin.indexOf("const renderRepositories = (");
  expect(start, "repoAction must exist").toBeGreaterThan(-1);
  expect(end, "renderRepositories must follow the builders").toBeGreaterThan(start);
  return stripComments(admin.slice(start, end));
}

describe("admin repository list rendering (cloud-factory-cf-o1os)", () => {
  it("builds repository rows with textContent, not markup", () => {
    const body = repoItemBody();
    expect(body).toContain("textContent");
    // Nothing in the row builder writes markup at all.
    expect(body).not.toContain("innerHTML");
  });

  it("puts the repository identity into attributes through the DOM, not into attribute strings", () => {
    const body = repoRowRegion();
    expect(body).toContain("setAttribute");
    expect(body).not.toContain("innerHTML");
    // The old shape was data-owner="${r.owner}" data-repo="${r.name}" inside a template.
    expect(admin).not.toMatch(/data-owner="\$\{/);
    expect(admin).not.toMatch(/data-repo="\$\{/);
  });

  it("never interpolates a value into an HTML template anywhere in admin.ts", () => {
    // The precise invariant: a template literal is fine as textContent or an href set through
    // the DOM, and is stored XSS the moment it is assigned to innerHTML. This catches the next
    // such template wherever it is added, not just in the repository list.
    expect(admin).not.toMatch(/innerHTML\s*=\s*`[^`]*\$\{/);
    // The repository fields must not be interpolated into markup at all.
    expect(admin).not.toMatch(/\$\{r\.fullName\}/);
  });

  it("still renders the list through the safe builder", () => {
    const render = admin.slice(admin.indexOf("const renderRepositories ="), admin.indexOf("// Wire actions"));
    expect(render).toContain("repoItem(");
    // The only innerHTML left there clears the list or writes a static notice.
    const templates = render.match(/innerHTML\s*=\s*`[^`]*\$\{[^`]*`/g) ?? [];
    expect(templates).toEqual([]);
  });
});
