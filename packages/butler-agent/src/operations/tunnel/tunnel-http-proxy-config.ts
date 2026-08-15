import { timingSafeEqual } from "node:crypto";
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  OutgoingHttpHeaders,
  ServerResponse,
} from "node:http";

/** Headers that belong to one hop and must not cross the tunnel boundary. */
export const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "host",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export const DEFAULT_BOOTSTRAP_PATH = "/__butler_tunnel_bootstrap.js";
export const DEFAULT_MAX_HTML_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MAX_BUFFERED_BYTES = 64 * 1024;

export interface TunnelProxyAuthConfig {
  basicUsername?: string;
  basicPassword?: string;
  sessionSecret?: string;
  loginToken?: string;
  upstreamBearerToken?: string;
}

export interface TunnelProxyConfig {
  listenHost: string;
  listenPort: number;
  upstream: URL;
  auth?: TunnelProxyAuthConfig;
  bootstrapPath?: string;
  bootstrapScript?: string;
  maxHtmlBytes?: number;
  maxBufferedBytes?: number;
  rewriteHtml?: (html: string) => string;
  clientDisconnectSignal?: AbortSignal;
}

export interface NormalizedTunnelProxyConfig extends TunnelProxyConfig {
  auth: TunnelProxyAuthConfig;
  bootstrapPath: string;
  bootstrapScript: string;
  maxHtmlBytes: number;
  maxBufferedBytes: number;
}

/** A no-state bootstrap used by the packaged tunnel entrypoint. */
export const DEFAULT_BOOTSTRAP_SCRIPT = `(() => {
  const key = "butler:first-run-setup:v1";
  const complete = {
    schema: "butler.app.first-run.v1",
    status: "complete",
    language: navigator.languages?.some((language) => String(language).toLowerCase().startsWith("ko")) ? "ko" : "en",
    step: "model",
    language_confirmed: true,
    safety_accepted: true,
    install_status: "ready",
    connection_mode: "bundled-agent",
    completed_at: new Date().toISOString()
  };
  try {
    const current = JSON.parse(localStorage.getItem(key) || "null");
    if (current?.status !== "complete") localStorage.setItem(key, JSON.stringify(complete));
  } catch {
    localStorage.setItem(key, JSON.stringify(complete));
  }
})();
`;

export function normalizeTunnelProxyConfig(
  config: TunnelProxyConfig,
): NormalizedTunnelProxyConfig {
  if (!/^https?:$/u.test(config.upstream.protocol)) {
    throw new Error("Tunnel upstream must use http: or https:.");
  }
  if (!Number.isInteger(config.listenPort) || config.listenPort < 0 ||
    config.listenPort > 65_535) {
    throw new Error("Tunnel listenPort must be an integer between 0 and 65535.");
  }
  const auth = config.auth ?? {};
  const hasBasicUsername = Boolean(auth.basicUsername?.trim());
  const hasBasicPassword = Boolean(auth.basicPassword?.trim());
  if (hasBasicUsername !== hasBasicPassword) {
    throw new Error("Tunnel Basic auth requires both username and password.");
  }
  return {
    ...config,
    auth,
    bootstrapPath: config.bootstrapPath?.trim() || DEFAULT_BOOTSTRAP_PATH,
    bootstrapScript: config.bootstrapScript ?? DEFAULT_BOOTSTRAP_SCRIPT,
    maxHtmlBytes: normalizedPositiveInteger(config.maxHtmlBytes, DEFAULT_MAX_HTML_BYTES),
    maxBufferedBytes: normalizedPositiveInteger(
      config.maxBufferedBytes,
      DEFAULT_MAX_BUFFERED_BYTES,
    ),
  };
}

function normalizedPositiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || (value ?? 0) <= 0) return fallback;
  return Math.max(1, Math.floor(value as number));
}

function safeEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer);
}

function basicHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function sessionCookieValue(request: IncomingMessage): string | null {
  const cookieHeader = request.headers.cookie ?? "";
  for (const part of cookieHeader.split(";")) {
    const [name, ...valueParts] = part.trim().split("=");
    if (name !== "butler_tunnel_auth") continue;
    try {
      return decodeURIComponent(valueParts.join("="));
    } catch {
      return null;
    }
  }
  return null;
}

export function isTunnelRequestAuthorized(
  request: IncomingMessage,
  auth: TunnelProxyAuthConfig,
): boolean {
  const username = auth.basicUsername?.trim();
  const password = auth.basicPassword?.trim();
  const sessionSecret = auth.sessionSecret?.trim();
  if (!username && !password && !sessionSecret) return true;
  if (username && password && safeEqual(
    request.headers.authorization ?? "",
    basicHeader(username, password),
  )) return true;
  return Boolean(sessionSecret && sessionCookieValue(request) !== null &&
    safeEqual(sessionCookieValue(request) ?? "", sessionSecret));
}

