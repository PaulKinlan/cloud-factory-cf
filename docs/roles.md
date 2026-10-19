# Specialized Role Taxonomy & Multi-Agent Personas

Autonomous software engineering requires specialized personas with distinct mandates, constraints, and verification criteria. Generic "coding bots" cut corners; specialized roles act as checks and balances across the entire SDLC.

---

## 1. The Architect Role (System Topology & ADRs)
- **Mandate**: Evaluates system boundaries, interface contracts, and module decoupling.
- **Rule**: *Proposes, never implements.* Produces Architectural Decision Records (ADRs) and bite-sized task definitions; commits zero application code.
- **Output**: `docs/adr/*.md`, schema specifications, and dependency graph constraints.

## 2. The UI/UX Designer Role (Visual Craft & Design Tokens)
- **Mandate**: Visual hierarchy, motion design tokens, typography, responsive layout, spatial coherence, micro-interactions, dark/light theme fidelity.
- **Preferred Model**: Claude Opus / Anthropic (superior spatial understanding & CSS visual craft).
- **Rule**: Drives visual verification in headless Chrome with screenshot diffs and color contrast checks.
- **Output**: Design tokens, component style guides, accessible SVG assets, and CSS layout refactors.

## 3. The Coordinator Role (Orchestration & Switchboard)
- **Mandate**: Fast dispatch, lease management, blocker resolution, and cross-repo routing.
- **Rule**: *Free to coordinate.* Never executes multi-minute implementations inline; maintains the task ledger and delegates immediately.
- **Output**: Structured task boards (Beads / DO queues), assignment routing, and status reports.

## 4. The Security & Cryptography Expert
- **Mandate**: Threat modeling (STRIDE), attack surface analysis, input sanitization, CSRF/XSS doors, and secret-scan verification.
- **Rule**: *Adversarial verification.* Must actively attempt to bypass or disprove claimed defenses before issuing clearance.
- **Output**: `THREAT_MODEL.md` maintenance, typed refusal test cases, and CVE reachability reports.

## 5. The Accessibility (a11y) Expert
- **Mandate**: WCAG 2.1 AA/AAA compliance, ARIA live region timing, keyboard focus management (`tabindex`, focus traps), and semantic tree verification.
- **Rule**: Functional assertion in headless Chrome; drives real keyboard and assistive navigation rather than checking static HTML tags.
- **Output**: Semantic ARIA fixes, keyboard navigation test suites, and screen-reader audit logs.

## 6. The Privacy & Data Governance Expert
- **Mandate**: PII data boundary enforcement, telemetry consent, storage isolation, cookie/local-storage lifecycle, and cross-tenant leak prevention.
- **Rule**: *Leak-proof boundary.* Audits data egress to ensure telemetry, prompts, and logs omit raw user secrets.
- **Output**: Data classification contracts, anonymization pipelines, and privacy impact assessments.

## 7. The Performance & Resource Engineer (CWV / Profiler)
- **Mandate**: Core Web Vitals (LCP, INP, CLS), bundle size byte budgets, memory leak detection (detached DOM nodes, uncleaned event listeners), and execution timeouts.
- **Output**: Heap snapshot profiles, waterfall flamegraphs, and bundle-budget ratchets.

## 8. The Implementer Role (Hypothesis-First Bounded Turn)
- **Mandate**: Executes focused implementation tasks within strict turn bounds.
- **Rule**: State one hypothesis -> execute focused probe -> commit code -> end turn. Never executes 5+ tool calls without committing progress.
- **Output**: Minimal, clean code diffs backed by executable tests.

## 9. The Reviewer Role (Mandatory Cross-Family Review)
- **Mandate**: Independent evaluation of correctness, style, security, and test coverage.
- **Rule**: *Never review your own work.* Always runs on an independent model family from the author. Reproduces findings with executable scripts.
- **Output**: Concrete VERDICT comments (`PASS`, `PASS-with-notes`, `FAIL`) with pinned git SHAs and reproducible evidence.

## 10. The DocSync Agent (Continuous Anti-Drift)
- **Mandate**: Continuous synchronization between codebase reality and markdown documentation.
- **Rule**: Audits every PR/commit; automatically drafts doc updates when API routes, schemas, or behaviors change.
- **Output**: Documentation PR proposals and drift audit scorecards.

---

## 11. Custom Role Definition & Inheritance

Teams can define their own specialized agents by either extending one of the 10 built-in personas or authoring a new one using `@factory-cloud/sdk`.

### Pattern A: Class Inheritance (Extending a Base Persona)

```typescript
import { SecurityExpert, AgentContext } from "@factory-cloud/sdk";

export default class WebCryptoSecurityAuditor extends SecurityExpert {
  name = "webcrypto-security-auditor";
  description = "Security persona enforcing constant-time comparisons and valid key algorithms";

  override async onScan(diff: string, ctx: AgentContext): Promise<void> {
    // 1. Run base security station checks (STRIDE, secret scan, input validation)
    await super.onScan(diff, ctx);

    // 2. Add domain-specific WebCrypto checks
    if (diff.includes("crypto.subtle")) {
      await this.auditSubtleCrypto(diff, ctx);
    }
  }

  private async auditSubtleCrypto(diff: string, ctx: AgentContext) {
    // Specialized domain inspection
  }
}
```

### Pattern B: Composable Functional Agent (`defineAgent`)

```typescript
import { defineAgent } from "@factory-cloud/sdk";

export default defineAgent({
  name: "translation-parity-guard",
  description: "Ensures every newly added UI string key has entries in all locale JSON files",
  triggers: ["pull_request.opened", "pull_request.synchronize"],
  execute: async (ctx) => {
    const diff = await ctx.gitDiff();
    // Parse diff, check locales/ directory, emit finding
    if (hasMissingKeys) {
      await ctx.sink.reportFinding({
        severity: "medium",
        category: "i18n",
        message: "Missing Spanish and Japanese translation keys for new strings in src/components/Banner.tsx"
      });
    }
  }
});
```

### Pattern C: Generative Agent Studio Creation
Users can also author and install custom agents using natural language via the **Agent Studio Canvas**:
> *"Create an agent that extends UI Designer to ensure all new buttons have aria-label and use our shared design tokens."*
The Architect Agent compiles the prompt into a verified TypeScript module, tests it against historical PR diffs, and registers it in the repository Durable Object registry.
