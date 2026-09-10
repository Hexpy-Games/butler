import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { setTunnelSessionCookie, type TunnelProxyAuthConfig } from "./tunnel-http-proxy-config.ts";

const LOGIN_PATH = "/__butler_tunnel_login";
const LINK_TTL_MS = 10 * 60 * 1000;
const MAX_BODY_BYTES = 256;

/** Local operator only. The raw capability is returned once, never persisted. */
export function issueTunnelLoginLink(directory: string, origin: string): { url: string; expiresAt: number } {
  const base = new URL(origin);
  if (base.protocol !== "https:" || base.username || base.password) {
    throw new Error("Login links require an HTTPS origin without credentials.");
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + LINK_TTL_MS;
  writeFileSync(tokenPath(directory, token), JSON.stringify({ expiresAt }), { mode: 0o600, flag: "wx" });
  return { url: `${base.origin}${LOGIN_PATH}#${token}`, expiresAt };
}

function tokenPath(directory: string, token: string): string {
  return join(directory, `${createHash("sha256").update(token).digest("hex")}.json`);
}

function consumeToken(directory: string, token: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) return false;
  const path = tokenPath(directory, token);
  const claimed = `${path}.${randomUUID()}.consumed`;
  try {
    // Atomic across processes. A restart never makes a claimed record available.
    renameSync(path, claimed);
  } catch {
    return false;
  }
  try {
    const record = JSON.parse(readFileSync(claimed, "utf8")) as { expiresAt?: unknown };
    return typeof record.expiresAt === "number" && Number.isFinite(record.expiresAt) &&
      Date.now() < record.expiresAt && record.expiresAt <= Date.now() + LINK_TTL_MS;
  } catch {
    return false;
  } finally {
    try { unlinkSync(claimed); } catch { /* Claimed names cannot be redeemed. */ }
  }
}

const LOGIN_SCRIPT = `let token = location.hash.slice(1);
history.replaceState(null, '', location.pathname);
const ko = navigator.language.toLowerCase().startsWith('ko');
const button = document.querySelector('button');
const status = document.querySelector('p');
document.documentElement.lang = ko ? 'ko' : 'en';
button.textContent = ko ? 'Butler 로그인' : 'Log in to Butler';
status.textContent = ko ? '10분 안에 한 번만 사용할 수 있는 로그인 링크입니다.' : 'This login link can be used once within ten minutes.';
button.disabled = !token;
button.onclick = async () => {
  button.disabled = true;
  try {
    const response = await fetch(location.pathname, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({token}) });
    token = '';
    if (response.ok) { location.replace('/'); return; }
  } catch {}
  status.textContent = ko ? '만료되었거나 사용할 수 없는 링크입니다. 새 링크를 요청해 주세요.' : 'This link is expired or unavailable. Please request a new link.';
};`;
const SCRIPT_HASH = createHash("sha256").update(LOGIN_SCRIPT).digest("base64");
const LOGIN_PAGE = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Butler login</title><body><main><h1>Butler</h1><p role="status"></p><button type="button" disabled>Log in to Butler</button></main><script>${LOGIN_SCRIPT}</script></body></html>`;

/** This route entirely replaces reusable URL-token login; GET is preview-safe. */
export function handleTunnelLogin(request: IncomingMessage, response: ServerResponse, auth: TunnelProxyAuthConfig): void {
  const headers = {
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "content-security-policy": `default-src 'none'; script-src 'sha256-${SCRIPT_HASH}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
  };
  if (request.method === "GET" || request.method === "HEAD") {
    request.resume();
    response.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8" });
    response.end(request.method === "HEAD" ? undefined : LOGIN_PAGE);
    return;
  }
  const reject = (status: number) => {
    request.resume();
    response.writeHead(status, headers);
    response.end("Login link unavailable.\n");
  };
  if (request.method !== "POST") { reject(405); return; }
  const origin = request.headers.origin;
  if (request.headers["sec-fetch-site"] === "cross-site" ||
    (origin && origin !== `https://${request.headers.host}` && origin !== `http://${request.headers.host}`)) {
    reject(403); return;
  }
  if (request.headers["content-type"] !== "application/json") { reject(415); return; }
  if (!auth.oneTimeLoginDirectory || !auth.sessionSecret?.trim()) { reject(403); return; }
  let body = "";
  let size = 0;
  request.on("error", () => response.destroy());
  request.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size <= MAX_BODY_BYTES) body += chunk.toString("utf8");
    else if (!response.writableEnded) reject(413);
  });
  request.on("end", () => {
    if (response.writableEnded || response.destroyed) return;
    let token: unknown;
    try { token = (JSON.parse(body) as { token?: unknown }).token; } catch { reject(400); return; }
    if (typeof token !== "string" || !consumeToken(auth.oneTimeLoginDirectory!, token)) { reject(403); return; }
    response.writeHead(204, setTunnelSessionCookie(headers, auth));
    response.end();
  });
}
