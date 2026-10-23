/**
 * Canvas ↔ document-store wiring, kept out of the renderer so it can be tested
 * without a DOM. The canvas stays local-first: these helpers only build requests
 * and interpret responses; `main.ts` decides what to do with them.
 */
import { createDoc, parseDoc, serialize, type CanvasDoc } from "./model";

const REPOSITORY_PATTERN = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/;

export interface ShareTarget {
  repository: string;
  controlKey?: string;
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
  if (target.controlKey !== undefined && target.controlKey.length === 0) return { error: "a control key is required" };

  const base = `${origin.replace(/\/+$/, "")}/canvas/${target.repository.trim()}/documents`;
  const url = options.id ? `${base}/${encodeURIComponent(options.id)}` : base;
  return {
    url,
    init: {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...(target.controlKey !== undefined ? { "x-factory-control-key": target.controlKey } : {}),
      },
      credentials: "same-origin",
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
  if (target.controlKey !== undefined && target.controlKey.length === 0) return { error: "a control key is required" };
  return {
    url: `${origin.replace(/\/+$/, "")}/canvas/${target.repository.trim()}/documents`,
    init: {
      method: "GET",
      headers: target.controlKey !== undefined ? { "x-factory-control-key": target.controlKey } : {},
      credentials: "same-origin",
    },
  };
}

export function documentRequest(origin: string, target: ShareTarget, id: string): ShareRequest | { error: string } {
  if (!isValidRepository(target.repository)) return { error: "repository must look like owner/name" };
  if (target.controlKey !== undefined && target.controlKey.length === 0) return { error: "a control key is required" };
  if (id.length === 0) return { error: "a document id is required" };
  return {
    url: `${origin.replace(/\/+$/, "")}/canvas/${target.repository.trim()}/documents/${encodeURIComponent(id)}`,
    init: {
      method: "GET",
      headers: target.controlKey !== undefined ? { "x-factory-control-key": target.controlKey } : {},
      credentials: "same-origin",
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

/**
 * What the canvas persists: the document **and** the repository whose stored
 * copy it is. They are written and read as one value, because a canvas restored
 * without its binding let a restored id `PUT` over another repository's
 * document after a reload (finding cloud-factory-cf-aju).
 */
export interface PersistedCanvas {
  document: CanvasDoc;
  bound: string | null;
}

export function serializeCanvasState(document: CanvasDoc, bound: string | null): string {
  const boundRepository = bound === null ? null : bound.trim();
  return JSON.stringify(
    {
      version: 1,
      document: JSON.parse(serialize(document)) as unknown,
      bound: boundRepository === "" ? null : boundRepository,
    },
    null,
    2,
  );
}

/**
 * Reads persisted state. A bare document (the pre-binding format) is still
 * accepted, but it restores with `bound: null`, which `planSave` treats as
 * "do not overwrite anything".
 */
export function parseCanvasState(json: string): PersistedCanvas | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as { document?: unknown; bound?: unknown };
  if (candidate.document !== undefined) {
    const document = parseDoc(JSON.stringify(candidate.document));
    if (document === null) return null;
    const bound = typeof candidate.bound === "string" && candidate.bound.trim().length > 0 ? candidate.bound.trim() : null;
    return { document, bound };
  }
  const document = parseDoc(json);
  return document === null ? null : { document, bound: null };
}

/**
 * The canvas state a page should start from: the persisted document with the
 * repository it belongs to, or an empty document when nothing is stored.
 * Reading it is a pure value, so no module state has to be assigned while the
 * page is still initialising (a reload lost its canvas when the binding was
 * assigned from `loadDoc` before its declaration — finding cloud-factory-cf-aju).
 */
export function restoreCanvas(stored: string | null): PersistedCanvas {
  const parsed = stored === null ? null : parseCanvasState(stored);
  return parsed ?? { document: createDoc(), bound: null };
}

/**
 * Which document id belongs to which repository.
 *
 * A saved id is only meaningful inside the repository it came from: carrying it
 * across a repository edit asked the server to update a *different*
 * repository's copy (review finding cloud-factory-cf-ci5). The tracker keeps one
 * id per repository, so switching back to a repository still updates its own
 * document, and a repository that has never been saved gets a fresh one.
 */
export interface ShareTracker {
  idFor(repository: string): string | null;
  remember(repository: string, id: string): void;
  forget(repository: string): void;
  /** Serializable hint for sessionStorage. */
  toJSON(): { ids: Record<string, string> };
}

function normaliseRepository(repository: string): string {
  return repository.trim();
}

export function createShareTracker(initial: Record<string, string> = {}): ShareTracker {
  const ids = new Map<string, string>();
  for (const [repository, id] of Object.entries(initial)) {
    const key = normaliseRepository(repository);
    if (key.length > 0 && typeof id === "string" && id.length > 0) ids.set(key, id);
  }
  return {
    idFor(repository) {
      return ids.get(normaliseRepository(repository)) ?? null;
    },
    remember(repository, id) {
      const key = normaliseRepository(repository);
      if (key.length > 0 && id.length > 0) ids.set(key, id);
    },
    forget(repository) {
      ids.delete(normaliseRepository(repository));
    },
    toJSON() {
      return { ids: Object.fromEntries(ids) };
    },
  };
}

/**
 * Which repository a loaded document belongs to: the one the request was made
 * against, never whichever the field says when the response arrives (finding
 * cloud-factory-cf-qd6 — an in-flight repository edit used to rebind the
 * document, and the next save wrote it into the wrong repository).
 */
export interface LoadBinding {
  bound: string;
  repositoryChanged: boolean;
}

export function bindLoadedDocument(requested: string, current: string): LoadBinding {
  const bound = requested.trim();
  return { bound, repositoryChanged: bound !== current.trim() };
}

/**
 * Decides whether a save updates a document or creates one.
 *
 * Owning a per-repository id is not enough: the *canvas* can be bound to a
 * different repository (loaded from beta, then the repository field edited to
 * alpha). Updating alpha's document with beta's canvas destroyed alpha's copy
 * in the reported repro, so a save only updates in place when the canvas was
 * loaded from, or last saved to, the repository being saved to.
 */
export interface SavePlan {
  /** Id to `PUT`, or null to let the server assign one. */
  id: string | null;
  /** True when the target already held a document that this save must not overwrite. */
  newCopy: boolean;
}

export function planSave(tracker: ShareTracker, boundRepository: string | null, repository: string): SavePlan {
  const existing = tracker.idFor(repository);
  if (existing === null) return { id: null, newCopy: false };
  // No proof that this canvas came from that repository (a reload without a
  // restored binding, an id restored from an older hint) means no overwrite.
  if (boundRepository === null) return { id: null, newCopy: true };
  if (normaliseRepository(boundRepository) !== normaliseRepository(repository)) {
    return { id: null, newCopy: true };
  }
  return { id: existing, newCopy: false };
}

/**
 * Reads the session hint. Older pages wrote `{ repository, id }`; that shape is
 * migrated rather than dropped so an open tab keeps its id.
 */
export function parseShareHint(raw: unknown): { ids: Record<string, string>; name?: string } {
  if (typeof raw !== "object" || raw === null) return { ids: {} };
  const body = raw as { ids?: unknown; repository?: unknown; id?: unknown; name?: unknown };
  const ids: Record<string, string> = {};
  if (typeof body.ids === "object" && body.ids !== null) {
    for (const [repository, id] of Object.entries(body.ids as Record<string, unknown>)) {
      if (typeof id === "string" && id.length > 0) ids[repository] = id;
    }
  } else if (typeof body.repository === "string" && typeof body.id === "string" && body.id.length > 0) {
    ids[body.repository] = body.id;
  }
  return typeof body.name === "string" && body.name.length > 0 ? { ids, name: body.name } : { ids };
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
