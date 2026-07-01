const DEFAULT_DEV_CORS_ORIGIN = "http://127.0.0.1:5173";

export interface DevCorsPolicy {
  origins: Set<string>;
  allowLocalLoopback: boolean;
}

export function normalizeDevCorsPolicy(value?: string): DevCorsPolicy {
  const configuredOrigins = String(value ?? "")
    .split(",")
    .map((origin) => normalizeLocalHttpOrigin(origin.trim()))
    .filter((origin): origin is string => Boolean(origin));
  if (configuredOrigins.length > 0) {
    return { origins: new Set(configuredOrigins), allowLocalLoopback: false };
  }
  return {
    origins: new Set([DEFAULT_DEV_CORS_ORIGIN]),
    allowLocalLoopback: true,
  };
}

export function devCorsHeaders(
  request: Request,
  devCorsPolicy: DevCorsPolicy,
): Record<string, string> {
  const origin = request.headers.get("origin");
  const normalizedOrigin = normalizeLocalHttpOrigin(origin ?? undefined);
  if (!normalizedOrigin) return {};
  const allowed =
    devCorsPolicy.origins.has(normalizedOrigin) ||
    devCorsPolicy.allowLocalLoopback;
  if (!allowed) return {};
  return {
    "access-control-allow-origin": normalizedOrigin,
    vary: "Origin",
  };
}

export function withExtraHeaders(
  response: Response,
  extraHeaders: HeadersInit,
): Response {
  const extra = new Headers(extraHeaders);
  if ([...extra.keys()].length === 0) return response;
  const headers = new Headers(response.headers);
  extra.forEach((value, key) => headers.set(key, value));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function normalizeLocalHttpOrigin(value?: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLocaleLowerCase("en-US");
    const isLocalhost =
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1";
    if (url.protocol !== "http:" || !isLocalhost) return null;
    return url.origin;
  } catch {
    return null;
  }
}
