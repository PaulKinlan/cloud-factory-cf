# Minimal MCP Interface

`cloud-factory-cf` exposes a hyper-minimal 3-tool Model Context Protocol (MCP) surface to allow external orchestrators (such as Exe.dev Fleet Manager, Claude Code, or Codex) to interact with the entire cloud without token bloat.

## The 3 Tools

1. `factory_search`:
   - Search across agents, historical execution runs, repository memory, and open findings.
   - Parameters: `{ query: string, scope?: "agents" | "runs" | "knowledge" | "all" }`

2. `factory_execute`:
   - Universal action dispatcher for triggering reviews, runs, or agent lifecycle commands.
   - Parameters: `{ target: string, action: string, params?: object }`

3. `factory_interact`:
   - Direct conversational interaction with the Factory Architect / Generative Agent Studio.
   - Parameters: `{ session_id?: string, message: string }`
