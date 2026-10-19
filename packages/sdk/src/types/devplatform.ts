/**
 * Universal DevPlatform adapters (ADR 003, cloud-factory-cf-6to).
 *
 * The factory has always spoken GitHub: webhook headers, payload shapes and repo
 * addressing all assumed it. This module is the platform-neutral seam — one
 * `SdlcEvent` whatever the forge, produced by one `DevPlatformAdapter` per platform
 * — so sinks, the pipeline and the coordinators stop branching on the provider.
 *
 * What is deliberately NOT here: secret verification. That needs the deployment's
 * secrets and the Workers crypto surface, so it stays next to the worker route that
 * receives the request (`apps/worker/src/webhooks.ts`). An adapter only turns an
 * *authenticated* payload into the canonical event.
 */

/** The forges the factory can speak to. */
export type DevPlatform = "github" | "gitlab" | "gitea";

/**
 * The SDLC activity the factory cares about, whatever the provider calls it.
 * Anything a platform sends that is not in this list is `unknown`, never dropped:
 * a sink can decide what it wants, but the event is still recorded.
 */
export type SdlcKind =
  | "merge_request"
  | "pipeline"
  | "push"
  | "issue"
  | "comment"
  | "release"
  | "ping"
  | "unknown";

/**
 * A provider action folded onto the four states a factory run reacts to.
 * Provider-native wording is kept in `action`; this is the portable one.
 */
export type SdlcAction = "opened" | "updated" | "merged" | "closed" | null;

/** A webhook delivery, normalised. */
export interface SdlcEvent {
  platform: DevPlatform;
  /** Provider-native delivery id (the idempotency key). */
  deliveryId: string;
  /** The provider's own event name, kept for tracing and debugging. */
  rawEvent: string;
  kind: SdlcKind;
  /** Provider-native action, e.g. "opened", "open", "synchronize". */
  action: string | null;
  /** `action` folded onto the portable vocabulary. */
  canonicalAction: SdlcAction;
  /** Canonical repository path, `group/project`, with no platform prefix. */
  repository: string;
  actor: string | null;
}

/** The subset of `Headers` an adapter needs, so it can be tested without one. */
export interface HeaderReader {
  get(name: string): string | null;
}

/** One adapter per forge. */
export interface DevPlatformAdapter {
  readonly platform: DevPlatform;
  /** The idempotency key from the delivery's headers, or null when absent. */
  deliveryId(headers: HeaderReader): string | null;
  /** The provider's event name from the headers (never null: `unknown` instead). */
  rawEvent(headers: HeaderReader): string;
  /**
   * Fold a payload into the canonical event. Returns null only for input that is
   * not a webhook payload at all (not an object, or carrying no repository), so a
   * malformed delivery is refused rather than invented.
   */
  normalise(payload: unknown, headers: HeaderReader): SdlcEvent | null;
  /** The path a repository's hook should post to. */
  webhookPath(repository: string): string;
}

/**
 * The Durable Object / memory key for a repository. The platform is part of the
 * identity: `acme/widget` on GitHub and on GitLab are different repositories
 * (ADR 003), and addressing them as one would merge two tenants' state.
 */
export function repositoryKey(platform: DevPlatform, repository: string): string {
  return `${platform}:${repository}`;
}

/** Split a repository key back into its parts, or null when it is not one. */
export function parseRepositoryKey(key: string): { platform: DevPlatform; repository: string } | null {
  const index = key.indexOf(":");
  if (index <= 0 || index === key.length - 1) return null;
  const candidate = key.slice(0, index);
  if (!isDevPlatform(candidate)) return null;
  return { platform: candidate, repository: key.slice(index + 1) };
}

