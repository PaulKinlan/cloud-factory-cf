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
  /** Custom headers for this specific action (e.g. accept for diff). */
  headers?: Record<string, string>;
  /** Allow newlines and multiline content in body params (e.g. for PR review markdown). */
  allowMultiline?: boolean;
  /**
   * Builds the request body for an action whose payload is not a flat set of
   * strings, such as a model call (`messages: [{role, content}]`). The action still
   * declares every parameter it may read, so the closed-set property holds; the
   * builder bounds its own values.
   */
  body?: (params: Readonly<Record<string, string | number>>) => Record<string, unknown>;
}

export interface ServiceDefinition {
  /** Fixed upstream host. */
  host: string;
  /**
   * Env binding that names the host instead, for a service whose deployment
   * address is configuration rather than a constant. The host still comes from
   * the operator, never from the agent, so the closed-set property holds.
   */
  hostEnv?: string;
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
        allowMultiline: true,
      },
      "issue.create": {
        method: "POST",
        route: "/repos/{repository}/issues",
        bodyParams: ["title", "body"],
      },
      "pr.comment": {
        method: "POST",
        route: "/repos/{repository}/issues/{number}/comments",
        pathParams: ["number"],
        bodyParams: ["body"],
      },
      "pr.diff": {
        method: "GET",
        route: "/repos/{repository}/pulls/{number}",
        pathParams: ["number"],
        headers: { accept: "application/vnd.github.v3.diff" },
      },
      "pr.files": {
        method: "GET",
        route: "/repos/{repository}/pulls/{number}/files",
        pathParams: ["number"],
      },
      "pr.read": {
        method: "GET",
        route: "/repos/{repository}/pulls/{number}",
        pathParams: ["number"],
      },
    },
  },
  anthropic: {
    // The review model. The key is the operator's; the agent only names the service,
    // the action and a prompt, and the broker attaches the credential.
    host: "api.anthropic.com",
    credentialEnv: "ANTHROPIC_API_KEY",
    headers: (credential) => ({
      "x-api-key": credential,
      "anthropic-version": "2023-06-01",
    }),
    repositoryEncoding: "slash",
    actions: {
      "messages.create": {
        method: "POST",
        route: "/v1/messages",
        bodyParams: ["model", "max_tokens", "prompt"],
        body: (params) => ({
          model: String(params["model"] ?? ""),
          max_tokens: Number(params["max_tokens"] ?? 0),
          messages: [{ role: "user", content: String(params["prompt"] ?? "") }],
        }),
      },
    },
  },
  openai: {
    host: "api.openai.com",
    credentialEnv: "OPENAI_API_KEY",
    headers: (credential) => ({ authorization: `Bearer ${credential}` }),
    repositoryEncoding: "slash",
    actions: {
      "chat.completions": {
        method: "POST",
        route: "/v1/chat/completions",
        bodyParams: ["model", "max_tokens", "prompt"],
        body: (params) => ({
          model: String(params["model"] ?? ""),
          max_tokens: Number(params["max_tokens"] ?? 0),
          messages: [{ role: "user", content: String(params["prompt"] ?? "") }],
        }),
      },
    },
  },
  beads: {
    // The deployment's beads endpoint; absent means the service is unavailable,
    // which the broker reports instead of guessing a host.
    host: "",
    hostEnv: "BEADS_API_HOST",
    credentialEnv: "BEADS_TOKEN",
    headers: (credential) => ({
      authorization: `Bearer ${credential}`,
      accept: "application/json",
    }),
    repositoryEncoding: "slash",
    actions: {
      "task.create": {
        method: "POST",
        route: "/repos/{repository}/tasks",
        bodyParams: ["title", "description", "priority", "assignee", "status"],
      },
      "task.update": {
        method: "PATCH",
        route: "/repos/{repository}/tasks/{taskId}",
        pathParams: ["taskId"],
        bodyParams: ["title", "description", "priority", "assignee", "status"],
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
  /** Deployment configuration, used only to resolve a `hostEnv` service. */
  env?: Readonly<Record<string, unknown>>;
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
  | { ok: false; status: 400 | 403 | 503; reason: string };

export function resolveRequest(input: ResolveInput): ResolvedRequest {
  const service = SERVICES[input.service];
  if (!service) return { ok: false, status: 403, reason: "unknown service" };

  let host = service.host;
  if (service.hostEnv !== undefined) {
    const configured = input.env?.[service.hostEnv];
    host = typeof configured === "string" ? configured.trim() : "";
    if (host.length === 0) {
      return { ok: false, status: 503, reason: `${input.service} is not configured on this deployment` };
    }
  }

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

  let bodyValues: Record<string, unknown> = {};
  if (action.body !== undefined) {
    const built: Record<string, string | number> = {};
    for (const name of action.bodyParams ?? []) {
      const value = params[name];
      if (value === undefined) continue;
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        built[name] = value;
        continue;
      }
      if (typeof value === "string" && isSafeTextValue(value)) {
        built[name] = value;
        continue;
      }
      return { ok: false, status: 400, reason: `parameter ${name} is not a usable value` };
    }
    bodyValues = action.body(built);
  } else {
    for (const name of action.bodyParams ?? []) {
      const value = params[name];
      if (value === undefined) continue;
      if (typeof value !== "string" || !isSafeBodyValue(value, action.allowMultiline ?? false)) {
        return { ok: false, status: 400, reason: `parameter ${name} must be a safe string` };
      }
      bodyValues[name] = value;
    }
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
    url: `https://${host}${route}`,
    method: action.method,
    headers: {
      ...(hasBody ? { "content-type": "application/json" } : {}),
      ...(action.headers ?? {}),
    },
    body: hasBody ? JSON.stringify(bodyValues) : undefined,
    service: input.service,
    action: input.action,
  };
}

/** Credential lookup happens here so no caller can substitute its own value. */
export function credentialEnvFor(service: string): string | null {
  return SERVICES[service]?.credentialEnv ?? null;
}

/**
 * Whether a per-repository override may name this binding as the credential for
 * `service`. Defaults to the service's own `credentialEnv` or a sibling of it
 * (`GITHUB_TOKEN_INSTALL_2`), which covers multiple installations while keeping
 * every non-credential secret — `BROKER_SIGNING_KEY`, `BROKER_CONTROL_KEY`,
 * `WEBHOOK_SECRET`, another service's token — unselectable (finding
 * cloud-factory-cf-ccj).
 */
export function isApprovedCredentialBinding(service: string, binding: string): boolean {
  const definition = SERVICES[service];
  if (!definition) return false;
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(binding)) return false;
  if (binding.startsWith("BROKER_") || binding.startsWith("WEBHOOK_")) return false;
  if (binding === definition.credentialEnv) return true;
  // A sibling binding under the service's credential prefix, e.g.
  // GITHUB_TOKEN_INSTALL_2. The suffix must be non-empty.
  return new RegExp(`^${definition.credentialEnv}_[A-Z0-9_]+$`).test(binding);
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

/** The ceiling for a builder-owned string param (a review prompt can be large). */
const MAX_BUILT_BODY_CHARS = 400_000;

/**
 * A value a body builder may carry: newlines and tabs are fine (a prompt, a review),
 * no other control characters are, and it stays bounded.
 */
function isSafeTextValue(value: string): boolean {
  if (value.length > MAX_BUILT_BODY_CHARS) return false;
  return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function isSafeBodyValue(value: string, allowMultiline = false): boolean {
  const maxLen = allowMultiline ? 64_000 : 8_000;
  if (value.length > maxLen) return false;
  if (allowMultiline) {
    return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
  }
  // No control characters (newline/CR are refused to keep header and log
  // injection impossible even after the value is echoed back).
  return !/[\u0000-\u0008\u000a-\u001f\u007f]/.test(value);
}
