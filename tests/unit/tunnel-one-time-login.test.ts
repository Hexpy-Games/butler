import { afterEach, expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTunnelProxyServer, issueTunnelLoginLink } from "../../packages/butler-agent/src/operations/tunnel/tunnel-http-proxy.ts";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function setup() {
  const directory = mkdtempSync(join(tmpdir(), "butler-login-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const upstream = createServer((_req, res) => res.end("protected application"));
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>(resolve => upstream.close(() => resolve())));
  const address = upstream.address() as { port: number };
  const config = {
    listenHost: "127.0.0.1", listenPort: 0, upstream: new URL(`http://127.0.0.1:${address.port}`),
    auth: { basicUsername: "user", basicPassword: "pass", sessionSecret: "existing-session", loginToken: "legacy", oneTimeLoginDirectory: directory },
  };
  const proxy = await createTunnelProxyServer(config);
  cleanup.push(() => proxy.close());
  const link = issueTunnelLoginLink(directory, "https://butler.example");
  const token = new URL(link.url).hash.slice(1);
  const endpoint = `${proxy.endpoint}/__butler_tunnel_login`;
  const redeem = (value = token, headers = {}) => fetch(endpoint, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ token: value }),
  });
  return { proxy, directory, config, link, token, endpoint, redeem };
}

test("preview-safe link redeems once under concurrency and retains Basic/session access", async () => {
  const s = await setup();
  expect(s.link.expiresAt - Date.now()).toBeGreaterThan(590_000);
  expect(s.link.expiresAt - Date.now()).toBeLessThanOrEqual(600_000);
  const file = join(s.directory, readdirSync(s.directory)[0]!);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(readFileSync(file, "utf8")).not.toContain(s.token);
  for (const method of ["GET", "HEAD"]) {
    const preview = await fetch(`${s.endpoint}?token=legacy`, { method });
    expect(preview.status).toBe(200);
    expect(preview.headers.get("set-cookie")).toBeNull();
    expect(preview.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  }
  expect((await s.redeem("legacy")).status).toBe(403);
  const responses = await Promise.all([s.redeem(), s.redeem()]);
  expect(responses.map(r => r.status).sort()).toEqual([204, 403]);
  const cookie = responses.find(r => r.status === 204)!.headers.get("set-cookie")!;
  expect(cookie).toContain("HttpOnly; Secure; SameSite=Lax");
  expect((await fetch(s.proxy.endpoint)).status).toBe(401);
  const accessHeaders: Array<Record<string, string>> = [
    { cookie: cookie.split(";")[0]! },
    { cookie: "butler_tunnel_auth=existing-session" },
    { authorization: `Basic ${Buffer.from("user:pass").toString("base64")}` },
  ];
  for (const headers of accessHeaders) {
    expect(await (await fetch(s.proxy.endpoint, { headers })).text()).toBe("protected application");
  }
  await s.proxy.close();
  const restarted = await createTunnelProxyServer(s.config);
  cleanup.push(() => restarted.close());
  expect((await fetch(`${restarted.endpoint}/__butler_tunnel_login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: s.token }) })).status).toBe(403);
});

test("expired links are refused without creating a session", async () => {
  const s = await setup();
  writeFileSync(join(s.directory, readdirSync(s.directory)[0]!), JSON.stringify({ expiresAt: Date.now() - 1 }));
  const response = await s.redeem();
  expect(response.status).toBe(403);
  expect(response.headers.get("set-cookie")).toBeNull();
});

test("cross-origin, oversized and malformed requests cannot consume a valid link", async () => {
  const s = await setup();
  expect((await s.redeem(s.token, { origin: "https://attacker.example" })).status).toBe(403);
  expect((await s.redeem("x".repeat(300))).status).toBe(413);
  expect((await fetch(s.endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: "null" })).status).toBe(400);
  expect((await s.redeem()).status).toBe(204);
});
