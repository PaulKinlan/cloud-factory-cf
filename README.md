# Cloud Factory CF (`cloud-factory-cf`)

Cloudflare-native autonomous SDLC agent cloud built on Pi, Cloudflare Durable Objects, and `@cloudflare/computer`.

## Architecture Highlights
- **Dual-Runtime**: Runs both at the edge (Cloudflare Durable Objects) and locally on developer machines.
- **Hierarchical Memory**: Org-level & Repo-level persistent memory in Durable Object SQLite.
- **Pluggable Sinks**: Logs and acts across GitHub PRs, Issues, Beads, and Cloud Telemetry.
- **Pi Extension Hooks**: Minimal composable lifecycle hooks inspired by the Pi extension API.
