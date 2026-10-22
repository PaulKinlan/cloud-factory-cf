# Cloud Factory CF Documentation

Welcome to the **Cloud Factory CF** architectural and developer documentation.

## Core Documentation
- [Architecture & Design Principles](./architecture.md): The Dual-Runtime, Durable Objects, and Ports-and-Adapters model.
- [Role Taxonomy & Learnings](./roles.md): Hard-won operational lessons from multi-agent fleets (Architect, Implementer, Reviewer, DocSync).
- [Event & Lifecycle Hooks](./lifecycle.md): Minimal Pi-inspired extension hook model for SDLC agents.
- [Minimal MCP Interface](./mcp.md): 3-tool integration surface for external coding harnesses.
- [Credentials & Security Broker](./credentials.md): Exe.dev-style secretless capability proxy.
- [Local Dogfooding Guide](./dogfooding.md): Running agents locally before pushing.
- [Speed & Landing Throughput](./speed.md): Sub-15s fast-gate budget and collision-proof testing.

## Architecture Decision Records
- [ADR 003](./adr-003-multi-platform-dev-adapters.md): Universal DevPlatform adapters — one platform-neutral event, one adapter per forge.
- [ADR 006](./adr-006-multi-tenant-accounts.md): Hierarchical multi-tenant accounts — platform owner, customer org admin, end user, and the machine key they replace.
