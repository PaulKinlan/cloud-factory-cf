import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The admin passkey tables render a label that the registrant chose, so the renderer is
 * the security boundary: if it interpolates that value into `innerHTML`, a label like
 * `<img src=x onerror=...>` executes in the operator's (possibly root's) session
 * (cloud-factory-cf-khnm).
 *
 * There is no DOM in this suite by design (see onboarding.test.ts), so the assertion is
 * on the render path itself: the passkey rows must be built with `textContent` and
 * `dataset`, and no passkey field may appear inside an HTML template.
 */
const admin = readFileSync(new URL("../src/admin.ts", import.meta.url), "utf8");

/** The body of `passkeyRow`, the only place a passkey row is built. */
function passkeyRowBody(): string {
  const start = admin.indexOf("const passkeyRow = (");
  expect(start, "passkeyRow must exist - it is the single passkey row builder").toBeGreaterThan(-1);
  // Walk braces from the arrow function's body so the slice is exactly this function.
  const open = admin.indexOf("{", admin.indexOf("): HTMLTableRowElement =>", start));
  let depth = 0;
  for (let i = open; i < admin.length; i += 1) {
    if (admin[i] === "{") depth += 1;
    else if (admin[i] === "}") {
      depth -= 1;
      if (depth === 0) return admin.slice(open, i + 1);
    }
  }
  throw new Error("unbalanced braces after passkeyRow");
}

describe("admin passkey table rendering (cloud-factory-cf-khnm)", () => {
  it("builds passkey cells with textContent, not markup", () => {
    const body = passkeyRowBody();
    expect(body).toContain("textContent");
    // No field is interpolated into an HTML string anywhere in the row builder.
    expect(body).not.toContain("innerHTML");
    expect(body).not.toContain("${");
  });

  it("carries the credential id in dataset rather than in an attribute string", () => {
    const body = passkeyRowBody();
    expect(body).toContain("dataset.id = credentialId");
    expect(body).not.toMatch(/data-id=/);
  });

  it("no longer interpolates a passkey field into either table template", () => {
    // The old shape was tr.innerHTML = `... ${pk.label} ... ${pk.role} ... ${pk.credentialId} ...`
    expect(admin).not.toMatch(/\$\{pk\.label\}/);
    expect(admin).not.toMatch(/\$\{pk\.role\}/);
    expect(admin).not.toMatch(/\$\{pk\.credentialId\}/);
  });

  it("still renders both tables through the safe builder", () => {
    const userTable = admin.slice(admin.indexOf("const loadUserPasskeys"), admin.indexOf("const loadRootPasskeys"));
    const rootTable = admin.slice(admin.indexOf("const loadRootPasskeys"), admin.indexOf("const passkeyRow = ("));
    expect(userTable).toContain("passkeyRow(");
    expect(rootTable).toContain("passkeyRow(");
    // The only innerHTML left in those loaders clears the table or writes a static notice.
    for (const table of [userTable, rootTable]) {
      const templates = table.match(/innerHTML\s*=\s*`[^`]*`/g) ?? [];
      expect(templates).toEqual([]);
    }
  });
});
