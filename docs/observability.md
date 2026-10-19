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
`{"type":"pong","at":"…"}` **on the socket that pinged** (not to every watcher: a
broadcast pong cannot prove that your connection is alive); the stream itself is
read-only. A socket that errors is closed rather than left for the runtime to reap.

Verified end to end against `wrangler dev` (local Durable Objects): a signed webhook
plus `POST /runs/:owner/:repo` produced `claimed → facts → agent → agent → settled`,
the socket delivered `hello` (5 recent rows) followed by live `step` messages, and
`/usage` reported `runs: 1, skipped: 1, tokensIn: 31, tokensOut: 9, estimated: true`.

## The canvas panel

`apps/web` renders the same three views in an **Observability** panel: the live
thought stream (socket, with polling fallback when the socket cannot connect), an
artifact inspector for the selected step, and the cost HUD. The control key is typed
into the panel and kept in memory only — it is never written to `localStorage`.

### Heartbeat and reconnection

An open socket is not the same thing as a live one: a dropped TCP connection, a
restarted Durable Object or a sleeping laptop can leave `readyState` saying OPEN while
no step ever arrives again. The panel therefore probes the stream:

| Setting | Value | Meaning |
|---|---|---|
| `HEARTBEAT_MS` | 15s | how often an open socket is sent `ping` |
| `PONG_TIMEOUT_MS` | 15s | how long one unanswered ping may stand before the socket is assumed dead |
| `RECONNECT_BASE_MS` / `RECONNECT_MAX_MS` | 1s / 30s | exponential backoff, doubling per attempt |

When a ping goes unanswered (or the socket errors, closes, or never finishes opening)
the panel closes it, **keeps polling so the rows stay current**, and reconnects with
backoff. The status line says which of those it is doing — `live · 12 step(s) ·
heartbeat 3s ago`, `reconnecting (attempt 2, retry in 2s) · heartbeat lost…` — and a
**Reconnect** button retries immediately instead of waiting out the backoff. Attempts
reset once the new socket answers a ping (an `open` that never answers must not
forgive a flapping socket, or the retry becomes a one-second loop); a `401` fails closed rather than retrying a key that will
never be accepted. `pagehide` and Disconnect clear the poll, heartbeat and retry
timers.

## Operator example

```bash
BASE=https://cloud-factory-cf.<subdomain>.workers.dev
KEY=$BROKER_CONTROL_KEY          # never commit this

curl -s -H "x-factory-control-key: $KEY" "$BASE/trace/acme/widget?limit=20" | jq '.steps[] | "\(.sequence) \(.step) \(.status) \(.detail)"'
curl -s -H "x-factory-control-key: $KEY" "$BASE/trace/acme/widget/usage" | jq .usage
```
