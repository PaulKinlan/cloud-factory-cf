/**
 * Stop the browser holding the platform control key (cloud-factory-cf-2gsy).
 *
 * The connect dialog, the share panel and the admin panel all accept the operator's
 * control key in a text input. The key is a server secret, and this origin is full of
 * `innerHTML` sinks, so any injected script that can read an input's value also reads the
 * master key. Sending it with every request keeps it in JS memory for the whole session as
 * well, which is strictly worse than the one moment it is typed.
 *
 * `/api/auth/root-login` already exists for exactly this: presenting the key once returns
 * an HttpOnly session cookie, and every control-plane route accepts that session for its
 * own login (root may address any tenant). So the browser's job is to exchange the key once
 * and then forget it - clear the field, send no key header, let the cookie do the work.
 *
 * A key that the server refuses is NOT a session, so it is left in place and the caller
 * keeps its existing behaviour (send the header, and let the route answer 401), which keeps
 * the failure messages operators already know.
 */
export type ControlKeyAdoption = "none" | "session" | "key";

export interface ControlKeyAdoptionResult {
  /** What the caller should do: send nothing, rely on the session cookie, or send the key. */
  mode: ControlKeyAdoption;
  /** The key still in the field, when `mode` is "key" - never stored anywhere else. */
  key?: string;
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Present `key` to the worker once. On success the session cookie is set by the response
 * (HttpOnly, so script cannot read it), the input is cleared, and the caller must not send
 * the key again. On refusal nothing is cleared and the caller keeps its legacy behaviour.
 */
export async function adoptControlKey(
  key: string | null | undefined,
  fetchImpl: FetchLike = fetch,
  base = "",
): Promise<ControlKeyAdoptionResult> {
  const trimmed = (key ?? "").trim();
  if (trimmed.length === 0) return { mode: "none" };

  try {
    const res = await fetchImpl(`${base}/api/auth/root-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ controlKey: trimmed }),
    });
    if (res.ok) return { mode: "session" };
  } catch {
    // Network failure: fall through to the legacy path rather than pretending to be authed.
  }
  return { mode: "key", key: trimmed };
}

/** Convenience for call sites that hold an input element: exchanges and clears it. */
export async function adoptControlKeyFromInput(
  input: HTMLInputElement | null | undefined,
  fetchImpl: FetchLike = fetch,
  base = "",
): Promise<ControlKeyAdoptionResult> {
  if (!input) return { mode: "none" };
  const result = await adoptControlKey(input.value, fetchImpl, base);
  if (result.mode === "session") input.value = "";
  return result;
}

/** Build the header map for a request, sending the key only when no session was obtained. */
export function controlKeyHeaders(
  result: ControlKeyAdoptionResult,
  headers: Record<string, string> = {},
): Record<string, string> {
  if (result.mode === "key" && result.key) headers["x-factory-control-key"] = result.key;
  return headers;
}
