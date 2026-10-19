# `@factory-cloud/web` — agent canvas

An infinite, Isocan-style canvas for wiring an agent run together: drag **event
sources** (GitHub/GitLab events), **agents** (prompt + model), **memory hubs**
(org/repo scope) and **action sinks** (PR review, issue comment, beads, telemetry)
onto the board and connect them. The layout is local-first (persisted in
`localStorage`) and **Export config** produces the artifact the control plane
consumes.

## What it does

- **Add** nodes from the toolbar, **drag** them, **pan** with the background,
  **zoom** with the wheel (zoom stays anchored under the cursor).
- **Connect** with the *Connect* toggle: click the upstream node, then the
  downstream node. Allowed wiring is enforced in the model, not just the UI:
  | from \ to | agent | memory | sink |
  | --- | --- | --- | --- |
  | source | ✅ | ❌ | ❌ |
  | agent | ❌ | ✅ | ✅ |
  | memory | ✅ | ❌ | ❌ |
  | sink | ❌ | ❌ | ❌ |
- **Edit** the selected node in the inspector (name, prompt/model, provider/event,
  memory scope, sink type). Changes are persisted as you type.
- **Export config** opens the exact JSON handed to the control plane, with copy and
  download actions.
- **Keyboard**: `Tab`/`Shift+Tab` move between nodes and fields, `Enter`/`Space`
  activates a node (select, or the second half of a connection), arrows nudge the
  selected node by 8px (`Shift` = 32px), `Delete` removes it, `Esc` cancels connect
  mode. Every action is announced through an `aria-live` status region.

## Exported contract

Edges are collapsed into the agent they belong to, so the layout never leaks into
runtime configuration:

```json
{
  "agents": [
    {
      "id": "n-c1afa36a",
      "name": "PR reviewer",
      "prompt": "Review the pull request…",
      "model": "deepseek/deepseek-flash",
      "sources": [{ "id": "n-b389ce01", "label": "Pull requests", "config": { "provider": "github", "event": "pull_request" } }],
      "memory": [{ "id": "n-cebc31ff", "label": "Repo memory", "config": { "scope": "repo" } }],
      "sinks": [{ "id": "n-e6089093", "label": "GitHub review", "config": { "type": "github-pr-review" } }]
    }
  ]
}
```

Parsing is defensive: `parseDoc` rejects a wrong `version`, non-finite
coordinates, unknown node kinds, edges pointing at missing nodes, self-links and
duplicate edges, so a corrupted or hand-edited `localStorage` entry cannot crash
the canvas.

## Running it

```bash
npm run dev -w @factory-cloud/web       # Vite dev server on :5173
npm run build -w @factory-cloud/web     # static bundle in apps/web/dist
npm run preview -w @factory-cloud/web   # serve the built bundle on :4173
npm test -w @factory-cloud/web          # model unit tests (Node, no browser)
```

Deployment is an assets-only Worker (`wrangler.jsonc`, name
`cloud-factory-canvas`) so the canvas can ship without touching the API Worker's
routing or Durable Object migrations:

```bash
npm run deploy -w @factory-cloud/web
```

Serving the canvas from the main Worker (single origin with `/webhooks`,
`/broker`) is a follow-up, tracked as its own bead.

## Layout

```
src/model.ts   Pure document model: nodes, edges, wiring rules, view maths,
               serialize/parse, toAgentConfig()
src/main.ts    DOM renderer + interactions (pan, zoom, drag, connect, inspector,
               persistence, export)
src/styles.css Dark canvas theme, node accents per kind, reduced-motion support
test/model.test.ts  10 tests over the model (ids injected, no DOM)
```

The model is deliberately DOM-free: the same rules are unit-tested in Node and
reused by the renderer, and the exported contract is testable without a browser.
