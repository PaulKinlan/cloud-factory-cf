import { DurableObject } from "cloudflare:workers";
import { parseRepositoryKey } from "@factory-cloud/sdk";
import { getCredentialBroker } from "./repo-coordinator-addressing";
import type { Env } from "./env";
import { planAgents, sourceMatches } from "./canvas-runs";
import { safeParseJson } from "./events/helpers";
import { isMissingSchemaError } from "./events/sql-errors";
import { createDefaultExecutionFn, drainRepository } from "./pipeline";
import { CanvasStore, migrateCanvasTable } from "./canvas-store";
import { GitTreeStore, migrateGitTreeTable } from "./git-tree-store";
import { MemoryHandler, migrateMemoryTable } from "./memory";
import { sameSecret } from "./secrets";
import {
  ConnectStore,
  EventQueue,
  DeliveryLedger,
  RunAuditStore,
  RunTraceStore,
  migrateConnectTable,
  mergeLegacyConnectRow,
  type LegacyConnectRow,
  migrateEventQueueTable,
  migrateDeliveryLedgerTable,
  migrateRunAuditTable,
  migrateRunTraceTable,
  MAX_ATTEMPTS,
  DEFAULT_VISIBILITY_MS,
  safeDecode,
  traceSink,
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

/** After a drain that threw, wait this long before trying again (never "now"). */
const AUTO_DRAIN_RETRY_MS = 30_000;

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
  private gitTreeStore!: GitTreeStore;
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
    const rawName = this.ctx.id.name ?? "";
    const parsedName = parseRepositoryKey(rawName);
    const unadornedRepo = parsedName ? parsedName.repository : rawName;
    this.memoryHandler = new MemoryHandler(this.ctx.storage.sql);
    this.canvasStore = new CanvasStore(this.ctx.storage.sql, unadornedRepo);
    this.gitTreeStore = new GitTreeStore(this.ctx.storage.sql);
    this.deliveryLedger = new DeliveryLedger(this.ctx.storage.sql);
    this.runAuditStore = new RunAuditStore(this.ctx.storage.sql);
    // The trace store broadcasts to this object's open sockets, so a viewer sees a
    // step as it is recorded rather than on the next poll (cloud-factory-cf-2ng).
    this.runTrace = new RunTraceStore(this.ctx.storage.sql, (step) => this.broadcastStep(step));
    // Webhook connection evidence for the onboarding UI: one row per repository,
    // written on every authorised delivery and on the provider's `ping` (7gq).
    this.connectState = new ConnectStore(this.ctx.storage.sql, unadornedRepo);
    this.eventQueue = new EventQueue(this.ctx.storage.sql, {
      setAlarm: (ts: number) => this.ctx.storage.setAlarm(ts),
      deleteAlarm: () => this.ctx.storage.deleteAlarm(),
    });
  }

  private get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  /**
   * Runs `fn`; if SQLite reports a missing table, re-apply the migrations (every
   * statement is `CREATE TABLE IF NOT EXISTS`, so this is idempotent) and retry once.
   * Any other error propagates untouched — this must not become a blanket retry
   * (cloud-factory-cf-u55u, coord's Proposal 1).
   */
  private async withSchemaRetry<T>(fn: () => T | Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (!isMissingSchemaError(err)) throw err;
      console.error(
        `RepoCoordinator ${this.ctx.id.name ?? "?"}: re-applying schema after '${err instanceof Error ? err.message : String(err)}'`,
      );
      this.migrate();
      return await fn();
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const name = this.ctx.id.name ?? "";
    const isUnprefixed = name.length > 0 && !parseRepositoryKey(name);

    if (url.pathname === "/legacy/export") {
      return this.exportLegacyState(request);
    }
    if (url.pathname === "/legacy/ack-migrated") {
      return this.ackMigrated(request);
    }

    if (isUnprefixed) {
      // Legacy un-prefixed DO: proxy request to platform-prefixed DO (ADR 003 Slice 3)
      const targetStub = this.env.REPO_COORDINATOR.get(
        this.env.REPO_COORDINATOR.idFromName(`github:${name}`),
      );
      return targetStub.fetch(request);
    }

    try {
      const origHeader = request.headers.get("x-factory-original-repository");
      await this.withSchemaRetry(() => this.ensureMigrated(origHeader));
    } catch (err) {
      return Response.json(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        { status: 503 },
      );
    }
    // The retry covers both a schema that is momentarily invisible and the writes that
    // read it (run_trace, canvas documents, the event queue).
    return this.routeWithSchemaRetry(request);
  }

  private async exportLegacyState(request: Request): Promise<Response> {
    const controlKey = this.env.BROKER_CONTROL_KEY;
    if (!controlKey || !(await sameSecret(controlKey, request.headers.get("x-factory-control-key")))) {
      return Response.json({ ok: false, error: "unauthorised" }, { status: 401 });
    }

    const memory = this.sql.exec("SELECT key, value, metadata, created_at, updated_at FROM memory").toArray();
    const canvas_documents = this.sql.exec("SELECT id, name, document, created_at, updated_at FROM canvas_documents").toArray();
    const webhook_connect = this.sql.exec("SELECT id, last_ping_at, last_event_at, last_event, pings, updated_at FROM webhook_connect").toArray();
    const events = this.sql.exec("SELECT delivery_id, provider, event, action, repository, actor, received_at, payload, status, attempts, available_at, last_error, lease_id, kind, canonical_action FROM events").toArray();
    const event_deliveries = this.sql.exec("SELECT delivery_id, agent_id, status, attempts, updated_at FROM event_deliveries").toArray();
    const run_audit = this.sql.exec("SELECT id, document_id, name, agents, detail, created_at FROM run_audit").toArray();
    const run_trace = this.sql.exec("SELECT id, delivery_id, sequence, step, status, detail, artifact, created_at, ms FROM run_trace").toArray();

    const empty =
      memory.length === 0 &&
      canvas_documents.length === 0 &&
      webhook_connect.length === 0 &&
      events.length === 0 &&
      event_deliveries.length === 0 &&
      run_audit.length === 0 &&
      run_trace.length === 0;

    return Response.json({
      ok: true,
      empty,
      state: empty
        ? null
        : {
            memory,
            canvas_documents,
            webhook_connect,
            events,
            event_deliveries,
            run_audit,
            run_trace,
          },
    });
  }

  private async ackMigrated(request: Request): Promise<Response> {
    const controlKey = this.env.BROKER_CONTROL_KEY;
    if (!controlKey || !(await sameSecret(controlKey, request.headers.get("x-factory-control-key")))) {
      return Response.json({ ok: false, error: "unauthorised" }, { status: 401 });
    }
    this.ctx.storage.deleteAlarm();
    this.sql.exec(
      "INSERT OR REPLACE INTO _schema_migrations (name, migrated_at) VALUES ('migrated_to_prefixed', ?)",
      Date.now(),
    );
    return Response.json({ ok: true });
  }

  private async ensureMigrated(originalRepo?: string | null): Promise<void> {
    const name = this.ctx.id.name ?? "";
    const parsed = parseRepositoryKey(name);
    if (!parsed) return;
    const platform = parsed.platform;

    const controlKey = this.env.BROKER_CONTROL_KEY;
    const legacyName = parsed.repository;
    if (!controlKey) {
      console.error(`Migration blocked for ${legacyName}: BROKER_CONTROL_KEY is unconfigured`);
      throw new Error(`BROKER_CONTROL_KEY is unconfigured: migration for ${legacyName} cannot proceed`);
    }

    const candidateNames: string[] = [];
    if (originalRepo) {
      const origTrimmed = originalRepo.trim();
      const origParsed = parseRepositoryKey(origTrimmed);
      const origRepo = origParsed ? origParsed.repository : origTrimmed;
      if (origRepo.toLowerCase() === parsed.repository && origRepo !== parsed.repository) {
        candidateNames.push(`${platform}:${origRepo}`);
        if (platform === "github") {
          candidateNames.push(origRepo);
        }
      }
    }
    if (platform === "github") {
      candidateNames.push(parsed.repository);
    }

    const unprobedCandidates = candidateNames.filter((cand) => {
      const row = this.sql.exec<{ name: string }>(
        "SELECT name FROM _schema_migrations WHERE name = ?",
        `legacy_probed:${cand}`,
      ).toArray();
      return row.length === 0;
    });
    if (unprobedCandidates.length === 0) return;

    let anyImported = false;
    let allLossless = true;

    try {
      for (const cand of unprobedCandidates) {
        const legacyStub = this.env.REPO_COORDINATOR.get(this.env.REPO_COORDINATOR.idFromName(cand));
        const res = await legacyStub.fetch("https://repo-coordinator.internal/legacy/export", {
          headers: { "x-factory-control-key": controlKey },
        });
        if (!res.ok) {
          console.error(`Legacy export failed for ${cand} with status ${res.status}`);
          continue;
        }
        const body = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          empty?: boolean;
          state?: Record<string, unknown[]>;
        };
        if (!body.ok) {
          console.error(`Legacy export returned not ok for ${cand}`);
          continue;
        }

        if (body.empty) {
          this.sql.exec(
            "INSERT OR REPLACE INTO _schema_migrations (name, migrated_at) VALUES (?, ?)",
            `legacy_probed:${cand}`,
            Date.now(),
          );
          if (cand === parsed.repository) {
            try {
              await legacyStub.fetch("https://repo-coordinator.internal/legacy/ack-migrated", {
                method: "POST",
                headers: { "x-factory-control-key": controlKey },
              });
            } catch {}
          }
          continue;
        }

        const s = body.state;
        if (!s) continue;

        anyImported = true;
        let candLossless = true;

        this.ctx.storage.transactionSync(() => {
          for (const m of (s["memory"] as any[]) ?? []) {
            this.sql.exec(
              "INSERT OR IGNORE INTO memory (key, value, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
              m.key, m.value, m.metadata, m.created_at, m.updated_at,
            );
          }
          for (const c of (s["canvas_documents"] as any[]) ?? []) {
            this.sql.exec(
              "INSERT OR IGNORE INTO canvas_documents (id, name, document, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
              c.id, c.name, c.document, c.created_at, c.updated_at,
            );
          }
          for (const w of (s["webhook_connect"] as LegacyConnectRow[]) ?? []) {
            // One row per DO with a monotonic `pings` counter: ignore-on-conflict would
            // throw legacy evidence away, so merge it instead (cloud-factory-cf-tgu9).
            if (!mergeLegacyConnectRow(this.sql, w)) {
              candLossless = false;
              allLossless = false;
            }
          }
          for (const e of (s["events"] as any[]) ?? []) {
            this.sql.exec(
              "INSERT OR IGNORE INTO events (delivery_id, provider, event, action, repository, actor, received_at, payload, status, attempts, available_at, last_error, lease_id, kind, canonical_action) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
              e.delivery_id, e.provider, e.event, e.action, e.repository, e.actor, e.received_at, e.payload, e.status, e.attempts, e.available_at, e.last_error, e.lease_id, e.kind, e.canonical_action,
            );
          }
          for (const d of (s["event_deliveries"] as any[]) ?? []) {
            this.sql.exec(
              "INSERT OR IGNORE INTO event_deliveries (delivery_id, agent_id, status, attempts, updated_at) VALUES (?, ?, ?, ?, ?)",
              d.delivery_id, d.agent_id, d.status, d.attempts, d.updated_at,
            );
          }
          for (const a of (s["run_audit"] as any[]) ?? []) {
            this.sql.exec(
              "INSERT OR IGNORE INTO run_audit (id, document_id, name, agents, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)",
              a.id, a.document_id, a.name, a.agents, a.detail, a.created_at,
            );
          }
          for (const t of (s["run_trace"] as any[]) ?? []) {
            this.sql.exec(
              "INSERT OR IGNORE INTO run_trace (id, delivery_id, sequence, step, status, detail, artifact, created_at, ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
              t.id, t.delivery_id, t.sequence, t.step, t.status, t.detail, t.artifact, t.created_at, t.ms,
            );
          }
          if (candLossless) {
            this.sql.exec(
              "INSERT OR REPLACE INTO _schema_migrations (name, migrated_at) VALUES (?, ?)",
              `legacy_probed:${cand}`,
              Date.now(),
            );
          }
        });

        if (!candLossless) {
          console.error(
            `Legacy merge for candidate ${cand} dropped a webhook_connect value it could not represent; leaving candidate unsealed`,
          );
        }

        // Tell legacy DO to cancel its alarm and mark itself migrated
        try {
          const ackRes = await legacyStub.fetch("https://repo-coordinator.internal/legacy/ack-migrated", {
            method: "POST",
            headers: { "x-factory-control-key": controlKey },
          });
          if (!ackRes.ok) {
            console.error(`Legacy ack-migrated failed for ${cand} with status ${ackRes.status}`);
          }
        } catch (ackErr) {
          console.error(`Legacy ack-migrated network error for ${cand}:`, ackErr);
        }
      }

      if (anyImported && allLossless) {
        this.sql.exec(
          "INSERT OR REPLACE INTO _schema_migrations (name, migrated_at) VALUES ('legacy_read_through', ?)",
          Date.now(),
        );
      }
    } catch (err) {
      console.error(`Migration error for ${parsed.repository}:`, err);
    }

    if (this.eventQueue.hasDue()) {
      await this.eventQueue.armAlarm();
    }
  }

  /**
   * The coordinator's own request routing, callable in process. The alarm drains
   * with this instead of a stub to itself: a Durable Object that awaits a fetch to
   * itself deadlocks, because it cannot serve the inner request while the outer one
   * is blocked on it.
   */
  /**
   * `route()` with the schema retry, for the one input that cannot simply be re-used: a
   * `Request` body is a stream, so the first attempt consumes it and a naive retry would
   * hand the handler an empty body (a 400 for POST /trace, and worse for an ingest —
   * rev-u55u finding, cloud-factory-cf-1k1y). The clone is taken *before* the first
   * attempt, and only when it is cheap and legal to take: a WebSocket upgrade request
   * cannot be cloned, and there the original error propagates.
   */
  private async routeWithSchemaRetry(request: Request): Promise<Response> {
    // `request.clone()` carries the host metadata type through, so the clone is typed from
    // the request itself rather than as a bare `Request`.
    let retryable: ReturnType<Request["clone"]> | null = null;
    try {
      retryable = request.clone();
    } catch {
      retryable = null;
    }
    try {
      return await this.route(request);
    } catch (err) {
      if (retryable === null || !isMissingSchemaError(err)) throw err;
      console.error(
        `RepoCoordinator ${this.ctx.id.name ?? "?"}: re-applying schema after '${err instanceof Error ? err.message : String(err)}'`,
      );
      this.migrate();
      // The clone carries the request's host-metadata generics (`Request<CfHostMetadata, Cf>`),
      // which do not widen back to the default `Request`; the handler only reads the body and
      // headers, so the boundary cast is safe here and keeps `route()`'s signature simple.
      return this.route(retryable as unknown as Request);
    }
  }

  private async route(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/events") {
      return this.ingest(request, url.searchParams.get("provider") ?? "github");
    }
    if (request.method === "GET" && url.pathname === "/events") {
      return this.eventQueue.listEvents(url);
    }
    if (request.method === "GET" && url.pathname === "/events/stats") {
      if (url.searchParams.get("detail") === "1") {
        return this.eventDetail("stats");
      }
      return Response.json({
        ok: true,
        counts: this.eventQueue.statusCounts(),
      });
    }
    if (request.method === "GET" && url.pathname.startsWith("/events/") && url.pathname.endsWith("/payload") && url.pathname !== "/events/payload") {
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
    if (url.pathname === "/git-tree") {
      if (request.method === "GET") return this.gitTreeStore.list(url);
      if (request.method === "PUT") {
        const text = await request.text();
        if (new TextEncoder().encode(text).length > 4 * 1024 * 1024) return Response.json({ ok: false, error: "tree exceeds size limit" }, { status: 413 });
        let body: unknown;
        try { body = JSON.parse(text); } catch { return Response.json({ ok: false, error: "invalid json" }, { status: 400 }); }
        return this.ctx.storage.transactionSync(() => this.gitTreeStore.replace(body));
      }
      return new Response("method not allowed", { status: 405 });
    }
    if (request.method === "GET" && url.pathname.startsWith("/git-tree/files/")) {
      return this.gitTreeStore.file(decodeURIComponent(url.pathname.slice("/git-tree/files/".length)));
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

  /**
   * A viewer that talks to the socket: the stream is read-only, so the only
   * accepted input is a heartbeat. The pong goes back to the socket that pinged
   * and never to every watcher, because a broadcast pong cannot prove that
   * *your* connection is alive, which is the whole point of the heartbeat
   * (cloud-factory-cf-2ng.6).
   */
  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message === "string" && message.trim() === "ping") {
      // Kept small and explicit: a browser cannot send a protocol-level ping.
      try {
        ws.send(JSON.stringify({ type: "pong", at: new Date().toISOString() }));
      } catch {
        /* closed: the runtime drops the socket */
      }
    }
  }

  /** A socket that errored is closed rather than left for the runtime to reap. */
  override async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }

  /**
   * Alarm entry point: free expired leases, drain whatever is due, then re-arm.
   *
   * This is what makes the factory a bot rather than a command-line tool: a webhook
   * arms the alarm, the alarm runs the review, and the queue settles the event
   * (cloud-factory-cf-7or.1).
   */
  override async alarm(): Promise<void> {
    // An alarm can fire on a freshly-restored object before its schema is visible, so
    // it gets the same one-shot schema retry as a request (cloud-factory-cf-u55u).
    return this.withSchemaRetry(async () => {
      await this.eventQueue.requeueExpiredLeases();
      try {
        await this.autoDrain();
      } catch (err) {
        // A missing table is not a drain failure: it must reach the retry above, which
        // re-creates the schema and runs the alarm again. Swallowing it here turned a
        // transient schema window into a permanent 30s backoff loop, with the table never
        // re-created and no review posted (cloud-factory-cf-chcm).
        if (isMissingSchemaError(err)) throw err;
        // Any other throw must not re-arm for "now": that is a hot loop. Wait out a
        // backoff; the events stay queued for the next attempt.
        this.ctx.storage.setAlarm(Date.now() + AUTO_DRAIN_RETRY_MS);
        return;
      }
      await this.eventQueue.armAlarm();
    });
  }

  /**
   * Whether a canvas in this repository has an agent wired to the event. The canvas
   * is the reviewer of record for its own events, so the default reviewer stands down
   * rather than posting a second review of the same pull request
   * (cloud-factory-cf-7or, coord's option B).
   */
  private canvasHandles(event: { provider: string; event: string }): boolean {
    const rows = this.sql.exec<{ document: string }>("SELECT document FROM canvas_documents").toArray();
    return rows.some((row) => {
      const document = safeParseJson(row.document);
      if (document === null) return false;
      const plan = planAgents(document);
      if (!plan.ok) return false;
      return plan.plan.some((agent) => agent.sources.some((source) => sourceMatches(source, event)));
    });
  }

  /** Runs due events through the pipeline, in this object's own context. */
  private async autoDrain(): Promise<void> {
    if (!this.eventQueue.hasDue()) return;
    // Exactly one review per pull request: if a canvas agent is wired to every due
    // event, the canvas owns them and the default reviewer stays out of the way.
    const due = this.eventQueue.dueProviderEvents();
    if (due.length > 0 && due.every((event) => this.canvasHandles(event))) return;
    const rawRepo = this.ctx.id.name ?? "";
    const parsed = parseRepositoryKey(rawRepo);
    const repository = parsed ? parsed.repository : rawRepo;
    const controlKey = this.env.BROKER_CONTROL_KEY;
    // Without a control key no capability can be minted, so a drain would fail every
    // event; leave the queue to POST /runs, which reports the misconfiguration.
    if (repository.length === 0 || controlKey === undefined) return;

    const coordinator = {
      fetch: (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
        this.route(input instanceof Request ? input : new Request(input, init)),
    };
    await drainRepository({
      repository,
      controlKey,
      coordinator,
      broker: getCredentialBroker(this.env, repository),
      onStep: traceSink(coordinator),
      // Unifies ADR 003 decideAction semantics across alarm and runs paths (cloud-factory-cf-jtg9).
      executionFn: createDefaultExecutionFn(this.env),
    });
  }

  private migrate(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS _schema_migrations (
        name TEXT PRIMARY KEY,
        migrated_at INTEGER NOT NULL
      )
    `);
    migrateMemoryTable(this.sql);
    migrateCanvasTable(this.sql);
    migrateGitTreeTable(this.sql);
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
    const routedRepository = request.headers.get("x-factory-repository") ?? this.ctx.id.name ?? null;
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
      normalised.kind,
      normalised.canonicalAction,
      repository,
      normalised.actor,
      body,
      now,
    );

    if (!enqueued) {
      return Response.json({ ok: true, duplicate: true, deliveryId }, { status: 200 });
    }

    // A fresh delivery is due immediately, so arm the alarm that drains it: this is
    // what lets a webhook alone produce a review (cloud-factory-cf-7or.1).
    await this.eventQueue.armAlarm();

    return Response.json({ ok: true, queued: true, deliveryId }, { status: 202 });
  }

  private async authorise(
    provider: Provider,
    headers: Headers,
    body: string,
  ): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
    if (provider === "github") {
      let secret: string | undefined = undefined;
      const repoName = this.ctx.id.name;
      if (this.env.CREDENTIAL_BROKER && repoName) {
        try {
          const parsed = parseRepositoryKey(repoName);
          const brokerRepo = parsed ? parsed.repository : repoName;
          const origRepo = headers.get("x-factory-original-repository");
          const broker = getCredentialBroker(this.env, brokerRepo);
          const secretReq = new Request("https://credential-broker.internal/effective-webhook-secret", {
            headers: { "x-factory-original-repository": origRepo ?? brokerRepo },
          });
          const res = await broker.fetch(secretReq);
          if (res.ok) {
            const data = (await res.json().catch(() => ({}))) as { secret?: string };
            if (typeof data.secret === "string" && data.secret.length > 0) {
              secret = data.secret;
            }
          }
        } catch {
          // Fall back to env.WEBHOOK_SECRET
        }
      }
      if (!secret) {
        secret = this.env.WEBHOOK_SECRET;
      }
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
    const rawRepo = this.ctx.id.name ?? "unknown";
    const parsed = parseRepositoryKey(rawRepo);
    const unadorned = parsed ? parsed.repository : rawRepo;
    return Response.json({
      ok: true,
      repository: unadorned,
      event: found,
      deliveries,
    });
  }

  private stats(): Response {
    const rawRepo = this.ctx.id.name ?? "unknown";
    const parsed = parseRepositoryKey(rawRepo);
    const unadorned = parsed ? parsed.repository : rawRepo;
    return Response.json({
      ok: true,
      repository: unadorned,
      counts: this.eventQueue.statusCounts(),
      memoryKeys: this.memoryHandler.total(),
    });
  }

  // ------------------------------------------------------------------ memory

  private async forwardToOrg(request: Request): Promise<Response> {
    const rawRepo = this.ctx.id.name;
    const parsed = rawRepo ? parseRepositoryKey(rawRepo) : null;
    const repoName = parsed ? parsed.repository : rawRepo;
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
  const parsedA = parseRepositoryKey(a.trim());
  const parsedB = parseRepositoryKey(b.trim());
  if (parsedA && parsedB) {
    return (
      parsedA.platform.toLowerCase() === parsedB.platform.toLowerCase() &&
      parsedA.repository.toLowerCase() === parsedB.repository.toLowerCase()
    );
  }
  const repoA = (parsedA ? parsedA.repository : a.trim()).toLowerCase();
  const repoB = (parsedB ? parsedB.repository : b.trim()).toLowerCase();
  return repoA === repoB;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
