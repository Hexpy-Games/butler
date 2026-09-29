// Wallpaper requests to the gateway: the desktop app goes through the preload
// bridge (it adds the local bearer token and answers with `{ ok, data | error }`
// envelopes); the browser build uses same-origin fetch.

/** A failed wallpaper request: `code` (gateway error code) and HTTP `status` when known, never raw server text. */
export function wallpaperRequestError(code: unknown, status: unknown): Error {
  return Object.assign(new Error("Wallpaper request failed."), {
    code: typeof code === "string" ? code : "request_failed",
    ...(typeof status === "number" ? { status } : {}),
  });
}

type BridgeMethod = (input?: unknown) => Promise<unknown>;

export function wallpaperBridgeMethod(name: string): BridgeMethod | null {
  const bridge = typeof window === "undefined" ? undefined : (window as { butlerApp?: Record<string, unknown> }).butlerApp;
  const method = bridge?.[name];
  return typeof method === "function" ? (method as BridgeMethod) : null;
}

/** A preload result envelope (`{ ok, data | error }`); plain values pass through. */
export function unwrapWallpaperBridge<T>(value: unknown): T {
  if (!value || typeof value !== "object" || !("ok" in value)) return value as T;
  const result = value as { ok: boolean; data?: T; error?: { code?: unknown; status?: unknown } };
  if (result.ok) return result.data as T;
  throw wallpaperRequestError(result.error?.code, result.error?.status);
}

/** The error of a failed fetch response (its JSON `error.code` when there is one). */
export async function wallpaperResponseError(response: Response): Promise<Error> {
  const body = (await response.json().catch(() => null)) as { error?: { code?: unknown } } | null;
  return wallpaperRequestError(body?.error?.code, response.status);
}

/** A JSON request: the named bridge method on desktop, else fetch of `path`; resolves the envelope's `data`. */
export async function wallpaperGatewayRequest<T>(bridge: string, input: unknown, path: string, init?: RequestInit): Promise<T> {
  const method = wallpaperBridgeMethod(bridge);
  if (method) return unwrapWallpaperBridge<T>(await method(input));
  const response = await fetch(path, init);
  const body = (await response.json().catch(() => null)) as { data?: T; error?: { code?: unknown } } | null;
  if (!response.ok) throw wallpaperRequestError(body?.error?.code, response.status);
  return body?.data as T;
}
