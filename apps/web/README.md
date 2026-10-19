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

## Sharing a layout (repository documents)

**Share…** stores the layout with a repository through the document API
(`/canvas/:owner/:repo/documents`, see the root README). The form takes
`owner/repo`, a control key and a document name:

- **Save to repository** `PUT`s the exported document (creating on first save,
  updating the same id after that), then refreshes the list.
- Document ids are kept **per repository**: Save only updates in place when the
  current canvas was loaded from, or last saved to, the repository being saved
  to. Otherwise it creates a new document and says so in the status line, so
  editing the repository field can never overwrite another repository's layout.
- The repository a canvas belongs to is persisted **with the canvas** in
  `localStorage`, so a reload restores both together. A canvas restored from an
  older format (document only) has no binding, and a save then creates a copy
  rather than overwriting a restored id.
- **Refresh list** shows the repository's stored documents; **Load** replaces the
  current canvas with one of them (validated through the same `parseDoc` the
  local copy uses) and writes it back to `localStorage`.
- The control key lives **in memory only** — it is never written to
  `localStorage`, `sessionStorage` or the exported JSON. The per-repository
  document ids and the document name survive a reload in `sessionStorage`.
- Failures are reported in the dialog (key rejected, no key on the deployment,
  repository at its document limit, unreachable API) instead of the console, and
  a failed load leaves the current canvas untouched.

`src/sync.ts` holds the request builders and response parsers, so the wiring is
unit-tested (12 tests) without a DOM.

## Serving it

The canvas is served by the API Worker itself (`apps/worker/wrangler.jsonc`):
`assets.directory` points at `apps/web/dist`, `assets.binding` is `ASSETS`, and
`run_worker_first: true` sends every request through the Worker, whose `fetch`
delegates non-API paths to the asset binding. That means one origin for the
canvas and the API (`/`, `/assets/*`, `/health`, `/webhooks/*`, `/broker/*`), one
routing path to reason about, and no SPA fallback: unknown paths stay a 404 and
non-GET/HEAD requests to asset paths are 405.

```bash
npm run dev -w @factory-cloud/worker   # http://localhost:8787 serves the canvas
```

`apps/worker` builds the canvas before its own dry-run deploy and before its
tests (`prebuild` / `pretest`), so `npm run ci` at the root always has a fresh
`dist` to serve and to test.

## Layout

```
src/model.ts   Pure document model: nodes, edges, wiring rules, view maths,
               serialize/parse, toAgentConfig()
src/main.ts    DOM renderer + interactions (pan, zoom, drag, connect, inspector,
               persistence, export)
src/styles.css Dark canvas theme, node accents per kind, reduced-motion support
test/model.test.ts  10 tests over the model (ids injected, no DOM)

The boundary between the canvas and the API is pinned by
`apps/worker/test/assets.test.ts`: `/` serves the canvas HTML, `/health` and
`/webhooks/*` still reach the Worker, and unknown paths stay 404 (not HTML).
```

The model is deliberately DOM-free: the same rules are unit-tested in Node and
reused by the renderer, and the exported contract is testable without a browser.