export function setTunnelSessionCookie(
  headers: OutgoingHttpHeaders,
  auth: TunnelProxyAuthConfig,
): OutgoingHttpHeaders {
  const sessionSecret = auth.sessionSecret?.trim();
  if (!sessionSecret) return headers;
  const cookie = `butler_tunnel_auth=${encodeURIComponent(sessionSecret)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`;
  const existing = headers["set-cookie"];
  return {
    ...headers,
    "set-cookie": Array.isArray(existing)
      ? [...existing, cookie]
      : existing
        ? [String(existing), cookie]
        : [cookie],
  };
}

export function forwardedTunnelRequestHeaders(
  headers: IncomingHttpHeaders,
  upstream: URL,
  upstreamBearerToken?: string,
): OutgoingHttpHeaders {
  const forwarded: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase()) || value === undefined) continue;
    forwarded[name] = value;
  }
  forwarded.host = upstream.host;
  if (upstreamBearerToken?.trim()) {
    forwarded.authorization = `Bearer ${upstreamBearerToken.trim()}`;
  } else {
    delete forwarded.authorization;
  }
  return forwarded;
}

export function forwardedTunnelResponseHeaders(
  headers: IncomingHttpHeaders,
): OutgoingHttpHeaders {
  const forwarded: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase()) || value === undefined) continue;
    forwarded[name] = value;
  }
  return forwarded;
}

export function rejectTunnelUnauthorized(response: ServerResponse): void {
  response.writeHead(401, {
    "www-authenticate": 'Basic realm="Butler Tunnel"',
    "cache-control": "no-store",
    "content-type": "text/plain; charset=utf-8",
  });
  response.end("Authentication required.\n");
}

export function rewriteTunnelHtml(html: string, bootstrapPath: string): string {
  const bootstrapTag = `<script src="${bootstrapPath}"></script>`;
  if (html.includes(bootstrapTag)) return html;
  const moduleTag = '<script type="module"';
  const moduleIndex = html.indexOf(moduleTag);
  if (moduleIndex >= 0) {
    return `${html.slice(0, moduleIndex)}${bootstrapTag}\n    ${html.slice(moduleIndex)}`;
  }
  const bodyEnd = html.toLowerCase().lastIndexOf("</body>");
  if (bodyEnd >= 0) {
    return `${html.slice(0, bodyEnd)}${bootstrapTag}\n${html.slice(bodyEnd)}`;
  }
  return `${html}${bootstrapTag}`;
}

function envString(env: Record<string, string | undefined>, name: string): string | undefined {
  const value = env[name]?.trim();
  return value || undefined;
}

function envInteger(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const value = Number(envString(env, name));
  return Number.isFinite(value) ? Math.floor(value) : fallback;
}

/** Build deployable proxy configuration without reading credential files. */
export function tunnelProxyConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): TunnelProxyConfig {
  const upstream = envString(env, "BUTLER_TUNNEL_PROXY_UPSTREAM");
  if (!upstream) throw new Error("BUTLER_TUNNEL_PROXY_UPSTREAM is required.");
  return {
    listenHost: envString(env, "BUTLER_TUNNEL_PROXY_HOST") ?? "127.0.0.1",
    listenPort: envInteger(env, "BUTLER_TUNNEL_PROXY_PORT", 18_766),
    upstream: new URL(upstream),
    auth: {
      basicUsername: envString(env, "BUTLER_TUNNEL_PROXY_USERNAME"),
      basicPassword: envString(env, "BUTLER_TUNNEL_PROXY_PASSWORD"),
      sessionSecret: envString(env, "BUTLER_TUNNEL_PROXY_SESSION_SECRET"),
      loginToken: envString(env, "BUTLER_TUNNEL_PROXY_LOGIN_TOKEN"),
      upstreamBearerToken: envString(
        env,
        "BUTLER_TUNNEL_PROXY_UPSTREAM_BEARER_TOKEN",
      ),
    },
    bootstrapPath: envString(env, "BUTLER_TUNNEL_PROXY_BOOTSTRAP_PATH"),
    maxHtmlBytes: envInteger(
      env,
      "BUTLER_TUNNEL_PROXY_MAX_HTML_BYTES",
      DEFAULT_MAX_HTML_BYTES,
    ),
    maxBufferedBytes: envInteger(
      env,
      "BUTLER_TUNNEL_PROXY_MAX_BUFFERED_BYTES",
      DEFAULT_MAX_BUFFERED_BYTES,
    ),
  };
}
