import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * A repository-wide guard for the class of bug behind cloud-factory-cf-o1os and
 * cloud-factory-cf-khnm: a value the application does not control (a repository name from the
 * GitHub API, a passkey label the registrant chose) interpolated into markup and executed in
 * an admin page - root's session on a factory deployment.
 *
 * Scope, stated honestly after a reviewer mutation-tested the first version: this is a
 * source-level heuristic, not a parser and not a browser. It decides what an assignment to a
 * markup sink is really being given -
 *
 *   el.innerHTML = ''                       static, allowed
 *   el.innerHTML = '<div class="muted">'    static, allowed
 *   el.innerHTML = `<b>${x}</b>`            refused: interpolation
 *   el.innerHTML = '<b>' + x                refused: concatenation
 *   el.innerHTML = rows.map(f).join('')     refused: computed, whatever it computes
 *   el.insertAdjacentHTML('beforeend', s)   refused: always a sink when given a value
 *
 * i.e. a markup sink may be cleared or given a constant string literal and nothing else. What
 * it cannot see: the same value reaching the DOM through a helper in another module,
 * `srcdoc`, `DOMParser`, `createContextualFragment`, and a static string that a bundler later
 * rewrites. Those are named here rather than implied, so the claim matches the check.
 */
const SRC = new URL("../src/", import.meta.url);

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

export interface Violation {
  readonly rule: string;
  readonly evidence: string;
}

/**
 * The rules, as functions over source text so they can be tested on snippets: a detector that
 * is only ever pointed at code that happens to be clean proves nothing (the reviewer's point).
 */
/** Reads a string literal starting at `start` (a quote), honouring escapes. */
function readLiteral(code: string, start: number): { text: string; end: number } {
  const quote = code[start]!;
  let i = start + 1;
  while (i < code.length) {
    const char = code[i];
    if (char === "\\") {
      i += 2;
      continue;
    }
    if (char === quote) return { text: code.slice(start + 1, i), end: i + 1 };
    i += 1;
  }
  return { text: code.slice(start + 1), end: code.length };
}

export function findMarkupSinks(source: string): Violation[] {
  const code = stripComments(source);
  const found: Violation[] = [];

  // Walk each assignment by hand rather than with one regex: the right-hand side may be a
  // literal containing ';' or '=' (an inline style, for instance), and truncating it at the
  // first semicolon is how the first version produced a false positive on a static notice.
  const assignment = /\.(innerHTML|outerHTML)\s*(\+?=)/g;
  let match: RegExpExecArray | null;
  while ((match = assignment.exec(code)) !== null) {
    const sink = match[1]!;
    const operator = match[2]!;
    let i = assignment.lastIndex;
    while (i < code.length && /\s/.test(code[i]!)) i += 1;
    const quote = code[i];
    const evidence = code.slice(match.index, Math.min(match.index + 120, code.length)).split("\n")[0]!.trim();

    if (operator === "+=") {
      found.push({ rule: `${sink} appended to`, evidence });
      continue;
    }
    if (quote === '"' || quote === "'" || quote === "`") {
      const literal = readLiteral(code, i);
      if (quote === "`" && literal.text.includes("${")) {
        found.push({ rule: `${sink} assigned a template with an interpolation`, evidence });
        assignment.lastIndex = literal.end;
        continue;
      }
      // A literal is only safe on its own: '<b>' + name builds markup from a value just as
      // surely as a template does, and missing that was one of the reviewer's mutations.
      let after = literal.end;
      while (after < code.length && /\s/.test(code[after]!)) after += 1;
      if (code[after] === "+") {
        found.push({ rule: `${sink} assigned a concatenation`, evidence });
        const end = code.indexOf(";", after);
        assignment.lastIndex = end === -1 ? code.length : end;
        continue;
      }
      assignment.lastIndex = literal.end;
      continue;
    }
    // Anything that is not a literal - a variable, a concatenation, rows.map(...).join('') -
    // is computed markup and refused whatever it computes.
    const end = code.indexOf(";", i);
    const rhs = code.slice(i, end === -1 ? Math.min(i + 80, code.length) : end).trim();
    found.push({ rule: `${sink} assigned a computed value`, evidence: `${evidence} [rhs: ${rhs.slice(0, 60)}]` });
    assignment.lastIndex = end === -1 ? code.length : end;
  }

  const sinks: Array<{ name: string; pattern: RegExp }> = [
    { name: "insertAdjacentHTML", pattern: /insertAdjacentHTML\s*\(/g },
    { name: "document.write", pattern: /document\.write(?:ln)?\s*\(/g },
    { name: "createContextualFragment", pattern: /createContextualFragment\s*\(/g },
    { name: "DOMParser", pattern: /new\s+DOMParser\s*\(/g },
    { name: "srcdoc", pattern: /\.srcdoc\s*=/g },
  ];
  for (const { name, pattern } of sinks) {
    for (const hit of code.matchAll(pattern)) {
      found.push({ rule: name, evidence: hit[0].trim() });
    }
  }
  return found;
}

const files = readdirSync(SRC)
  .filter((name: string) => name.endsWith(".ts"))
  .sort();

describe("the markup-sink detector itself (cloud-factory-cf-x0xv)", () => {
  // The reviewer's mutations: each is a real way a value reaches markup, and the first version
  // of the rules let all three through.
  const mustCatch: Array<[string, string]> = [
    ["computed list", "list.innerHTML = rows.map((r) => `<b>${r}</b>`).join('');"],
    ["concatenation", "el.innerHTML = '<b>' + name + '</b>';"],
    ["plain assignment of a variable", "el.innerHTML = markup;"],
    ["append", "el.innerHTML += '<b>x</b>';"],
    ["adjacent html", "el.insertAdjacentHTML('beforeend', row);"],
    ["srcdoc", "frame.srcdoc = html;"],
    ["contextual fragment", "range.createContextualFragment(html);"],
  ];
  for (const [name, snippet] of mustCatch) {
    it(`catches ${name}`, () => {
      expect(findMarkupSinks(snippet).length).toBeGreaterThan(0);
    });
  }

  const mustAllow: string[] = [
    "el.innerHTML = '';",
    "tbody.innerHTML = '<tr><td colspan=\"3\">Nothing here</td></tr>';",
    "container.textContent = label;",
  ];
  it("still allows clearing a container or writing a fixed string", () => {
    for (const snippet of mustAllow) expect(findMarkupSinks(snippet)).toEqual([]);
  });
});

describe("apps/web never assembles markup from data (cloud-factory-cf-o1os)", () => {
  it("scans every source file, so a new module is covered by default", () => {
    expect(files.length).toBeGreaterThan(5);
    expect(files).toContain("admin.ts");
  });

  it("has no markup sink fed anything but a constant string", () => {
    const offenders = files.flatMap((file: string) =>
      findMarkupSinks(readFileSync(new URL(file, SRC), "utf8")).map((v) => `${file}: ${v.rule} — ${v.evidence}`),
    );
    expect(offenders, "use textContent/setAttribute instead (see admin.ts repoItem)").toEqual([]);
  });
});
