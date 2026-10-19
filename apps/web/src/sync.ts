/**
 * Canvas ↔ document-store wiring, kept out of the renderer so it can be tested
 * without a DOM. The canvas stays local-first: these helpers only build requests
 * and interpret responses; `main.ts` decides what to do with them.
 */
import { parseDoc, serialize, type CanvasDoc } from "./model";

const REPOSITORY_PATTERN = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/;

export interface ShareTarget {
  repository: string;
  controlKey: string;
}

export interface StoredDocumentSummary {
  id: string;
  name: string;
  updatedAt: string;
  createdAt?: string;
}

export interface ShareRequest {
  url: string;
  init: RequestInit;
}

export function isValidRepository(repository: string): boolean {
  return REPOSITORY_PATTERN.test(repository.trim());
}

/**
 * `PUT` target for saving. Without an id the server assigns one (and answers
 * 201); with one the document is updated in place.
 */
export function saveRequest(
  origin: string,
  target: ShareTarget,
  document: CanvasDoc,
  options: { id?: string; name?: string } = {},
): ShareRequest | { error: string } {
  if (!isValidRepository(target.repository)) return { error: "repository must look like owner/name" };
  if (target.controlKey.length === 0) return { error: "a control key is required" };

  const base = `${origin.replace(/\/+$/, "")}/canvas/${target.repository.trim()}/documents`;
  const url = options.id ? `${base}/${encodeURIComponent(options.id)}` : base;
  return {
    url,
    init: {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-factory-control-key": target.controlKey,
      },
      body: JSON.stringify({
        name: options.name?.trim() || "Untitled canvas",
        // The stored document is exactly what the canvas exported.
        document: JSON.parse(serialize(document)) as unknown,
      }),
    },
  };
}

export function listRequest(origin: string, target: ShareTarget): ShareRequest | { error: string } {
  if (!isValidRepository(target.repository)) return { error: "repository must look like owner/name" };
  if (target.controlKey.length === 0) return { error: "a control key is required" };
  return {
    url: `${origin.replace(/\/+$/, "")}/canvas/${target.repository.trim()}/documents`,
    init: {
      method: "GET",
      headers: { "x-factory-control-key": target.controlKey },
    },
  };
}

export function documentRequest(origin: string, target: ShareTarget, id: string): ShareRequest | { error: string } {
  if (!isValidRepository(target.repository)) return { error: "repository must look like owner/name" };
  if (target.controlKey.length === 0) return { error: "a control key is required" };
  if (id.length === 0) return { error: "a document id is required" };
  return {
    url: `${origin.replace(/\/+$/, "")}/canvas/${target.repository.trim()}/documents/${encodeURIComponent(id)}`,
    init: {
      method: "GET",
      headers: { "x-factory-control-key": target.controlKey },
    },
  };
}

/** Returns the stored documents, or null when the payload is not a list. */
export function parseDocumentList(payload: unknown): StoredDocumentSummary[] | null {
  if (typeof payload !== "object" || payload === null) return null;
  const list = (payload as { documents?: unknown }).documents;
  if (!Array.isArray(list)) return null;
  const entries: StoredDocumentSummary[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Partial<StoredDocumentSummary>;
    if (typeof entry.id !== "string" || entry.id.length === 0) continue;
    entries.push({
      id: entry.id,
      name: typeof entry.name === "string" && entry.name.length > 0 ? entry.name : "Untitled canvas",
      updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : "",
      ...(typeof entry.createdAt === "string" ? { createdAt: entry.createdAt } : {}),
    });
  }
  return entries;
}

/**
 * Extracts the canvas document from a `GET .../documents/:id` payload, running it
 * through the same validation the canvas uses for its own storage.
 */
export function parseStoredDocument(payload: unknown): { document: CanvasDoc; name: string } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const body = payload as { document?: unknown; name?: unknown };
  if (body.document === undefined) return null;
  const document = parseDoc(JSON.stringify(body.document));
  if (!document) return null;
  return {
    document,
    name: typeof body.name === "string" && body.name.length > 0 ? body.name : "Untitled canvas",
  };
}

/** Human-readable reason for a failed share call, without echoing the key. */
export function describeShareFailure(status: number, payload: unknown): string {
  // The server's own message is useful for a 400/409, but it is bounded and
  // stripped of control characters: it must not be able to smuggle a header or
  // flood the status line.
  const serverError =
    typeof payload === "object" && payload !== null && typeof (payload as { error?: unknown }).error === "string"
      ? ((payload as { error: string }).error).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 120).trim()
      : "";
  const suffix = serverError.length > 0 ? ` (${serverError})` : "";
  if (status === 401) return "Control key rejected — check the key configured on the deployment";
  if (status === 403) return "Not authorised for this repository";
  if (status === 503) return "This deployment has no control key configured, so documents cannot be stored";
  if (status === 404) return "No such document in this repository";
  if (status === 409) return `This repository's document limit is reached${suffix}`;
  if (status === 400) return `The server refused the document${suffix}`;
  if (status >= 500) return `The document store failed${suffix}`;
  return `Unexpected response ${status}${suffix}`;
}
