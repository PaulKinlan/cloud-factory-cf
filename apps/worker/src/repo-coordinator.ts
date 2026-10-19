import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { CanvasStore, migrateCanvasTable } from "./canvas-store";
import { MemoryHandler, migrateMemoryTable } from "./memory";
import {
  ConnectStore,
  EventQueue,
  DeliveryLedger,
  RunAuditStore,
  RunTraceStore,
  migrateConnectTable,
  migrateEventQueueTable,
  migrateDeliveryLedgerTable,
  migrateRunAuditTable,
  migrateRunTraceTable,
  MAX_ATTEMPTS,
  DEFAULT_VISIBILITY_MS,
  safeDecode,
} from "./events";
import {
  deliveryIdFor,
  eventNameFor,
  isProvider,
  MAX_WEBHOOK_BYTES,
  normaliseEvent,
  verifyGiteaSignature,
  verifyGithubSignature,
  verifyGitlabToken,
  type NormalisedEvent,
  type Provider,
} from "./webhooks";

export { MAX_ATTEMPTS, DEFAULT_VISIBILITY_MS };

/**
 * Per-repository Durable Object: the coordinator for one repo's event stream.
 *
 * Responsibilities:
 *   1. verify the provider signature/token over the raw webhook body,
 *   2. delegate queue state machine (claim/ack/fail/drain/release/dead-letter) to EventQueue,
 *   3. delegate fan-out idempotent deliveries to DeliveryLedger,
 *   4. delegate run audit logging to RunAuditStore,
 *   5. delegate the observability trace (ordered run steps + live sockets) to RunTraceStore,
 *   6. delegate persistent memory to MemoryHandler and canvas documents to CanvasStore.
 */
