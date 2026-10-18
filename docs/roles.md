# Role Taxonomy & Operational Learnings

Derived from hundreds of autonomous production landings in the Exe.dev Fleet:

1. **The Architect Role (Propose, Never Implement)**:
   - Evaluates system boundaries, ADRs, and interface contracts.
   - Files structured implementation tasks; writes zero application code.

2. **The Implementer Role (Hypothesis-First Bounded Iteration)**:
   - Executes single tasks within bounded turns.
   - Commits progress early; drives verification with executable evidence.

3. **The Reviewer Role (Mandatory Cross-Family Review)**:
   - An independent model family reviews every change (e.g. Claude reviews DeepSeek; Codex reviews Gemini).
   - Verifies reproduction before granting clearance.

4. **The DocSync Agent (Continuous Anti-Drift)**:
   - Audits PRs and commits against `docs/`.
   - Proposes updates when APIs, schemas, or behaviors evolve.
