# Event & Lifecycle Hooks

Inspired by the minimal composability of the Pi extension API (`session_start`, `tool_call`, `agent_end`), Factory agents hook cleanly into SDLC phases.

## Hook Surface

```typescript
import { SdlcExtensionContext } from "@factory-cloud/sdk";

export default function myAgent(factory: SdlcExtensionContext) {
  // 1. Ingestion & Filtering
  factory.on("event", async (event, ctx) => {
    if (event.type !== "pull_request.opened") return;
    // Inspect event
  });

  // 2. Pre-Execution Hook
  factory.on("before_run", async (run, ctx) => {
    // Setup workspace context or branch
  });

  // 3. Domain Tools Injection
  factory.registerTool({
    name: "audit_schema",
    description: "Validate schema backward compatibility",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    execute: async (args, ctx) => { /* ... */ }
  });

  // 4. Post-Execution Synthesis
  factory.on("after_run", async (result, ctx) => {
    // Emit findings or review verdict to ActionSinks
  });
}
```

## Supported Lifecycle Events
- **Issue Lifecycle**: `issue.opened`, `issue.commented`, `issue.labeled`
- **Code Review**: `pull_request.opened`, `pull_request.synchronize`, `pull_request_review.submitted`
- **CI & Build**: `check_run.completed`, `check_suite.completed`
- **Landing**: `branch.merged`, `pull_request.closed`
- **Cadence**: `schedule.daily`, `schedule.weekly`
