import {
  afterEach,
  expect,
  test,
} from "bun:test";
import {
  createServer,
  type Server,
} from "node:http";
import { createConnection, type AddressInfo } from "node:net";
import {
  createTunnelProxyServer,
  tunnelProxyConfigFromEnv,
  type TunnelProxyServer,
} from "../../packages/butler-agent/src/operations/tunnel/tunnel-http-proxy.ts";
import {
  readTunnelProxyServiceConfig,
  tunnelProxyEnvironmentFromServiceConfig,
  tunnelProxyServiceConfigPath,
  writeTunnelProxyServiceConfigFromEnv,
} from "../../packages/butler-agent/src/operations/tunnel/tunnel-service-config.ts";
import { rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const resources: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  for (const resource of resources.splice(0).reverse()) {
    await resource.close().catch(() => undefined);
  }
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

async function startProxy(
  upstream: string,
  options: Partial<Parameters<typeof createTunnelProxyServer>[0]> = {},
): Promise<TunnelProxyServer> {
  const proxy = await createTunnelProxyServer({
    listenHost: "127.0.0.1",
    listenPort: 0,
    upstream: new URL(upstream),
    ...options,
  });
  resources.push(proxy);
  return proxy;
}

function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
  description = "tunnel proxy state",
): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(`Timed out waiting for ${description}.`));
        return;
      }
      setTimeout(check, 5);
    };
    check();
  });
}

test("downstream disconnect destroys the upstream request and response", async () => {
  let activeUpstreamRequests = 0;
  let upstreamClosed = false;
  const upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      activeUpstreamRequests += 1;
      request.signal.addEventListener("abort", () => {
        activeUpstreamRequests -= 1;
        upstreamClosed = true;
      }, { once: true });
      let interval: ReturnType<typeof setInterval> | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: first\n\n"));
          interval = setInterval(() => {
            try {
              controller.enqueue(new TextEncoder().encode("data: keep-alive\n\n"));
            } catch {
              if (interval) clearInterval(interval);
            }
          }, 5);
        },
        cancel() {
          if (interval) clearInterval(interval);
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });
  const upstreamUrl = `http://127.0.0.1:${upstream.port}`;
  resources.push({ close: async () => { upstream.stop(true); } });
  const disconnectController = new AbortController();
  const proxy = await startProxy(upstreamUrl, {
    clientDisconnectSignal: disconnectController.signal,
  });

  const proxyUrl = new URL(proxy.endpoint);
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({
      host: proxyUrl.hostname,
      port: Number(proxyUrl.port),
    });
    socket.once("error", reject);
    socket.once("data", () => {
      socket.destroy();
      disconnectController.abort();
      resolve();
    });
    socket.write("GET /events HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
  });

  await waitFor(() => upstreamClosed && activeUpstreamRequests === 0 &&
    proxy.activeRequests() === 0, 2_000,
  `downstream cleanup (upstreamClosed=${upstreamClosed}, activeUpstreamRequests=${activeUpstreamRequests}, proxyActive=${proxy.activeRequests()})`);
  expect(activeUpstreamRequests).toBe(0);
  expect(proxy.activeRequests()).toBe(0);
});

test("upstream connection errors settle the downstream with a bounded 502", async () => {
  const upstream = createServer((_request, response) => {
    response.socket?.destroy();
  });
  const upstreamUrl = await listen(upstream);
  resources.push({ close: () => closeServer(upstream) });
  const proxy = await startProxy(upstreamUrl);

  const response = await fetch(`${proxy.endpoint}/unavailable`);
  expect(response.status).toBe(502);
  expect(await response.text()).toBe("Tunnel upstream unavailable.\n");
  expect(proxy.activeRequests()).toBe(0);
});

test("slow downstream consumers apply bounded pipe backpressure upstream", async () => {
  let upstreamBackpressured = false;
  let activeUpstreamRequests = 0;
  const upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      activeUpstreamRequests += 1;
      request.signal.addEventListener("abort", () => {
        activeUpstreamRequests -= 1;
      }, { once: true });
      let remaining = 200;
      const chunk = new Uint8Array(32 * 1_024).fill("x".charCodeAt(0));
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          while (remaining > 0 && (controller.desiredSize ?? 0) > 0) {
            remaining -= 1;
            controller.enqueue(chunk);
          }
          if (remaining <= 0) {
            controller.close();
          } else {
            upstreamBackpressured = true;
          }
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });
  const upstreamUrl = `http://127.0.0.1:${upstream.port}`;
  resources.push({ close: async () => { upstream.stop(true); } });
  const disconnectController = new AbortController();
  const proxy = await startProxy(upstreamUrl, {
    maxBufferedBytes: 4 * 1024,
    clientDisconnectSignal: disconnectController.signal,
  });

  const proxyUrl = new URL(proxy.endpoint);
  const socket = createConnection({
    host: proxyUrl.hostname,
    port: Number(proxyUrl.port),
  });
  socket.once("error", () => undefined);
  socket.write("GET /stream HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
  await new Promise<void>((resolve) => {
    socket.once("data", () => {
      socket.pause();
      resolve();
    });
  });
  await waitFor(() => upstreamBackpressured, 2_000,
    `upstream backpressure (active=${activeUpstreamRequests})`);
  expect(upstreamBackpressured).toBe(true);
  expect(activeUpstreamRequests).toBe(1);
  socket.resume();
  await new Promise<void>((resolve) => {
    socket.once("end", resolve);
    setTimeout(resolve, 250);
  });
  disconnectController.abort();
  socket.destroy();
  await waitFor(() => proxy.activeRequests() === 0,
    2_000,
    `slow consumer proxy cleanup (active=${activeUpstreamRequests}, proxyActive=${proxy.activeRequests()})`);
  expect(proxy.activeRequests()).toBe(0);
});

