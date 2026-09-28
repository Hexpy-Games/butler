import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, test } from "bun:test";
import {
  appLocalAuthPath,
  createBundledAgentSupervisor,
  prepareAppLocalAuth,
} from "../../packages/butler-app/client/electron/app-agent-supervisor.mjs";

const electronDir = resolve(import.meta.dir, "../../packages/butler-app/client/electron");
const preloadPath = join(electronDir, "preload.cjs");

function supervisorFor(butlerData: string) {
  return createBundledAgentSupervisor({
    butlerData,
    resolveGateway: () => ({ command: "/bin/false", args: [], env: {} }),
    spawnProcess: () => { throw new Error("not spawned in this test"); },
    healthCheck: () => false,
    isPortAvailable: () => true,
    findAvailablePort: (port) => port,
    updatePort: () => undefined,
    getPort: () => 18765,
    getServerUrl: () => "http://127.0.0.1:18765/",
    getRendererOrigin: () => "app://butler",
  });
}

function writeRotatedToken(butlerData: string, token: string) {
  const path = appLocalAuthPath(butlerData);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ schema: "butler.app-local-agent-auth.v1", token }), { mode: 0o600 });
}

test("main re-reads the rotated connection code from the data-folder token file", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-security-auth-"));
  try {
    const butlerData = join(tempDir, "data");
    prepareAppLocalAuth({ butlerData, generateToken: () => "a".repeat(43) });
    const supervisor = supervisorFor(butlerData);
    expect(supervisor.authHeaders()).toEqual({ authorization: `Bearer ${"a".repeat(43)}` });

    writeRotatedToken(butlerData, "b".repeat(43));
    expect(supervisor.authHeaders().authorization).toBe(`Bearer ${"a".repeat(43)}`);
    expect(supervisor.reloadLocalAuth()).toBe(true);
    expect(supervisor.authHeaders()).toEqual({ authorization: `Bearer ${"b".repeat(43)}` });
    expect(supervisor.reloadLocalAuth()).toBe(false);

    // A missing or unreadable file keeps the last good token.
    writeFileSync(appLocalAuthPath(butlerData), "not json");
    expect(supervisor.reloadLocalAuth()).toBe(false);
    expect(supervisor.authHeaders().authorization).toBe(`Bearer ${"b".repeat(43)}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a health probe refused after a rotation re-reads the token file instead of failing startup", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-security-probe-"));
  try {
    const butlerData = join(tempDir, "data");
    prepareAppLocalAuth({ butlerData, generateToken: () => "a".repeat(43) });
    // The gateway accepts only its current code, as after a CLI rotation.
    let gatewayToken = "a".repeat(43);
    const probed: string[] = [];
    const supervisor = createBundledAgentSupervisor({
      butlerData,
      explicitServerUrl: "http://127.0.0.1:18765/",
      resolveGateway: () => ({ command: "/bin/false", args: [], env: {} }),
      spawnProcess: () => { throw new Error("not spawned in this test"); },
      healthCheck: (localAuth) => {
        probed.push(localAuth?.token?.[0] ?? "");
        return localAuth?.token === gatewayToken;
      },
      isPortAvailable: () => true,
      findAvailablePort: (port: number) => port,
      updatePort: () => undefined,
      getPort: () => 18765,
      getServerUrl: () => "http://127.0.0.1:18765/",
      getRendererOrigin: () => "app://butler",
      sleepMs: async () => undefined,
      startupAttempts: 2,
    });
    await supervisor.ensureReady();

    gatewayToken = "b".repeat(43);
    writeRotatedToken(butlerData, gatewayToken);
    await supervisor.ensureReady();
    expect(supervisor.authHeaders()).toEqual({ authorization: `Bearer ${"b".repeat(43)}` });
    expect(probed).toEqual(["a", "a", "b"]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("main exposes the token re-read to the preload", () => {
  const main = readFileSync(join(electronDir, "main.mjs"), "utf8");
  expect(main).toMatch(/ipcMain\.handle\("butler:reload-local-auth",[^;]*bundledAgentSupervisor\.reloadLocalAuth\(\)/su);
});

type PreloadRun = {
  invokes: string[];
  requests: Array<{ path: string; method: string; body: string | null }>;
  results: unknown[];
  events: unknown[];
};

/** Loads the real preload with Electron and fetch stubbed, then runs `script` against the bridge. */
function runPreload(responses: Record<string, { status: number; body: unknown }>, script: string): PreloadRun {
  const result = spawnSync("node", ["-e", `
    const Module = require("node:module"); const load = Module._load;
    let bridge; const invokes = []; const requests = []; const results = []; const events = [];
    Module._load = (request, parent, main) => request === "electron" ? {
      contextBridge: { exposeInMainWorld(name, value) { if (name === "butlerApp") bridge = value; } },
      ipcRenderer: {
        invoke: async (channel) => { invokes.push(channel); return channel === "butler:get-local-auth-headers" ? {} : null; },
        on() {}, removeListener() {},
      },
    } : load(request, parent, main);
    const responses = ${JSON.stringify(responses)};
    global.fetch = async (url, options = {}) => {
      const { pathname } = new URL(url);
      requests.push({ path: pathname, method: options.method ?? "GET", body: options.body ?? null });
      const response = responses[pathname] ?? { status: 404, body: {} };
      if (pathname === "/events/live") {
        const encoder = new TextEncoder();
        const chunks = [encoder.encode(response.body)];
        return { ok: response.status < 400, status: response.status, body: { getReader: () => ({
          read: async () => chunks.length ? { done: false, value: chunks.shift() } : { done: true },
          cancel: async () => undefined, releaseLock() {},
        }) } };
      }
      return { ok: response.status < 400, status: response.status, json: async () => response.body };
    };
    require(${JSON.stringify(preloadPath)});
    const wait = () => new Promise((resolve) => setTimeout(resolve, 20));
    (async () => {
      ${script}
      process.stdout.write(JSON.stringify({ invokes, requests, results, events }));
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `], { encoding: "utf8" });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as PreloadRun;
}

const envelope = (data: unknown) => ({ protocol_version: "butler.app.v1", data });
const forbidden = { status: 403, body: { error: { code: "loopback_required", message: "Security settings are only available on this computer." } } };

test("preload re-reads the token in main when the live stream reports a rotated code", () => {
  const run = runPreload({
    "/events/live": {
      status: 200,
      body: 'data: {"id":7,"type":"security.connection_code_rotated","payload":{}}\n\n',
    },
  }, `
    bridge.subscribeLiveEvents({ cursor: 0 }, { onEvent: (event) => events.push(event.type) });
    await wait();
  `);
  expect(run.events).toEqual(["security.connection_code_rotated"]);
  expect(run.invokes).toContain("butler:reload-local-auth");
});

test("preload re-reads the token when the live stream is rejected with 401", () => {
  const run = runPreload({ "/events/live": { status: 401, body: "" } }, `
    bridge.subscribeLiveEvents({ cursor: 0 }, { onError: () => events.push("error") });
    await wait();
  `);
  expect(run.events).toEqual(["error"]);
  expect(run.invokes).toContain("butler:reload-local-auth");
});

test("preload security routes return envelopes and rotation re-reads the token", () => {
  const view = { remote_access_enabled: false, bind_addresses: ["127.0.0.1:18765"], lan_urls: [],
    allowed_hosts: ["butler.example.com"], connection_code: { masked: "abcd…wxyz", created_at: "2026-09-28T00:00:00Z" } };
  const run = runPreload({
    "/security": { status: 200, body: envelope(view) },
    "/security/connection-code/reveal": { status: 200, body: envelope({ code: "c".repeat(43) }) },
    "/security/connection-code/rotate": { status: 200, body: envelope({ code: "d".repeat(43), created_at: "2026-09-29T00:00:00Z" }) },
  }, `
    results.push(await bridge.getSecurity());
    results.push(await bridge.revealConnectionCode());
    const before = invokes.filter((channel) => channel === "butler:reload-local-auth").length;
    results.push(await bridge.rotateConnectionCode());
    results.push(invokes.filter((channel) => channel === "butler:reload-local-auth").length - before);
  `);
  expect(run.requests.map(({ path, method }) => `${method} ${path}`)).toEqual([
    "GET /security",
    "POST /security/connection-code/reveal",
    "POST /security/connection-code/rotate",
  ]);
  expect(run.results).toEqual([
    { ok: true, data: view },
    { ok: true, data: { code: "c".repeat(43) } },
    { ok: true, data: { code: "d".repeat(43), created_at: "2026-09-29T00:00:00Z" } },
    1,
  ]);
});

test("preload keeps the 403 status of the loopback-only rule and skips the re-read", () => {
  const run = runPreload({
    "/security": forbidden,
    "/security/connection-code/rotate": forbidden,
  }, `
    results.push(await bridge.getSecurity());
    results.push(await bridge.rotateConnectionCode());
  `);
  const failure = { ok: false, error: { schema: "butler.app.bridge-error.v1", code: "loopback_required", status: 403 } };
  expect(run.results).toEqual([failure, failure]);
  expect(run.invokes).not.toContain("butler:reload-local-auth");
});
