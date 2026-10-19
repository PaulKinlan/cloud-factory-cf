# The pull-request reviewer

```
webhook → RepoCoordinator queue → alarm drains → SDK review engine
        → github:pr.diff (broker) → model (broker) → github:pr.review (broker) → ack
```

The engine (`packages/sdk/src/review`) decides what to review and renders the review.
The model call is one closed policy action, so the key lives in the broker and never
reaches the worker or the agent context.

## Enabling the model

1. `wrangler secret put ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`) on the deployment.
2. Set the `REVIEW_MODEL` var to `service/model`, e.g. `anthropic/claude-sonnet-4-5`.
3. Provision the actions for the repository with `BROKER_CONTROL_KEY`:
   `github:pr.diff` and `github:pr.review`, plus `<service>:messages.create`
   (Anthropic) or `<service>:chat.completions` (OpenAI).

Unset `REVIEW_MODEL` and the reviewer keeps the engine's deterministic synthesis: it
still reviews, it just does not call a model.

## What starts it

The delivery itself. Ingesting a webhook arms the repository's Durable Object alarm
(1s, so a burst coalesces into one pass); the alarm drains in process — not through a
stub to its own object, which would deadlock — and the queue settles the event.

`POST /runs/:owner/:repo` remains the manual lever (`?reviewer=llm` forces the engine
and, with `REVIEW_MODEL` set, the model).

## Failure behaviour

- A model that refuses (429/529), returns nothing, or is unprovisioned **fails the
  run**: the event is not acked, the queue retries it, and no template review is
  posted in its place.
- A drain that throws re-arms the alarm for +30s rather than "now", so a broken
  deployment cannot spin; without `BROKER_CONTROL_KEY` the alarm leaves the queue to
  `POST /runs`, which reports the misconfiguration.