test("HTML rewriting is bounded and injects bootstrap without retaining a response", async () => {
  const upstream = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
    });
    response.end("<html><body><script type=\"module\">boot()</script></body></html>");
  });
  const upstreamUrl = await listen(upstream);
  resources.push({ close: () => closeServer(upstream) });
  const proxy = await startProxy(upstreamUrl, { maxHtmlBytes: 128 });

  const response = await fetch(`${proxy.endpoint}/`);
  const body = await response.text();
  expect(response.status).toBe(200);
  expect(body).toContain("/__butler_tunnel_bootstrap.js");
  expect(proxy.activeRequests()).toBe(0);
});

test("oversized HTML is rejected before the rewrite buffer grows unbounded", async () => {
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("x".repeat(256));
  });
  const upstreamUrl = await listen(upstream);
  resources.push({ close: () => closeServer(upstream) });
  const proxy = await startProxy(upstreamUrl, { maxHtmlBytes: 32 });

  const response = await fetch(`${proxy.endpoint}/large.html`);
  expect(response.status).toBe(502);
  expect(await response.text()).toBe("Tunnel upstream unavailable.\n");
  expect(proxy.activeRequests()).toBe(0);
});

test("environment configuration injects secrets without reading private files", () => {
  const config = tunnelProxyConfigFromEnv({
    BUTLER_TUNNEL_PROXY_UPSTREAM: "http://127.0.0.1:18765",
    BUTLER_TUNNEL_PROXY_HOST: "127.0.0.1",
    BUTLER_TUNNEL_PROXY_PORT: "19000",
    BUTLER_TUNNEL_PROXY_USERNAME: "operator",
    BUTLER_TUNNEL_PROXY_PASSWORD: "secret",
    BUTLER_TUNNEL_PROXY_SESSION_SECRET: "session",
    BUTLER_TUNNEL_PROXY_LOGIN_TOKEN: "login",
    BUTLER_TUNNEL_PROXY_UPSTREAM_BEARER_TOKEN: "bearer",
  });
  expect(config.listenPort).toBe(19_000);
  expect(config.upstream.toString()).toBe("http://127.0.0.1:18765/");
  expect(config.auth).toEqual({
    basicUsername: "operator",
    basicPassword: "secret",
    sessionSecret: "session",
    loginToken: "login",
    upstreamBearerToken: "bearer",
  });
});

test("typed service config persists bounded env contract with private file mode", () => {
  const butlerData = join(tmpdir(), `butler-tunnel-config-${Date.now()}-${Math.random()}`);
  try {
    const config = writeTunnelProxyServiceConfigFromEnv({
      butlerData,
      env: {
        BUTLER_TUNNEL_PROXY_UPSTREAM: "http://127.0.0.1:18765",
        BUTLER_TUNNEL_PROXY_HOST: "127.0.0.1",
        BUTLER_TUNNEL_PROXY_PORT: "19000",
        BUTLER_TUNNEL_PROXY_USERNAME: "operator",
        BUTLER_TUNNEL_PROXY_PASSWORD: "secret",
        BUTLER_TUNNEL_PROXY_SESSION_SECRET: "session",
        BUTLER_TUNNEL_PROXY_MAX_HTML_BYTES: "2048",
        BUTLER_TUNNEL_PROXY_MAX_BUFFERED_BYTES: "4096",
      },
    });
    const path = tunnelProxyServiceConfigPath(butlerData);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readTunnelProxyServiceConfig(butlerData)).toEqual(config);
    expect(tunnelProxyEnvironmentFromServiceConfig(config)).toMatchObject({
      BUTLER_TUNNEL_PROXY_HOST: "127.0.0.1",
      BUTLER_TUNNEL_PROXY_PORT: "19000",
      BUTLER_TUNNEL_PROXY_UPSTREAM: "http://127.0.0.1:18765/",
      BUTLER_TUNNEL_PROXY_MAX_HTML_BYTES: "2048",
      BUTLER_TUNNEL_PROXY_MAX_BUFFERED_BYTES: "4096",
    });
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("inbound Basic auth gates the tunnel while injecting only configured upstream auth", async () => {
  let upstreamAuthorization: string | undefined;
  const upstream = createServer((request, response) => {
    upstreamAuthorization = request.headers.authorization;
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
  });
  const upstreamUrl = await listen(upstream);
  resources.push({ close: () => closeServer(upstream) });
  const proxy = await startProxy(upstreamUrl, {
    auth: {
      basicUsername: "operator",
      basicPassword: "secret",
      upstreamBearerToken: "upstream-secret",
    },
  });

  expect((await fetch(`${proxy.endpoint}/`)).status).toBe(401);
  const response = await fetch(`${proxy.endpoint}/`, {
    headers: {
      authorization: `Basic ${Buffer.from("operator:secret").toString("base64")}`,
    },
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("ok");
  expect(upstreamAuthorization).toBe("Bearer upstream-secret");
});