export class RepoCoordinator extends DurableObject<Env> {
  private memoryHandler!: MemoryHandler;
  private canvasStore!: CanvasStore;
  private eventQueue!: EventQueue;
  private deliveryLedger!: DeliveryLedger;
  private runAuditStore!: RunAuditStore;
  private runTrace!: RunTraceStore;
  // Named `connectState`, not `connect`: DurableObject already declares connect(socket).
  private connectState!: ConnectStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
    });
    this.memoryHandler = new MemoryHandler(this.ctx.storage.sql);
    this.canvasStore = new CanvasStore(this.ctx.storage.sql, this.ctx.id.name ?? "");
    this.deliveryLedger = new DeliveryLedger(this.ctx.storage.sql);
    this.runAuditStore = new RunAuditStore(this.ctx.storage.sql);
    // The trace store broadcasts to this object's open sockets, so a viewer sees a
    // step as it is recorded rather than on the next poll (cloud-factory-cf-2ng).
    this.runTrace = new RunTraceStore(this.ctx.storage.sql, (step) => this.broadcastStep(step));
    // Webhook connection evidence for the onboarding UI: one row per repository,
    // written on every authorised delivery and on the provider's `ping` (7gq).
    this.connectState = new ConnectStore(this.ctx.storage.sql, this.ctx.id.name ?? "");
    this.eventQueue = new EventQueue(this.ctx.storage.sql, {
      setAlarm: (ts: number) => this.ctx.storage.setAlarm(ts),
      deleteAlarm: () => this.ctx.storage.deleteAlarm(),
    });
  }

  private get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/events") {
      return this.ingest(request, url.searchParams.get("provider") ?? "github");
    }
    if (request.method === "GET" && url.pathname === "/events") {
      return this.eventQueue.listEvents(url);
    }
    if (request.method === "GET" && url.pathname === "/events/stats") {
      return Response.json({
        ok: true,
        counts: this.eventQueue.statusCounts(),
      });
    }
    if (request.method === "GET" && url.pathname.startsWith("/events/") && url.pathname.endsWith("/payload")) {
      const deliveryId = decodeURIComponent(url.pathname.slice("/events/".length, -"/payload".length));
      return this.eventQueue.eventPayload(deliveryId);
    }
    if (request.method === "GET" && url.pathname.startsWith("/events/")) {
      const deliveryId = decodeURIComponent(url.pathname.slice("/events/".length));
      return this.eventDetail(deliveryId);
    }
    if (request.method === "POST" && url.pathname === "/claim") {
      return this.eventQueue.claim(await readJson(request));
    }
    if (request.method === "POST" && url.pathname === "/ack") {
      return this.eventQueue.ack(await readJson(request));
    }
    if (request.method === "POST" && url.pathname === "/fail") {
      return this.eventQueue.fail(await readJson(request));
    }
    if (request.method === "POST" && url.pathname === "/drain") {
      return this.eventQueue.drain();
    }
    if (request.method === "POST" && url.pathname === "/release") {
      return this.eventQueue.release(await readJson(request));
    }
    if (request.method === "POST" && url.pathname === "/deliveries/claim") {
      return this.deliveryLedger.claim(await readJson(request));
    }
    if (request.method === "POST" && url.pathname === "/deliveries/complete") {
      return this.deliveryLedger.complete(await readJson(request));
    }
    if (request.method === "GET" && url.pathname === "/deliveries") {
      return this.deliveryLedger.list(url);
    }
    if (request.method === "POST" && url.pathname === "/runs/audit") {
      return this.runAuditStore.record(await readJson(request));
    }
    if (request.method === "GET" && url.pathname === "/runs/audit") {
      return this.runAuditStore.list(url);
    }
    if (request.method === "POST" && url.pathname === "/requeue-expired") {
      const requeued = await this.eventQueue.requeueExpiredLeases();
      return Response.json({ ok: true, requeued });
    }
    if (url.pathname === "/canvas" || url.pathname.startsWith("/canvas/")) {
      const id = url.pathname === "/canvas" ? "" : decodeURIComponent(url.pathname.slice("/canvas/".length));
      if (request.method === "GET") return id ? this.canvasStore.get(id) : this.canvasStore.list(url);
      if (request.method === "PUT") return this.canvasStore.put(id, await readJson(request));
      if (request.method === "DELETE") return this.canvasStore.remove(id);
      return new Response("method not allowed", { status: 405 });
    }
    if (url.pathname.startsWith("/memory")) {
      const scope = url.searchParams.get("scope") ?? "repo";
      if (scope === "org") {
        return this.forwardToOrg(request);
      }
      return this.handleMemory(request, url);
    }
    if (request.method === "POST" && url.pathname === "/trace") {
      const recorded = this.runTrace.record(await readJson(request));
      return Response.json({ ok: recorded !== null, step: recorded }, { status: recorded === null ? 400 : 201 });
    }
    if (request.method === "GET" && url.pathname === "/trace") {
      return this.runTrace.list(url);
    }
    if (request.method === "GET" && url.pathname === "/trace/usage") {
      return this.runTrace.usage();
    }
    if (request.method === "GET" && url.pathname === "/trace/socket") {
      return this.traceSocket(request);
    }
    if (request.method === "GET" && url.pathname === "/connect") {
      return this.connectState.status();
    }
    if (request.method === "GET" && url.pathname === "/stats") {
      return this.stats();
    }

    return new Response("not found", { status: 404 });
  }

  /**
   * Live trace socket. Accepted with `ctx.acceptWebSocket` so the object can hibernate
   * while watchers stay connected: a viewer that opens a tab must not keep the
   * Durable Object billed for the duration.
   */
  private traceSocket(request: Request): Response {
    if ((request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
      return Response.json({ ok: false, error: "expected a websocket upgrade" }, { status: 426 });
    }
    const pair = new WebSocketPair();
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    // Give the viewer the recent past immediately, then only new steps. The page
    // size is the viewer's: a panel asking for 12 must not be handed 20 (2ng.2).
    const requested = new URL(request.url).searchParams.get("limit");
    const limit = requested === null ? 20 : Math.min(200, Math.max(1, Number.parseInt(requested, 10) || 20));
    const recent = this.runTrace.recent(limit);
    server.send(JSON.stringify({ type: "hello", repository: this.ctx.id.name ?? "", steps: recent }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** Push one recorded step to every open socket. */
  private broadcastStep(step: unknown): void {
    let payload: string;
    try {
      payload = JSON.stringify({ type: "step", step });
    } catch {
      return;
    }
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(payload);
      } catch {
        // A closed socket is dropped by the runtime; nothing to do here.
      }
    }
  }

  /** A viewer that talks to the socket: the stream is read-only, so ignore input. */
  override async webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message === "string" && message.trim() === "ping") {
      // Kept small and explicit: a browser cannot send a protocol-level ping.
      for (const socket of this.ctx.getWebSockets()) {
        try {
          socket.send(JSON.stringify({ type: "pong", at: new Date().toISOString() }));
        } catch {
          /* closed */
        }
      }
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }

  /** Alarm entry point: hand expired leases back and re-arm for the next retry. */
  override async alarm(): Promise<void> {
    await this.eventQueue.requeueExpiredLeases();
    await this.eventQueue.armAlarm();
  }

  private migrate(): void {
    migrateMemoryTable(this.sql);
    migrateCanvasTable(this.sql);
    migrateEventQueueTable(this.sql);
    migrateRunAuditTable(this.sql);
    migrateRunTraceTable(this.sql);
    migrateConnectTable(this.sql);
    migrateDeliveryLedgerTable(this.sql);
  }

  // ---------------------------------------------------------------- ingestion

  private async ingest(request: Request, providerParam: string): Promise<Response> {
    if (!isProvider(providerParam)) {
      return Response.json({ ok: false, error: "unsupported provider" }, { status: 400 });
    }
    const provider: Provider = providerParam;

    const body = await request.text();
    if (byteLength(body) > MAX_WEBHOOK_BYTES) {
      return Response.json({ ok: false, error: "payload too large" }, { status: 413 });
    }

    const authorised = await this.authorise(provider, request.headers, body);
    if (!authorised.ok) {
      return Response.json({ ok: false, error: authorised.error }, { status: authorised.status });
    }

    const deliveryId = deliveryIdFor(provider, request.headers);
    if (!deliveryId) {
      return Response.json({ ok: false, error: "missing delivery id" }, { status: 400 });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return Response.json({ ok: false, error: "invalid json body" }, { status: 400 });
    }

    const normalised: NormalisedEvent = normaliseEvent(provider, payload, request.headers);
    const routedRepository = request.headers.get("x-factory-repository");
    const repository = normalised.repository !== "unknown"
      ? normalised.repository
      : (routedRepository ?? "unknown");

    // A payload that names a different repository than the endpoint it arrived
    // on is either a misconfigured hook or a forgery attempt: refuse it.
    if (
      routedRepository !== null &&
      normalised.repository !== "unknown" &&
      !sameRepository(routedRepository, normalised.repository)
    ) {
      return Response.json(
        {
          ok: false,
          error: "repository mismatch",
          expected: routedRepository,
          received: normalised.repository,
        },
        { status: 400 },
      );
    }

    const now = new Date().toISOString();
    const headerEvent = eventNameFor(provider, request.headers);
    const eventName = headerEvent !== "unknown" ? headerEvent : (normalised.payloadEvent ?? "unknown");

    // A delivery that got this far is connection evidence in its own right, and a
    // `ping` is the provider's explicit handshake — the strongest evidence there
    // is that a hook is pointed here (cloud-factory-cf-7gq).
    this.connectState.recordEvent(eventName, now);
    if (eventName === "ping") {
      this.connectState.recordPing(now);
      // A ping carries no work: acknowledge the handshake rather than queueing a
      // delivery the pipeline would only have to skip.
      return Response.json(
        { ok: true, ping: true, deliveryId, connect: this.connectState.snapshot() },
        { status: 202 },
      );
    }

    const enqueued = this.eventQueue.enqueue(
      deliveryId,
      provider,
      eventName,
      normalised.action,
      repository,
      normalised.actor,
      body,
      now,
    );

    if (!enqueued) {
      return Response.json({ ok: true, duplicate: true, deliveryId }, { status: 200 });
    }

    return Response.json({ ok: true, queued: true, deliveryId }, { status: 202 });
  }

  private async authorise(
    provider: Provider,
    headers: Headers,
    body: string,
  ): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
    if (provider === "github") {
      const secret = this.env.WEBHOOK_SECRET;
      if (!secret) return { ok: false, status: 503, error: "webhook secret not configured" };
      const valid = await verifyGithubSignature(secret, body, headers.get("x-hub-signature-256"));
      return valid ? { ok: true } : { ok: false, status: 401, error: "invalid signature" };
    }

    if (provider === "gitea") {
      // Gitea and Forgejo derive both headers from the hook's "Secret" field, so one
      // configured secret covers either style: the body MAC when the instance signs,
      // the verbatim token when it does not.
      const secret = this.env.GITEA_WEBHOOK_SECRET;
      if (!secret) return { ok: false, status: 503, error: "gitea webhook secret not configured" };
      const signature =
        headers.get("x-gitea-signature") ?? headers.get("x-forgejo-signature");
      if (signature !== null) {
        const valid = await verifyGiteaSignature(secret, body, signature);
        return valid ? { ok: true } : { ok: false, status: 401, error: "invalid signature" };
      }
      const token = headers.get("x-gitea-token") ?? headers.get("x-forgejo-token");
      const valid = await verifyGitlabToken(secret, token);
      return valid ? { ok: true } : { ok: false, status: 401, error: "invalid token" };
    }

    const token = this.env.GITLAB_WEBHOOK_TOKEN;
    if (!token) return { ok: false, status: 503, error: "gitlab token not configured" };
    const valid = await verifyGitlabToken(token, headers.get("x-gitlab-token"));
    return valid ? { ok: true } : { ok: false, status: 401, error: "invalid token" };
  }

  private eventDetail(deliveryId: string): Response {
    const found = this.eventQueue.findEvent(deliveryId);
    if (!found) {
      return Response.json({ ok: false, error: "not found", deliveryId }, { status: 404 });
    }
    const deliveries = this.deliveryLedger.findDeliveries(deliveryId);
    return Response.json({
      ok: true,
      repository: this.ctx.id.name ?? "unknown",
      event: found,
      deliveries,
    });
  }

  private stats(): Response {
    return Response.json({
      ok: true,
      repository: this.ctx.id.name ?? "unknown",
      counts: this.eventQueue.statusCounts(),
      memoryKeys: this.memoryHandler.total(),
    });
  }

  // ------------------------------------------------------------------ memory

  private async forwardToOrg(request: Request): Promise<Response> {
    const repoName = this.ctx.id.name;
    const owner = repoName ? repoName.split("/")[0] : null;
    if (!owner || !this.env.ORG_COORDINATOR) {
      return Response.json({ ok: false, error: "org coordinator not available" }, { status: 503 });
    }
    const stub = this.env.ORG_COORDINATOR.get(this.env.ORG_COORDINATOR.idFromName(owner));
    const targetUrl = new URL(request.url);
    targetUrl.hostname = "org-coordinator.internal";
    targetUrl.searchParams.delete("scope");
    return stub.fetch(new Request(targetUrl.toString(), request));
  }

  private async handleMemory(request: Request, url: URL): Promise<Response> {
    if (request.method === "GET" && url.pathname.startsWith("/memory/")) {
      const key = safeDecode(url.pathname.slice("/memory/".length));
      if (key === null) return Response.json({ ok: false, error: "malformed key" }, { status: 400 });
      return this.memoryHandler.get(key);
    }
    if (request.method === "GET" && url.pathname === "/memory") {
      const key = url.searchParams.get("key");
      if (key) return this.memoryHandler.get(key);
      const prefix = url.searchParams.get("prefix") ?? "";
      return this.memoryHandler.list(prefix);
    }
    if ((request.method === "POST" || request.method === "PUT") && url.pathname.startsWith("/memory/")) {
      const key = safeDecode(url.pathname.slice("/memory/".length));
      if (key === null) return Response.json({ ok: false, error: "malformed key" }, { status: 400 });
      const body = await readJson(request);
      return this.memoryHandler.set(key, body as Record<string, unknown> | null);
    }
    if (request.method === "POST" && url.pathname === "/memory") {
      const body = (await readJson(request)) as Record<string, unknown> | null;
      const key = typeof body?.["key"] === "string" ? body["key"] : undefined;
      if (!key) return Response.json({ ok: false, error: "missing key" }, { status: 400 });
      return this.memoryHandler.set(key, body);
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/memory/")) {
      const key = safeDecode(url.pathname.slice("/memory/".length));
      if (key === null) return Response.json({ ok: false, error: "malformed key" }, { status: 400 });
      return this.memoryHandler.delete(key);
    }
    if (request.method === "DELETE" && url.pathname === "/memory") {
      const key = url.searchParams.get("key");
      if (!key) return Response.json({ ok: false, error: "missing key" }, { status: 400 });
      return this.memoryHandler.delete(key);
    }
    return new Response("not found", { status: 404 });
  }
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function sameRepository(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
