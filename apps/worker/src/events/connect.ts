/**
 * Webhook connection evidence (cloud-factory-cf-7gq).
 *
 * GitHub sends exactly one `ping` event when a webhook is created, and nothing
 * else proves the hook is actually pointed at this Durable Object. Recording that
 * ping — plus the last event of any kind — is what lets the onboarding UI say
 * "connected" instead of asking an operator to trust a hunch.
 *
 * It lives in DO SQLite beside the event queue and the trace, so it survives a
 * restart like they do, and it is per repository by construction (the object id
 * is the repository).
 */

const CONNECT_ROW = "default";

export function migrateConnectTable(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS webhook_connect (
      id TEXT PRIMARY KEY,
      last_ping_at TEXT,
      last_event_at TEXT,
      last_event TEXT,
      pings INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
  `);
}

export interface ConnectStatus {
  repository: string;
  /** When the provider last completed its own handshake, or null. */
  lastPingAt: string | null;
  /** When any authorised delivery last reached this repository, or null. */
  lastEventAt: string | null;
  lastEvent: string | null;
  pings: number;
}

/**
 * Merges one legacy `webhook_connect` row into the canonical object (cloud-factory-cf-tgu9).
 *
 * There is exactly one row per Durable Object (`id = CONNECT_ROW`) and `pings` is a
 * monotonic counter, so the old `INSERT OR IGNORE` dropped the legacy count whenever the
 * canonical object had already recorded its own first delivery — and the same migration
 * transaction then wrote its `legacy_read_through` seal, making the loss permanent and
 * silent. The two counters describe disjoint periods (legacy before the object key was
 * canonicalised, canonical after), so the union is their **sum**, not their maximum.
 *
 * `last_ping_at`/`last_event_at`/`updated_at` are high-water marks: the later of the two
 * wins, and `last_event` travels with whichever `last_event_at` won so the pair stays
 * consistent. Summing is only safe because the merge and the seal share one
 * `transactionSync`, so a retry cannot double-count.
 *
 * Returns `false` when a legacy value could not be represented and was therefore dropped;
 * the caller must not seal the repository in that case (it would hide the loss).
 */
export function mergeLegacyConnectRow(sql: SqlStorage, legacy: LegacyConnectRow): boolean {
  const id = textOrNull(legacy.id) ?? CONNECT_ROW;
  const existing = sql
    .exec<{
      last_ping_at: string | null;
      last_event_at: string | null;
      last_event: string | null;
      pings: number;
      updated_at: string;
    }>(
      "SELECT last_ping_at, last_event_at, last_event, pings, updated_at FROM webhook_connect WHERE id = ?",
      id,
    )
    .toArray()[0];

  const rawPings = legacy.pings ?? 0;
  const parsedPings = typeof rawPings === "number" ? rawPings : Number(rawPings);
  const lossless = Number.isFinite(parsedPings) && parsedPings >= 0;
  const legacyPings = lossless ? parsedPings : 0;
  const existingPings = existing === undefined ? 0 : Number(existing.pings ?? 0) || 0;

  // The `last_event` pair must stay consistent: keep the legacy event only when its
  // timestamp is the one that wins, and never let a null legacy event blank a real one.
  const existingLastEventAt = existing === undefined ? null : textOrNull(existing.last_event_at);
  const legacyLastEventAt = textOrNull(legacy.last_event_at);
  const legacyEventWins = atOrAfter(legacyLastEventAt, existingLastEventAt);
  const existingLastEvent = existing === undefined ? null : textOrNull(existing.last_event);
  const legacyLastEvent = textOrNull(legacy.last_event);

  const lastPingAt = pickLater(
    existing === undefined ? null : textOrNull(existing.last_ping_at),
    textOrNull(legacy.last_ping_at),
  );
  const updatedAt =
    pickLater(
      existing === undefined ? null : textOrNull(existing.updated_at),
      textOrNull(legacy.updated_at),
    ) ?? new Date().toISOString();

  sql.exec(
    `INSERT INTO webhook_connect (id, last_ping_at, last_event_at, last_event, pings, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       last_ping_at = excluded.last_ping_at,
       last_event_at = excluded.last_event_at,
       last_event = excluded.last_event,
       pings = excluded.pings,
       updated_at = excluded.updated_at`,
    id,
    lastPingAt,
    legacyEventWins ? legacyLastEventAt : existingLastEventAt,
    (legacyEventWins ? (legacyLastEvent ?? existingLastEvent) : (existingLastEvent ?? legacyLastEvent)),
    existingPings + legacyPings,
    updatedAt,
  );

  return lossless;
}

/** A legacy `webhook_connect` row as exported from an un-prefixed Durable Object. */
export interface LegacyConnectRow {
  id?: unknown;
  last_ping_at?: unknown;
  last_event_at?: unknown;
  last_event?: unknown;
  pings?: unknown;
  updated_at?: unknown;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** True when `candidate` is at or after `current`. ISO-8601 sorts lexically; parse when it may not. */
function atOrAfter(candidate: string | null, current: string | null): boolean {
  if (candidate === null) return false;
  if (current === null) return true;
  const candidateMs = Date.parse(candidate);
  const currentMs = Date.parse(current);
  if (Number.isFinite(candidateMs) && Number.isFinite(currentMs)) return candidateMs >= currentMs;
  return candidate >= current;
}

function pickLater(current: string | null, candidate: string | null): string | null {
  return atOrAfter(candidate, current) ? candidate : current;
}

export class ConnectStore {
  constructor(
    private sql: SqlStorage,
    private repository: string,
  ) {}

  /** Every authorised delivery is evidence that the hook reaches this object. */
  recordEvent(event: string, at: string): void {
    this.sql.exec(
      `INSERT INTO webhook_connect (id, last_event_at, last_event, pings, updated_at) VALUES (?, ?, ?, 0, ?)
       ON CONFLICT(id) DO UPDATE SET
         last_event_at = excluded.last_event_at,
         last_event = excluded.last_event,
         updated_at = excluded.updated_at`,
      CONNECT_ROW,
      at,
      event,
      at,
    );
  }

  /** A `ping` is the provider's own handshake: the strongest evidence there is. */
  recordPing(at: string): void {
    this.sql.exec(
      `INSERT INTO webhook_connect (id, last_ping_at, last_event_at, last_event, pings, updated_at) VALUES (?, ?, ?, 'ping', 1, ?)
       ON CONFLICT(id) DO UPDATE SET
         last_ping_at = excluded.last_ping_at,
         last_event_at = excluded.last_event_at,
         last_event = 'ping',
         pings = webhook_connect.pings + 1,
         updated_at = excluded.updated_at`,
      CONNECT_ROW,
      at,
      at,
      at,
    );
  }

  /** The onboarding UI's read: never invent a connection it has no evidence for. */
  snapshot(): ConnectStatus {
    const row = this.sql
      .exec(`SELECT last_ping_at, last_event_at, last_event, pings FROM webhook_connect WHERE id = ?`, CONNECT_ROW)
      .toArray()[0];
    if (row === undefined) {
      return { repository: this.repository, lastPingAt: null, lastEventAt: null, lastEvent: null, pings: 0 };
    }
    return {
      repository: this.repository,
      lastPingAt: typeof row["last_ping_at"] === "string" ? row["last_ping_at"] : null,
      lastEventAt: typeof row["last_event_at"] === "string" ? row["last_event_at"] : null,
      lastEvent: typeof row["last_event"] === "string" ? row["last_event"] : null,
      pings: Number(row["pings"] ?? 0),
    };
  }

  status(): Response {
    return Response.json({ ok: true, connect: this.snapshot() });
  }
}
