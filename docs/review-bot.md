# The LLM pull-request reviewer

The factory's core job: a pull request arrives, a model reviews the diff, and the
review is posted back on the pull request. This is `cloud-factory-cf-7or`, and it
is the whole path in one place.

```
GitHub webhook  POST /webhooks/github/:owner/:repo
      │           signature verified, `kind: merge_request` written onto the queue row
      ▼
RepoCoordinator queue   (delivery id is the idempotency key)
      │           POST /runs/:owner/:repo claims one event
      ▼
review/bot.ts → github:pr.diff        (broker: GET the diff media type)
      │        → anthropic:messages.create  (broker: the model call)
      ▼
github-pr-review sink → github:pr.review (broker: POST the review comment)
      ▼
queue ack  → the event is `processed`
```

Nothing in the reviewer holds a credential. Every provider call is an action from
the broker's closed policy table (`apps/worker/src/credentials/policy.ts`), so an
agent prompt — or a model reading a hostile diff — cannot name a host, a method or
a secret.

## Turning it on

1. Put the key in the broker's environment for the deployment
   (`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`, `wrangler secret put`).
2. Set `REVIEW_MODEL` (a `var`, not a secret) to `service/model`, e.g.
   `anthropic/claude-sonnet-4-5`.
3. Provision the three actions for the repository, with the control key:

```bash
REPO=owner/name
for pair in github:pr.diff github:pr.review anthropic:messages.create; do
  service=${pair%%:*}; action=${pair#*:}
  curl -sS -X POST "https://<deployment>/broker/$REPO/provisioning" \
    -H "content-type: application/json" -H "x-factory-control-key: $BROKER_CONTROL_KEY" \
    -d "{\"agent\":\"cloud-factory:$REPO\",\"service\":\"$service\",\"action\":\"$action\"}"
done
```

Unset `REVIEW_MODEL` and the same route keeps the deterministic reviewer: it posts
a short template comment and never calls a model. That is the offline default, and
what the test suite exercises when no model is configured.

## Behaviour that matters

- **A failure is never settled as a review.** If the model is unavailable (429,
  529, no credential, empty answer) the run fails, the event is not acked, and the
  queue retries it. A template comment is never posted in place of a model review.
- **Only merge requests are reviewed.** A push or an issue comment is a clean skip,
  so retries are not burned on events the reviewer has nothing to say about.
- **The diff is bounded.** `REVIEW_MAX_DIFF_CHARS` (default 60000) cuts a huge diff
  with an explicit marker rather than silently reviewing a fragment.
- **The comment says who wrote it.** Every review ends with
  `_Reviewed by cloud-factory with <service>/<model>._`, so a human can tell the
  bot's opinion from theirs.
- **Model names are configuration.** There is no default model: a wrong or
  unavailable name is an operator error the deployment reports, not a silent
  fallback to something cheaper.

## Tests

`apps/worker/test/review-bot.test.ts` drives the real path — webhook, queue,
Durable Object, capability issuance, quota, sinks — and stubs only the two upstream
hosts. It asserts the diff is requested with `application/vnd.github.v3.diff`, the
model receives the diff in its prompt, the posted review body is the model's text,
and the event is acked. It also covers a 529 (not settled as reviewed) and a
non-PR event (skipped).
