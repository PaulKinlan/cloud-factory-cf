import {
  credentialHeadersFor,
  credentialEnvFor,
  resolveRequest,
  type HttpMethod,
} from "./policy";

/**
 * The only place a real credential is attached to a request.
 *
 * Callers pass a *capability-shaped* intent (service/action/repository/params),
 * never a URL, a method or a header. Everything the agent receives back is
 * scrubbed: upstream auth headers are dropped, and any echo of the credential in
 * the response body is replaced with `[redacted]`.
 */

export const MAX_RESPONSE_BYTES = 64 * 1024;

export interface BrokerRequest {
  service: string;
  action: string;
  repository: string;
  params?: Record<string, unknown>;
}

export interface BrokerExecution {
  status: number;
  body: string;
  truncated: boolean;
  redactions: number;
  durationMs: number;
  service: string;
  action: string;
  method: HttpMethod;
  url: string;
}

export type BrokerOutcome =
  | { ok: true; execution: BrokerExecution }
  | { ok: false; status: 400 | 403 | 502 | 503; reason: string };

export async function executeSignedRequest(
  request: BrokerRequest,
  options: { fetchImpl: typeof fetch; readCredential: (envName: string) => string | undefined },
): Promise<BrokerOutcome> {
  const resolved = resolveRequest(request);
  if (!resolved.ok) return { ok: false, status: resolved.status, reason: resolved.reason };

  const envName = credentialEnvFor(request.service);
  const credential = envName ? options.readCredential(envName) : undefined;
  if (!envName || !credential) {
    return { ok: false, status: 503, reason: "credential not configured for this service" };
  }

  const headers: Record<string, string> = {
    ...resolved.headers,
    ...credentialHeadersFor(request.service, credential),
  };

  const startedAt = Date.now();
  let response: Response;
  try {
    response = await options.fetchImpl(resolved.url, {
      method: resolved.method,
      headers,
      body: resolved.body,
      redirect: "manual",
    });
  } catch {
    // Never surface the upstream error text: fetch errors can echo the request,
    // and the request carries the credential.
    return { ok: false, status: 502, reason: "upstream request failed" };
  }
  const durationMs = Date.now() - startedAt;

  const raw = await response.text();
  const scrubbed = redact(raw, [credential, encodeURIComponent(credential)]);
  const truncated = scrubbed.text.length > MAX_RESPONSE_BYTES;

  return {
    ok: true,
    execution: {
      status: response.status,
      body: truncated ? `${scrubbed.text.slice(0, MAX_RESPONSE_BYTES)}…[truncated]` : scrubbed.text,
      truncated,
      redactions: scrubbed.redactions,
      durationMs,
      service: resolved.service,
      action: resolved.action,
      method: resolved.method,
      url: resolved.url,
    },
  };
}

export function redact(
  value: string,
  secrets: readonly string[],
): { text: string; redactions: number } {
  let text = value;
  let redactions = 0;
  for (const secret of secrets) {
    if (!secret || secret.length < 6) continue;
    const parts = text.split(secret);
    redactions += parts.length - 1;
    text = parts.join("[redacted]");
  }
  return { text, redactions };
}
