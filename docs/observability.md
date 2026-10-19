# Observability

The factory records what it actually did, per repository, and streams it live. Three
things are exposed, all from the repository's Durable Object — the same object that
already owns the event queue, so the trace cannot disagree with the queue about what
happened:

| Surface | Path | What it answers |
| --- | --- | --- |
| Trace | `GET /trace/:owner/:repo` | Which steps ran, in order, with their artifacts |
| Usage | `GET /trace/:owner/:repo/usage` | How much work ran and roughly what it cost |
| Live stream | `WS /trace/:owner/:repo/socket?key=…` | The same steps as they are recorded |

All three require the control key (`x-factory-control-key: $BROKER_CONTROL_KEY`, or
`?key=` for the socket, which is the one place a browser cannot send a header). A
trace contains prompts and agent output, so it is control-plane data; with no key
configured the routes answer `503`, with a wrong key `401`.

## What a step is

```jsonc
{
  "id": "9f1c…",            // uuid
  "deliveryId": "72f0…",    // the provider delivery this run belongs to
  "sequence": 3,            // monotonic per delivery, so order never depends on clocks
  "step": "agent",          // claimed | facts | agent | sink | ledger | wiring | settled
  "status": "ok",           // info | ok | warn | error
  "detail": "success in 12ms, 0 tool call(s)",
  "artifact": { "tokensIn": 31, "tokensOut": 9, "actionTypes": ["issue.create"] },
  "at": "2026-10-19T13:23:08.383Z",
  "ms": 12
}
```

`runEvent` emits `claimed` before it loads the event, `facts` once the payload is
decoded, `agent` twice (before and after the agent runs), one `sink` step per action
the agent emitted, and `settled` on **every** return path — success, skip, duplicate,
failure and exception. A failed run therefore still shows where it failed instead of
only its status. The artifact of `settled` is what the cost HUD aggregates.

Steps live in SQLite in the Durable Object (`run_trace`), capped as a ring at
**500 rows**: observability must never be the reason an object runs out of storage.
Older steps are dropped oldest-first.

## Cost HUD numbers, and why they say "estimated"

`GET /trace/:owner/:repo/usage` returns:

```json
{ "ok": true,
  "usage": { "runs": 12, "succeeded": 9, "failed": 1, "skipped": 2, "actions": 14,
             "tokensIn": 412, "tokensOut": 96, "estimated": true,
             "byAction": { "issue.create": 6, "pr.review": 8 },
             "byStep": { "claimed": 12, "facts": 12, "agent": 24, "sink": 14, "settled": 12 },
             "latestAt": "2026-10-19T13:23:08.383Z" } }
```

`tokensIn`/`tokensOut` are **estimates** (`estimated: true`): the default pipeline runs
the deterministic rule-based agent, which has no model usage to report, so the pipeline
records the prompt/output character counts and converts them at the usual ~4
characters per token. A model-backed `executionFn` can report real numbers through the
same artifact. There are deliberately no per-token prices in this repo — a price is a
contract with a provider, not something to guess — so the HUD shows tokens and counts,
and a deployment that wants money adds its own rate.

## Live stream

```
WS /trace/:owner/:repo/socket?key=<BROKER_CONTROL_KEY>
→ {"type":"hello","repository":"acme/widget","steps":[ …last 20, newest first… ]}
→ {"type":"step","step":{ …one step as it is recorded… }}
```

The socket is accepted with `ctx.acceptWebSocket`, so the Durable Object hibernates
while watchers stay connected instead of billing for idle tabs. Sending `ping` gets
`{"type":"pong"}`; the stream itself is read-only.

Verified end to end against `wrangler dev` (local Durable Objects): a signed webhook
plus `POST /runs/:owner/:repo` produced `claimed → facts → agent → agent → settled`,
the socket delivered `hello` (5 recent rows) followed by live `step` messages, and
`/usage` reported `runs: 1, skipped: 1, tokensIn: 31, tokensOut: 9, estimated: true`.

## The canvas panel

`apps/web` renders the same three views in an **Observability** panel: the live
thought stream (socket, with polling fallback when the socket cannot connect), an
artifact inspector for the selected step, and the cost HUD. The control key is typed
into the panel and kept in memory only — it is never written to `localStorage`.

## Connection evidence

GitHub sends exactly one `ping` event when a webhook is created, and nothing else
proves a hook is actually pointed at a repository's Durable Object. The coordinator
records it (and the last delivery of any kind) in the same SQLite database as the
trace, so onboarding can report a connection instead of asking an operator to trust
a hunch.

```
GET /trace/:owner/:repo/connect        (header x-factory-control-key)
→ {"ok":true,
   "connect":{"repository":"acme/widget",
              "lastPingAt":"2026-10-19T16:14:09.512Z",
              "lastEventAt":"2026-10-19T16:14:09.512Z",
              "lastEvent":"ping",
              "pings":1}}
```

`lastPingAt` is null until the provider's handshake arrives; `pings` counts them, so a
re-created hook is visible as a new ping rather than an unchanged timestamp.
`lastEvent`/`lastEventAt` cover every authorised delivery, including ones that arrive
before the ping. A `ping` is acknowledged with `202` and **not queued**: it carries no
work, so queueing it would only give the pipeline a delivery to skip. This route is
control-plane only, like the rest of `/trace` — it says whether a repository's hook is
live, which must not be world-readable on a public Worker.

## Operator example

```bash
BASE=https://cloud-factory-cf.<subdomain>.workers.dev
KEY=$BROKER_CONTROL_KEY          # never commit this

curl -s -H "x-factory-control-key: $KEY" "$BASE/trace/acme/widget?limit=20" | jq '.steps[] | "\(.sequence) \(.step) \(.status) \(.detail)"'
curl -s -H "x-factory-control-key: $KEY" "$BASE/trace/acme/widget/usage" | jq .usage
```
