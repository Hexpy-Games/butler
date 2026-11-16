export const PROTOCOL_VERSION = "butler.app.v1";

/** What a Butler address answered, from the app's point of view. */
export type ProbeResult =
  | { kind: "ready" }
  | { kind: "needs_pairing" }
  | { kind: "host_not_allowed" }
  | { kind: "protocol_mismatch"; server: string }
  | { kind: "error"; code: string }
  | { kind: "not_butler" }
  | { kind: "unreachable" };

/** The origin the user typed, with http:// when no scheme was given; null when it is not a plain http(s) origin. */
export function butlerOrigin(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.pathname !== "/"
      || url.search || url.hash || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Maps a gateway response to a ProbeResult. Bodies use the envelope {protocol_version, data | error:{code}}. */
export function classify(status: number, body: unknown): ProbeResult {
  if (typeof body !== "object" || body === null || !("protocol_version" in body)
    || typeof body.protocol_version !== "string") return { kind: "not_butler" };
  if (body.protocol_version !== PROTOCOL_VERSION) {
    return { kind: "protocol_mismatch", server: body.protocol_version };
  }
  if (status >= 200 && status <= 299) return { kind: "ready" };
  const error = "error" in body ? body.error : null;
  const code = typeof error === "object" && error !== null && "code" in error
    && typeof error.code === "string" ? error.code : `http_${status}`;
  if (code === "local_auth_required") return { kind: "needs_pairing" };
  if (code === "host_not_allowed") return { kind: "host_not_allowed" };
  return { kind: "error", code };
}

/** GET <origin>/health, with the device token when there is one. */
export async function probe(origin: string, token?: string, timeoutMs = 5000): Promise<ProbeResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${origin}/health`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: controller.signal,
    });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return classify(response.status, body);
  } catch {
    return { kind: "unreachable" };
  } finally {
    clearTimeout(timeout);
  }
}
