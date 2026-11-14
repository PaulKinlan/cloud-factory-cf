import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
 * i.e. a markup sink may be cleared or given a constant string literal and nothing else. The
 * attribute form is covered too: `setAttribute` is refused when its first argument is not a
 * literal (a name the source does not fix cannot be vouched for) or names a sink - `srcdoc`,
 * `on*`, `srcset`, `formaction`, `action`, `xlink:href`, `style` - and a `javascript:` or
 * `data:text/html` scheme literal is refused wherever it appears, which is how an `href` or
 * `src` given a script URL is caught (cloud-factory-cf-k974).
 *
 * A URL sink (`href`, `src`, `action`) is decided by its value, so the value is checked
 * (cloud-factory-cf-ww20): a string or template that starts with a relative, fragment, query or
 * `https://` prefix has its scheme fixed by construction and is allowed; so is a conditional
 * whose branches are all allowed, and `URL.createObjectURL` (a blob of this page's own data).
 * A value the source merely *names* - a variable, a property, an index - is refused, because
 * nothing in the source proves which scheme it carries.
 *
 * What it still cannot see, named here rather than implied so the claim matches the check: the
 * return value of a helper call (the helper's own file is scanned, but a `return` is not a
 * sink), a scheme assembled from parts that never appear as one literal, a static string a
 * bundler later rewrites, a member named by a variable (`el[name] = value`, which is only a
 * sink when the name resolves to one) and a sink copied in by spread (`el = { ...el, innerHTML:
 * value }`).
 */
const SRC = new URL("../src/", import.meta.url);

/**
 * Removes comments without touching the contents of string and template literals
 * (cloud-factory-cf-149p). Stripping with a regex over raw source let a literal containing
 * `/*` swallow every sink up to the next `*\/` - a silent false green, which is the one thing a
 * guard may not do.
 */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const char = source[i]!;
    if (char === '"' || char === "'" || char === "`") {
      const literal = readLiteral(source, i);
      out += source.slice(i, literal.end);
      i = literal.end;
      continue;
    }
    if (char === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (char === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    out += char;
    i += 1;
  }
  return out;
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

/**
 * The text between `openParen` and its matching close, honouring literals
 * (cloud-factory-cf-kdfh), so a rule about a call's arguments cannot be fooled by a `)` in a
 * string or by an earlier, unrelated call.
 */
function callArguments(code: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < code.length; i += 1) {
    const char = code[i]!;
    if (char === '"' || char === "'" || char === "`") {
      i = readLiteral(code, i).end - 1;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return code.slice(openParen + 1, i);
    }
  }
  return code.slice(openParen + 1);
}

/**
 * Whether every argument of a call whose `(` is at `openParen` is a plain string literal, so
 * whatever the method is, its result is still a constant (cloud-factory-cf-kdfh). This is what
 * separates `'<b>'.trim()` from `'<b>'.concat(name, '</b>')`: the second builds markup from a
 * value, and the first version of this guard only knew how to catch the `+` spelling of it.
 */
function argsAreLiterals(code: string, openParen: number): boolean {
  let i = openParen + 1;
  let depth = 0;
  let expectArgument = true;
  while (i < code.length) {
    const char = code[i]!;
    if (/\s/.test(char)) {
      i += 1;
      continue;
    }
    if (char === ")" && depth === 0) return true;
    if (char === "," && depth === 0) {
      expectArgument = true;
      i += 1;
      continue;
    }
    if (expectArgument) {
      if (char !== '"' && char !== "'" && char !== "`") return false;
      const literal = readLiteral(code, i);
      // A template with an interpolation is not a constant whatever its arguments are.
      if (literal.text.includes("${")) return false;
      expectArgument = false;
      i = literal.end;
      continue;
    }
    // A literal argument followed by anything but `,` or `)` - an operator, typically - is an
    // expression built from a value.
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" && depth > 0) depth -= 1;
    else if (char === "]" || char === "}") depth -= 1;
    else return false;
    i += 1;
  }
  return false;
}

/** A URL prefix that fixes the scheme by construction. */
const SAFE_URL_PREFIX = /^(?:\/|#|\?|\.\.?\/|https:\/\/)/;

/**
 * Whether a URL sink may be given this value (cloud-factory-cf-ww20). `start` is the index of
 * the first character of the right-hand side; `code` is comment-stripped source.
 *
 * The rule is about what the source *proves*: a leading literal fixes the scheme, so anything
 * appended to it cannot turn it into `javascript:`. A conditional proves as much as its
 * branches do. A call is a helper this guard scans in its own file. A bare name proves nothing
 * and is refused.
 */
function urlValueAllowed(code: string, start: number, depth = 0): boolean {
  let i = start;
  while (i < code.length && /\s/.test(code[i]!)) i += 1;
  const quote = code[i];
  if (quote === '"' || quote === "'" || quote === "`") {
    const literal = readLiteral(code, i);
    return SAFE_URL_PREFIX.test(literal.text);
  }
  // A conditional: allowed when every branch is. Find the top-level `?` and its `:`.
  if (depth < 3) {
    let nest = 0;
    let question = -1;
    for (let j = i; j < code.length; j += 1) {
      const char = code[j]!;
      if (char === '"' || char === "'" || char === "`") {
        j = readLiteral(code, j).end - 1;
        continue;
      }
      if (char === "(" || char === "[" || char === "{") nest += 1;
      else if (char === ")" || char === "]" || char === "}") nest -= 1;
      // `?.` is optional chaining, not a conditional, and the branches of a ternary are
      // routinely written on their own lines - so only `;` ends the search.
      else if (nest === 0 && char === "?" && code[j + 1] !== ".") { question = j; break; }
      else if (nest === 0 && char === ";") return bareUrlValueAllowed(code, i);
    }
    if (question !== -1) {
      let branchNest = 0;
      for (let j = question + 1; j < code.length; j += 1) {
        const char = code[j]!;
        if (char === '"' || char === "'" || char === "`") {
          j = readLiteral(code, j).end - 1;
          continue;
        }
        if (char === "(" || char === "[" || char === "{") branchNest += 1;
        else if (char === ")" || char === "]" || char === "}") branchNest -= 1;
        else if (branchNest === 0 && char === ";") break;
        else if (branchNest === 0 && char === ":") {
          return (
            urlValueAllowed(code, question + 1, depth + 1) && urlValueAllowed(code, j + 1, depth + 1)
          );
        }
      }
    }
  }
  return bareUrlValueAllowed(code, i);
}

/** The non-literal shapes: a call is scanned where it is defined, anything else proves nothing. */
function bareUrlValueAllowed(code: string, start: number): boolean {
  const rest = code.slice(start).trimStart();
  if (rest.startsWith("URL.createObjectURL(")) return true;
  // `name(` is a call: the helper's own file is scanned by this guard.
  return /^[A-Za-z_$][\w$.]*\s*\(/.test(rest);
}

export function findMarkupSinks(source: string): Violation[] {
  const code = stripComments(source);
  const found: Violation[] = [];

  // Walk each assignment by hand rather than with one regex: the right-hand side may be a
  // literal containing ';' or '=' (an inline style, for instance), and truncating it at the
  // first semicolon is how the first version produced a false positive on a static notice.
  // `=` only when it is not a comparison (cloud-factory-cf-czx0): `==`, `===`, `!=` and
  // `!==` read the element, they do not write it, and refusing a read made the guard look
  // arbitrary to whoever hit it.
  // The same write with a bracket-quoted member name, `el['innerHTML'] = payload`, used to be
  // invisible to this rule (cloud-factory-cf-kdfh): the sink is chosen by the name, not by the
  // punctuation that reaches it.
  const assignment =
    /(?:\.(innerHTML|outerHTML)|\[\s*(["'`])(innerHTML|outerHTML)\2\s*\])\s*(\+?=)(?!=)/g;
  let match: RegExpExecArray | null;
  while ((match = assignment.exec(code)) !== null) {
    const sink = (match[1] ?? match[3])!;
    const operator = match[4]!;
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
      // `'<b>'.concat(name, '</b>')` builds markup from a value the same way `'<b>' + name`
      // does (cloud-factory-cf-kdfh). A method call on the literal is only a constant when
      // every argument is itself a literal - `' x '.trim()` is, `'<b>'.concat(name)` is not.
      const method = /^\.\s*[A-Za-z_$][\w$]*\s*\(/.exec(code.slice(after));
      if (method !== null && !argsAreLiterals(code, after + method[0].length - 1)) {
        found.push({ rule: `${sink} assigned a literal built from a value`, evidence });
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

  // `Object.assign(el, { innerHTML: payload })` writes the same sink with no assignment
  // operator at all (cloud-factory-cf-kdfh). The property name is what makes it a sink, so
  // the name is what is looked for inside the call's own arguments.
  for (const match of code.matchAll(/Object\.assign\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    if (!/(?:^|[{,\s])["'`]?(?:innerHTML|outerHTML)["'`]?\s*[:,}]/.test(callArguments(code, open))) continue;
    const evidence = code.slice(match.index, Math.min(match.index + 120, code.length)).split("\n")[0]!.trim();
    found.push({ rule: "markup sink handed to Object.assign", evidence });
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

  // The attribute form of the same problem (cloud-factory-cf-k974). `setAttribute` is where
  // the o1os fix put data, so it has to be held to the same rule as the markup sinks: the
  // name may not be dynamic, and it may not be one of the names that turn a value into
  // behaviour. `href`/`src` are covered by the scheme rule below, because for them the value
  // decides and the name does not.
  const sinkAttributes = new Set(["srcdoc", "srcset", "formaction", "action", "xlink:href", "style"]);
  for (const match of code.matchAll(/\.setAttribute\s*\(/g)) {
    let i = match.index + match[0].length;
    while (i < code.length && /\s/.test(code[i]!)) i += 1;
    const quote = code[i];
    const evidence = code.slice(match.index, Math.min(match.index + 120, code.length)).split("\n")[0]!.trim();
    if (quote !== '"' && quote !== "'" && quote !== "`") {
      found.push({ rule: "setAttribute named by a value", evidence });
      continue;
    }
    const literal = readLiteral(code, i);
    const name = literal.text.toLowerCase();
    if (sinkAttributes.has(name) || name.startsWith("on")) {
      found.push({ rule: `setAttribute('${literal.text}')`, evidence });
    }
  }

  // A URL sink is decided by its value (cloud-factory-cf-ww20): `link.href = untrustedUrl` was
  // green, and the value is exactly what the browser executes on click. The property form and
  // the attribute form are held to the same rule.
  const urlAssignment = /(?:\.(href|src|action|formAction)|\[\s*(["'`])(href|src|action|formAction)\2\s*\])\s*=(?!=)\s*/gi;
  for (const match of code.matchAll(urlAssignment)) {
    if (!urlValueAllowed(code, match.index + match[0].length)) {
      const evidence = code.slice(match.index, Math.min(match.index + 120, code.length)).split("\n")[0]!.trim();
      found.push({ rule: `${match[1] ?? match[3]} assigned a value whose scheme is not fixed`, evidence });
    }
  }
  for (const match of code.matchAll(/\.setAttribute\s*\(\s*["'](href|src|action|formaction)["']\s*,/gi)) {
    if (!urlValueAllowed(code, match.index + match[0].length)) {
      const evidence = code.slice(match.index, Math.min(match.index + 120, code.length)).split("\n")[0]!.trim();
      found.push({ rule: `setAttribute('${match[1]}') given a value whose scheme is not fixed`, evidence });
    }
  }

  // A URL that carries script, in whatever API it reaches the DOM. `href`/`src` are only as
  // safe as their scheme and this guard is not a URL parser, so the two schemes that execute
  // are refused outright.
  for (const hit of code.matchAll(/["'`](?:\s*javascript|\s*data:text\/html)\s*:/gi)) {
    found.push({ rule: "script URL scheme", evidence: hit[0].trim() });
  }
  return found;
}

/**
 * Every `.ts` file under `src/`, relative to it, sorted (cloud-factory-cf-149p). Recursive: a
 * future `src/<subdir>/` is covered by default, which is what the standalone claim below says
 * and what a non-recursive listing quietly did not do.
 */
export function sourceFiles(dir: URL): string[] {
  return readdirSync(dir, { recursive: true })
    .filter((name: string) => name.endsWith(".ts"))
    .sort();
}

const files = sourceFiles(SRC);

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
    // cloud-factory-cf-k974: the attribute form of the same sink, and the name a value can
    // supply for itself.
    ["srcdoc through the attribute form", "frame.setAttribute('srcdoc', html);"],
    ["an event handler attribute", "img.setAttribute('onerror', code);"],
    ["an attribute named by a value", "element.setAttribute(name, value);"],
    ["a script URL", "link.setAttribute('href', 'javascript:' + target);"],
    ["a script URL as a template", "link.href = `javascript:${target}`;"],
    ["inline style", "card.setAttribute('style', injected);"],
    // cloud-factory-cf-ww20: the value of a URL sink, which is what the browser executes.
    ["href named by a variable", "link.href = untrustedUrl;"],
    ["href read off an object", "link.href = row.url;"],
    ["src from an index", "img.src = candidates[0];"],
    ["href given a variable through the attribute form", "link.setAttribute('href', untrustedUrl);"],
    // cloud-factory-cf-kdfh: the three spellings that reached a markup sink without using the
    // operator or the member access the earlier rules keyed on.
    ["a literal built by a method call", "el.innerHTML = '<b>'.concat(name, '</b>');"],
    ["a bracket-quoted sink name", "el['innerHTML'] = payload;"],
    ["markup handed to Object.assign", "Object.assign(el, { innerHTML: payload });"],
    ["a bracket-quoted URL sink", "link['href'] = untrustedUrl;"],
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
    // cloud-factory-cf-czx0: reading a sink is not writing it, whichever way the comparison is
    // spelled. The guard used to refuse `===` and allow `!==`, which made the failure look
    // arbitrary and invited the comparison to be written the other way round.
    "if (el.innerHTML === '<b>x</b>') { go(); }",
    "const same = el.innerHTML == '';",
    "const other = el.innerHTML !== '';",
    // cloud-factory-cf-k974: an inert attribute, written by name, with a value. This is the
    // shape the o1os fix uses on the admin surface.
    "element.setAttribute('data-owner', r.owner);",
    "element.setAttribute('aria-label', `Remove ${label}`);",
    "link.setAttribute('href', '/?owner=' + encodeURIComponent(owner));",
    // cloud-factory-cf-ww20: URL values whose scheme is fixed by construction, or whose shape
    // the guard explicitly trusts.
    "link.href = '/?owner=' + encodeURIComponent(owner);",
    "(el as HTMLAnchorElement).href = `/?owner=${encodeURIComponent(row.owner)}&repo=${encodeURIComponent(row.repo)}`;",
    "installLink.href = scope === null ? '/auth/github/login' : `/auth/github/login?owner=${encodeURIComponent(scope.owner)}`;",
    "anchor.href = URL.createObjectURL(blob);",
    "installLink.href = installUrl(slug);",
    "link.href = 'https://example.com/docs';",
    // cloud-factory-cf-kdfh: refusing every method call on a literal would be a false positive,
    // because a call whose arguments are all literals still produces a constant. Only a call
    // given a value is a sink.
    "el.innerHTML = '   '.trim();",
    "Object.assign(flags, { ready: true });",
    "Object.assign(state, row);",
  ];
  it("still allows clearing a container, fixed strings and inert attributes", () => {
    for (const snippet of mustAllow) expect(findMarkupSinks(snippet)).toEqual([]);
  });

  // cloud-factory-cf-149p: a literal containing a comment opener used to delete every sink
  // after it, so the guard reported green on markup it had never looked at.
  it("does not treat a comment opener inside a string literal as a comment", () => {
    const source = 'const open = "/*";\nel.innerHTML = `<b>${x}</b>`;\nconst close = "*/";';
    expect(findMarkupSinks(source).map((v) => v.rule)).toContain(
      "innerHTML assigned a template with an interpolation",
    );
  });

  // ...and the scan is recursive, so a new src/<subdir>/ is covered without anyone
  // remembering to widen it.
  it("walks subdirectories, so a nested module is scanned too", () => {
    const root = mkdtempSync(join(tmpdir(), "web-guard-"));
    try {
      mkdirSync(join(root, "nested"), { recursive: true });
      writeFileSync(join(root, "top.ts"), "export const a = 1;\n");
      writeFileSync(join(root, "nested", "deep.ts"), "export const b = 2;\n");
      writeFileSync(join(root, "nested", "styles.css"), "body { margin: 0; }\n");
      expect(sourceFiles(new URL(`file://${root}/`))).toEqual(["nested/deep.ts", "top.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
