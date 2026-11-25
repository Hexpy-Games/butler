export const BT_COOKIE = "bt";
const FORWARD = ["accept", "accept-language", "range", "if-range", "if-none-match", "if-modified-since"];
const DROP = new Set(["connection", "keep-alive", "transfer-encoding", "set-cookie"]);

export type ProxyAuth = { ok: false } | { ok: true; path: string; setCookie: boolean };

/** Constant time for equal lengths; the length itself is public (always 43). */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function cookieValue(header: string | undefined, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** Content listener: valid ?bt= (then set the cookie) or cookie bt. The bt parameter never reaches the desktop. */
export function contentAuth(token: string, target: string, cookie: string | undefined): ProxyAuth {
  const q = target.indexOf("?");
  const path = q < 0 ? target : target.slice(0, q);
  const params = q < 0 ? [] : target.slice(q + 1).split("&");
  const query = params.find(param => param.startsWith("bt="))?.slice(3) ?? null;
  const rest = params.filter(param => param !== "bt" && !param.startsWith("bt="));
  const byQuery = query !== null && safeEqual(query, token);
  const byCookie = safeEqual(cookieValue(cookie, BT_COOKIE) ?? "", token);
  if (!path.startsWith("/") || (!byQuery && !byCookie)) return { ok: false };
  return { ok: true, path: path + (rest.length ? `?${rest.join("&")}` : ""), setCookie: byQuery };
}

/** API listener: `/<token>/<gateway path>`. */
export function apiAuth(token: string, target: string): ProxyAuth {
  const segment = target.slice(1, 1 + token.length);
  if (!target.startsWith("/") || target[1 + token.length] !== "/" || !safeEqual(segment, token)) return { ok: false };
  return { ok: true, path: target.slice(1 + token.length), setCookie: false };
}

export function forwardHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(FORWARD.filter(name => headers[name] !== undefined).map(name => [name, headers[name]]));
}

/** Desktop response headers minus hop-by-hop, cookies and any CORS header; plus the HttpOnly bt cookie after a query-authorized request. */
export function responseHeaders(headers: Record<string, string>, cookieToken: string | null): Record<string, string> {
  const out = Object.fromEntries(Object.entries(headers).filter(([name]) => !DROP.has(name) && !name.startsWith("access-control-")));
  if (cookieToken) out["set-cookie"] = `${BT_COOKIE}=${cookieToken}; HttpOnly; SameSite=Strict; Path=/`;
  return out;
}
