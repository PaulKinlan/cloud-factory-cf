# Architecture & Design Principles

`cloud-factory-cf` is a multi-tenant, hosted AI software engineering platform deployed natively to the Cloudflare edge with an optional local CLI daemon.

## 1. Hexagonal Ports-and-Adapters Model
The core package `@factory-cloud/sdk` is a dependency-free microkernel declaring types, event interfaces, and lifecycle hooks. The outside world (`apps/worker`, `packages/cli`, `packages/canvas-ui`) implements ports:
- **ActionSink**: GitHub PR reviews, Issues, Beads, and Cloud Telemetry.
- **MemoryStore**: Cloudflare Durable Object SQLite (edge) vs Local SQLite file (workstation).
- **CapabilityBroker**: Exe.dev-style signed capability proxies (zero raw secrets in agent prompts).
- **AgentRuntimeDriver**: Swappable execution driver (Cloudflare Durable Objects, portable `celld`, or local Linux sandbox).

## 2. Edge Control Plane
- **RepoCoordinator DO**: Dedicated per-repository Durable Object (`idFromName("<org>/<repo>")`) managing webhook event deduplication, queue leases, and GitHub comment threading.
- **OrgCoordinator DO**: Manages organization-wide settings, shared memory, and agent registries.
- **CredentialBroker DO**: Scoped capability broker providing signed ephemeral handles for GitHub API and LLM inference.
