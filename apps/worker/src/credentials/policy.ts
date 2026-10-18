/**
 * Credential broker policy: the closed set of authenticated calls an agent may
 * request, and how each one is turned into an upstream request.
 *
 * The security property is that agents supply *parameters*, never a URL, a
 * host, a method or a credential. Anything not in this table is denied, so a
 * compromised agent prompt cannot aim the broker at an arbitrary endpoint.
 */

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface ServiceActionDefinition {
  method: HttpMethod;
  /** Route template; `{repository}` comes from the capability, the rest from params. */
  route: string;
  /** Parameters that may appear in the path. */
  pathParams?: readonly string[];
  /** Parameters copied into the JSON request body. */
  bodyParams?: readonly string[];
}

export interface ServiceDefinition {
  host: string;
  /** Env binding that holds the real credential. Never returned to the agent. */
  credentialEnv: string;
  /** How the credential is presented upstream. */
  headers: (credential: string) => Record<string, string>;
  actions: Record<string, ServiceActionDefinition>;
  /** Repository separator handling for templated path segments. */
  repositoryEncoding: "slash" | "url-encoded";
}

export const SERVICES: Readonly<Record<string, ServiceDefinition>> = {
  github: {
    host: "api.github.com",
    credentialEnv: "GITHUB_TOKEN",
    headers: (credential) => ({
      authorization: `Bearer ${credential}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    }),
    repositoryEncoding: "slash",
    actions: {
      "repo.read": { method: "GET", route: "/repos/{repository}" },
      "issue.comment": {
        method: "POST",
        route: "/repos/{repository}/issues/{number}/comments",
        pathParams: ["number"],
        bodyParams: ["body"],
      },
      "pr.review": {
        method: "POST",
        route: "/repos/{repository}/pulls/{number}/reviews",
        pathParams: ["number"],
        bodyParams: ["body", "event"],
      },
      "pr.comment": {
        method: "POST",
        route: "/repos/{repository}/issues/{number}/comments",
        pathParams: ["number"],
        bodyParams: ["body"],
      },
    },
  },
  gitlab: {
    host: "gitlab.com",
    credentialEnv: "GITLAB_TOKEN",
    headers: (credential) => ({ "private-token": credential }),
    repositoryEncoding: "url-encoded",
    actions: {
      "mr.comment": {
        method: "POST",
        route: "/api/v4/projects/{repository}/merge_requests/{iid}/notes",
        pathParams: ["iid"],
        bodyParams: ["body"],
      },
      "project.read": { method: "GET", route: "/api/v4/projects/{repository}" },
    },
  },
};

export function hasPermission(service: string, action: string): boolean {
  return Object.hasOwn(SERVICES, service) && Object.hasOwn(SERVICES[service]?.actions ?? {}, action);
}

export interface ResolveInput {
  service: string;
  action: string;
  /** From the verified capability - never from the caller's request body. */
  repository: string;
  params?: Record<string, unknown>;
}

export type ResolvedRequest =
  | {
      ok: true;
      url: string;
      method: HttpMethod;
      headers: Record<string, string>;
      body?: string;
      service: string;
      action: string;
    }
  | { ok: false; status: 400 | 403; reason: string };

export function resolveRequest(input: ResolveInput): ResolvedRequest {
  const service = SERVICES[input.service];
  if (!service) return { ok: false, status: 403, reason: "unknown service" };

  const action = service.actions[input.action];
  if (!action) return { ok: false, status: 403, reason: "action not permitted" };

  const params = input.params ?? {};
  const pathValues: Record<string, string> = {};

  for (const name of action.pathParams ?? []) {
    const value = params[name];
    const parsed =
      typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return { ok: false, status: 400, reason: `parameter ${name} must be a positive integer` };
    }
    pathValues[name] = String(parsed);
  }

  const bodyValues: Record<string, unknown> = {};
  for (const name of action.bodyParams ?? []) {
    const value = params[name];
    if (value === undefined) continue;
    if (typeof value !== "string" || !isSafeBodyValue(value)) {
      return { ok: false, status: 400, reason: `parameter ${name} must be a safe string` };
    }
    bodyValues[name] = value;
  }

  // Unknown parameters are refused rather than dropped: silently ignoring them
  // hides a prompt trying to smuggle a different target through the broker.
  const allowed = new Set([...(action.pathParams ?? []), ...(action.bodyParams ?? [])]);
  for (const name of Object.keys(params)) {
    if (!allowed.has(name)) return { ok: false, status: 400, reason: `parameter ${name} not permitted` };
  }

  const repository = encodeRepository(input.repository, service.repositoryEncoding);
  if (!repository) return { ok: false, status: 400, reason: "invalid repository" };

  const route = action.route.replace("{repository}", repository).replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = pathValues[name];
    return value ?? "";
  });

  if (route.includes("{") || route.includes("}")) {
    return { ok: false, status: 400, reason: "unresolved route parameter" };
  }

  const hasBody = Object.keys(bodyValues).length > 0;
  return {
    ok: true,
    url: `https://${service.host}${route}`,
    method: action.method,
    headers: hasBody ? { "content-type": "application/json" } : {},
    body: hasBody ? JSON.stringify(bodyValues) : undefined,
    service: input.service,
    action: input.action,
  };
}

/** Credential lookup happens here so no caller can substitute its own value. */
export function credentialEnvFor(service: string): string | null {
  return SERVICES[service]?.credentialEnv ?? null;
}

export function credentialHeadersFor(service: string, credential: string): Record<string, string> {
  return SERVICES[service]?.headers(credential) ?? {};
}

/** `owner/name`, and nothing that could escape a path segment. */
export function encodeRepository(repository: string, encoding: ServiceDefinition["repositoryEncoding"]): string | null {
  const match = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(repository.trim());
  if (!match) return null;
  const value = `${match[1]}/${match[2]}`;
  return encoding === "url-encoded" ? encodeURIComponent(value) : value;
}

function isSafeBodyValue(value: string): boolean {
  if (value.length > 8_000) return false;
  // No control characters (newline/CR are refused to keep header and log
  // injection impossible even after the value is echoed back).
  return !/[\u0000-\u0008\u000a-\u001f\u007f]/.test(value);
}