export function isDevPlatform(value: string): value is DevPlatform {
  return value === "github" || value === "gitlab" || value === "gitea";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Fold a provider action onto the portable vocabulary. */
export function canonicalAction(action: string | null): SdlcAction {
  if (action === null) return null;
  switch (action.toLowerCase()) {
    case "open":
    case "opened":
    case "reopen":
    case "reopened":
    case "create":
    case "created":
      return "opened";
    case "update":
    case "updated":
    case "synchronize":
    case "synchronized":
    case "edited":
    case "edit":
      return "updated";
    case "merge":
    case "merged":
      return "merged";
    case "close":
    case "closed":
      return "closed";
    default:
      return null;
  }
}

/** The repository path a payload names, or null when it names none. */
function repositoryOf(payload: Record<string, unknown>, candidates: readonly string[]): string | null {
  for (const path of candidates) {
    const value = path
      .split(".")
      .reduce<unknown>((node, key) => asRecord(node)?.[key], payload);
    const found = stringOf(value);
    if (found !== null) return found;
  }
  return null;
}

function firstHeader(headers: HeaderReader, names: readonly string[]): string | null {
  for (const name of names) {
    const value = stringOf(headers.get(name));
    if (value !== null) return value;
  }
  return null;
}

function eventOf(
  platform: DevPlatform,
  rawEvent: string,
  kind: SdlcKind,
  repository: string,
  action: string | null,
  actor: string | null,
  deliveryId: string | null,
): SdlcEvent | null {
  if (deliveryId === null) return null;
  return {
    platform,
    deliveryId,
    rawEvent,
    kind,
    action,
    canonicalAction: canonicalAction(action),
    repository,
    actor,
  };
}

const GITHUB_KINDS: Record<string, SdlcKind> = {
  pull_request: "merge_request",
  pull_request_review: "comment",
  push: "push",
  issues: "issue",
  issue_comment: "comment",
  release: "release",
  ping: "ping",
};

export const githubAdapter: DevPlatformAdapter = {
  platform: "github",
  deliveryId: (headers) => firstHeader(headers, ["x-github-delivery"]),
  rawEvent: (headers) => firstHeader(headers, ["x-github-event"]) ?? "unknown",
  normalise(payload, headers) {
    const root = asRecord(payload);
    if (root === null) return null;
    const repository = repositoryOf(root, ["repository.full_name"]);
    if (repository === null) return null;
    const rawEvent = this.rawEvent(headers);
    const action = stringOf(root["action"]);
    return eventOf(
      "github",
      rawEvent,
      GITHUB_KINDS[rawEvent] ?? "unknown",
      repository,
      action,
      stringOf(asRecord(root["sender"])?.["login"]),
      this.deliveryId(headers),
    );
  },
  webhookPath: (repository) => `/webhooks/github/${repository}`,
};

const GITLAB_KINDS: Record<string, SdlcKind> = {
  "Merge Request Hook": "merge_request",
  "Pipeline Hook": "pipeline",
  "Job Hook": "pipeline",
  "Push Hook": "push",
  "Tag Push Hook": "push",
  "Issue Hook": "issue",
  "Note Hook": "comment",
  "Release Hook": "release",
  // `object_kind` values, used when a proxy strips the event header.
  merge_request: "merge_request",
  pipeline: "pipeline",
  push: "push",
  issue: "issue",
  note: "comment",
};

export const gitlabAdapter: DevPlatformAdapter = {
  platform: "gitlab",
  deliveryId: (headers) => firstHeader(headers, ["x-gitlab-event-uuid"]),
  rawEvent: (headers) => firstHeader(headers, ["x-gitlab-event"]) ?? "unknown",
  normalise(payload, headers) {
    const root = asRecord(payload);
    if (root === null) return null;
    const repository = repositoryOf(root, [
      "project.path_with_namespace",
      "object_attributes.target.path_with_namespace",
      "repository.path_with_namespace",
    ]);
    if (repository === null) return null;
    const rawEvent = this.rawEvent(headers);
    // GitLab's event header is authoritative, but the payload carries the same
    // information as `object_kind`; prefer the payload when the header is missing
    // so a proxy that strips headers does not turn every delivery into `unknown`.
    const event = rawEvent === "unknown" ? (stringOf(root["object_kind"]) ?? "unknown") : rawEvent;
    const attributes = asRecord(root["object_attributes"]);
    const action = stringOf(attributes?.["action"]);
    return eventOf(
      "gitlab",
      event,
      GITLAB_KINDS[event] ?? "unknown",
      repository,
      action,
      stringOf(asRecord(root["user"])?.["username"]),
      this.deliveryId(headers),
    );
  },
  webhookPath: (repository) => `/webhooks/gitlab/${repository}`,
};

const GITEA_KINDS: Record<string, SdlcKind> = {
  pull_request: "merge_request",
  pull_request_comment: "comment",
  push: "push",
  issues: "issue",
  issue_comment: "comment",
  release: "release",
};

export const giteaAdapter: DevPlatformAdapter = {
  platform: "gitea",
  // Forgejo keeps Gitea's headers; both are accepted so one adapter serves both.
  deliveryId: (headers) => firstHeader(headers, ["x-gitea-delivery", "x-forgejo-delivery"]),
  rawEvent: (headers) => firstHeader(headers, ["x-gitea-event", "x-forgejo-event"]) ?? "unknown",
  normalise(payload, headers) {
    const root = asRecord(payload);
    if (root === null) return null;
    const repository = repositoryOf(root, ["repository.full_name", "repository.path_with_namespace"]);
    if (repository === null) return null;
    const rawEvent = this.rawEvent(headers);
    return eventOf(
      "gitea",
      rawEvent,
      GITEA_KINDS[rawEvent] ?? "unknown",
      repository,
      stringOf(root["action"]),
      stringOf(asRecord(root["sender"])?.["login"]) ?? stringOf(asRecord(root["pusher"])?.["login"]),
      this.deliveryId(headers),
    );
  },
  webhookPath: (repository) => `/webhooks/gitea/${repository}`,
};

/**
 * The raw-event → kind tables behind the adapters, keyed by platform. A stored
 * delivery keeps its raw event name but not its request headers, so a consumer
 * (or a row written before the queue carried `kind`) needs the mapping without an
 * adapter call: this is the same table the adapters use, not a second copy.
 */
const KINDS_BY_PLATFORM: Record<DevPlatform, Record<string, SdlcKind>> = {
  github: GITHUB_KINDS,
  gitlab: GITLAB_KINDS,
  gitea: GITEA_KINDS,
};

/** The canonical kind for a provider's raw event name; `unknown` when unmapped. */
export function kindOf(platform: DevPlatform, rawEvent: string): SdlcKind {
  return KINDS_BY_PLATFORM[platform]?.[rawEvent] ?? "unknown";
}

/** Every adapter the factory ships, keyed by platform. */
export const devPlatformAdapters: Record<DevPlatform, DevPlatformAdapter> = {
  github: githubAdapter,
  gitlab: gitlabAdapter,
  gitea: giteaAdapter,
};

/** An adapter by platform, or null for one the factory does not speak. */
export function adapterFor(platform: string): DevPlatformAdapter | null {
  return isDevPlatform(platform) ? devPlatformAdapters[platform] : null;
}
