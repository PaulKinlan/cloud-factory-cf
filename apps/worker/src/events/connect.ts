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
