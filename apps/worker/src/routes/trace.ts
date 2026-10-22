import type { Env } from "../env";
import { sameSecret } from "../secrets";
import { getRepoCoordinator } from "../repo-coordinator-addressing";

/**
 * Public surface for the observability suite (cloud-factory-cf-2ng).
 *
 *   GET /trace/:owner/:repo            recent ordered steps (optionally ?deliveryId=)
 *   GET /trace/:owner/:repo/usage      cost HUD aggregates (tokens are estimates)
 *   POST /trace/:owner/:repo/ticket    mint a 60s single-use ticket for the WebSocket
 *   GET /trace/:owner/:repo/socket     live step stream (WebSocket upgrade via ?ticket=)
 *   GET /trace/:owner/:repo/connect    webhook connection evidence (ping/event)
 *
 * All of these are control-plane reads, so they require the broker control key: a
 * trace carries prompts and agent output, and the connection state says whether a
 * repository's hook is live, which must not be world-readable on a public Worker.
 *
 * For WebSockets, the control key must NOT travel in a URL query string (cloud-factory-cf-aqq3).
 * Instead, clients call POST /trace/:owner/:repo/ticket (with header x-factory-control-key)
 * to obtain an ephemeral ~60s one-time ticket, and pass ?ticket=<ticket> on the socket URL.
 */
export const TRACE_PATH =
  /^\/trace\/(?<owner>[^/]+)\/(?<repo>[^/]+)(?:\/(?<operation>usage|socket|connect|ticket))?$/;

const usedTicketNonces = new Map<string, number>();

function cleanUsedTicketNonces(now = Date.now()): void {
  for (const [nonce, expiresAt] of usedTicketNonces.entries()) {
    if (now > expiresAt) {
      usedTicketNonces.delete(nonce);
    }
  }
}

async function signHmacSha256(secret: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function mintTraceTicket(
  secret: string,
  owner: string,
  repo: string,
  now = Date.now(),
): Promise<{ ticket: string; expiresAt: number }> {
  cleanUsedTicketNonces(now);
  const expiresAt = now + 60_000;
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const payload = `${owner.toLowerCase()}:${repo.toLowerCase()}:${expiresAt}:${nonce}`;
  const sig = await signHmacSha256(secret, payload);
  const ticket = `${payload}.${sig}`;
  return { ticket, expiresAt };
}

export async function verifyTraceTicket(
  secret: string,
  ticket: string,
  owner: string,
  repo: string,
  now = Date.now(),
): Promise<boolean> {
  cleanUsedTicketNonces(now);
  const dotIndex = ticket.lastIndexOf(".");
  if (dotIndex < 0) return false;
  const payload = ticket.slice(0, dotIndex);
  const sig = ticket.slice(dotIndex + 1);

  const parts = payload.split(":");
  if (parts.length !== 4) return false;
  const [ticketOwner, ticketRepo, expStr, nonce] = parts as [string, string, string, string];

  const expiresAt = Number.parseInt(expStr, 10);
  if (!Number.isFinite(expiresAt) || now > expiresAt) {
    return false;
  }
  if (ticketOwner !== owner.toLowerCase() || ticketRepo !== repo.toLowerCase()) {
    return false;
  }
  if (usedTicketNonces.has(nonce)) {
    return false; // Replay prevention: single-use ticket
  }

  const expectedSig = await signHmacSha256(secret, payload);
  if (!(await sameSecret(expectedSig, sig))) {
    return false;
  }

  // Mark nonce as used
  usedTicketNonces.set(nonce, expiresAt);
  return true;
}

export async function handleTrace(request: Request, env: Env, url: URL): Promise<Response | null> {
  const match = TRACE_PATH.exec(url.pathname);
  if (!match?.groups) return null;
  const { owner, repo, operation } = match.groups as {
    owner: string;
    repo: string;
    operation?: string;
  };

  const controlKey = env.BROKER_CONTROL_KEY;
  if (!controlKey) {
    return Response.json({ ok: false, error: "control key not configured" }, { status: 503 });
  }

  const signingKey = env.BROKER_SIGNING_KEY ?? env.BROKER_CONTROL_KEY ?? env.WEBHOOK_SECRET ?? controlKey;
  const platform = url.searchParams.get("platform");
  const stub = getRepoCoordinator(env, `${owner}/${repo}`, platform);

  if (operation === "ticket") {
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }
    const provided = request.headers.get("x-factory-control-key");
    if (!(await sameSecret(controlKey, provided))) {
      return Response.json({ ok: false, error: "not authorised to mint trace ticket" }, { status: 401 });
    }
    const { ticket, expiresAt } = await mintTraceTicket(signingKey, owner, repo);
    return Response.json({ ok: true, ticket, expiresAt });
  }

  if (operation === "socket") {
    if (request.method !== "GET") {
      return new Response("method not allowed", { status: 405 });
    }
    const headerKey = request.headers.get("x-factory-control-key");
    const hasValidHeader = headerKey ? await sameSecret(controlKey, headerKey) : false;
    const ticket = url.searchParams.get("ticket");
    const hasValidTicket = ticket ? await verifyTraceTicket(signingKey, ticket, owner, repo) : false;

    // A bare control key in query parameters is explicitly refused (cloud-factory-cf-aqq3).
    // Access requires either a valid x-factory-control-key header (non-browser)
    // or a single-use short-lived ticket minted via POST /trace/:owner/:repo/ticket.
    if (!hasValidHeader && !hasValidTicket) {
      return Response.json({ ok: false, error: "not authorised to read the execution trace" }, { status: 401 });
    }

    const limit = url.searchParams.get("limit");
    const forwarded = limit === null ? "" : `?limit=${encodeURIComponent(limit)}`;
    return stub.fetch(
      new Request(`https://repo-coordinator.internal/trace/socket${forwarded}`, {
        method: "GET",
        headers: request.headers,
      }),
    );
  }

  // All other trace routes (usage, connect, base list) require the control key header.
  const provided = request.headers.get("x-factory-control-key");
  if (!(await sameSecret(controlKey, provided))) {
    return Response.json({ ok: false, error: "not authorised to read the execution trace" }, { status: 401 });
  }
  if (request.method !== "GET") {
    return new Response("method not allowed", { status: 405 });
  }

  if (operation === "usage") {
    return stub.fetch("https://repo-coordinator.internal/trace/usage");
  }
  if (operation === "connect") {
    return stub.fetch("https://repo-coordinator.internal/connect");
  }
  const query = url.searchParams.toString();
  return stub.fetch(`https://repo-coordinator.internal/trace${query === "" ? "" : `?${query}`}`);
}
