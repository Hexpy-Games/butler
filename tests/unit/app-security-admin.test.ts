import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "bun:test";
import {
  APP_ADMIN_HEADER,
  appLocalAdminPath,
  isSecuritySenderOrigin,
  readAppLocalAdmin,
  requestSecurityRoute,
} from "../../packages/butler-app/client/electron/app-security-admin.mjs";
import {
  appLocalAuthPath,
  createBundledAgentSupervisor,
  prepareAppLocalAuth,
} from "../../packages/butler-app/client/electron/app-agent-supervisor.mjs";

const ADMIN = "admin-credential-".padEnd(43, "x");
const ADMIN_FILE = { schema: "butler.app-local-admin.v1", purpose: "butler-local-admin", secret: ADMIN };
const envelope = (data: unknown) => ({ protocol_version: "butler.app.v1", data });

async function withData(run: (butlerData: string) => unknown): Promise<void> {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-security-admin-"));
  try {
    await run(join(tempDir, "data"));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function writeAdmin(butlerData: string, value: unknown) {
  const path = appLocalAdminPath(butlerData);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
}

type Sent = { url: string; method: string; headers: Record<string, string>; body: string | null };

/** Runs one bridge route against a fetch double that records what main sent. */
async function send(
  input: unknown,
  {
    adminCredential = ADMIN as string | null,
    response = { status: 200, body: envelope({}) as unknown },
    onRotated = () => undefined,
  } = {},
) {
  const sent: Sent[] = [];
  const result = await requestSecurityRoute(input, {
    ensureReady: async () => undefined,
    serverUrl: "http://127.0.0.1:18765/",
    authHeaders: () => ({ authorization: "Bearer token" }),
    adminCredential,
    onRotated,
    fetch: async (url: URL | string, init: RequestInit = {}) => {
      sent.push({
        url: String(url),
        method: init.method ?? "GET",
        headers: init.headers as Record<string, string>,
        body: (init.body as string | undefined) ?? null,
      });
      return new Response(JSON.stringify(response.body), { status: response.status });
    },
  });
  return { result, sent };
}

// test-category: security
test("the admin credential file is read from the data folder; a missing or invalid file means none", async () => {
  await withData((butlerData) => {
    expect(appLocalAdminPath(butlerData)).toBe(join(butlerData, "app", "runtime", "auth", "local-admin.json"));
    expect(readAppLocalAdmin({ butlerData })).toBeNull();
    writeAdmin(butlerData, "not json");
    expect(readAppLocalAdmin({ butlerData })).toBeNull();
    // Valid only with the exact schema and a secret of at least 32 characters.
    writeAdmin(butlerData, { ...ADMIN_FILE, schema: "butler.app-local-admin.v2" });
    expect(readAppLocalAdmin({ butlerData })).toBeNull();
    writeAdmin(butlerData, { secret: ADMIN });
    expect(readAppLocalAdmin({ butlerData })).toBeNull();
    writeAdmin(butlerData, { ...ADMIN_FILE, secret: "x".repeat(31) });
    expect(readAppLocalAdmin({ butlerData })).toBeNull();
    writeAdmin(butlerData, { ...ADMIN_FILE, secret: 42 });
    expect(readAppLocalAdmin({ butlerData })).toBeNull();
    writeAdmin(butlerData, ADMIN_FILE);
    expect(readAppLocalAdmin({ butlerData })).toBe(ADMIN);
  });
});

// test-category: security
test("the security routes carry the admin header next to the bearer token", async () => {
  const routes: Array<[unknown, string, string]> = [
    [{ route: "getSecurity" }, "GET", "/security"],
    [{ route: "issuePairingCode" }, "POST", "/security/pairing"],
    [{ route: "rotateConnectionCode" }, "POST", "/security/connection-code/rotate"],
    [{ route: "updateSecuritySettings", body: { security: { allowed_hosts: ["a.example"] } } }, "PATCH", "/settings"],
    [{ route: "getPairingStatus" }, "GET", "/security/pairing"],
    [{ route: "listPairedDevices" }, "GET", "/security/devices"],
    [{ route: "revokeAllPairedDevices" }, "DELETE", "/security/devices"],
    [{ route: "revokePairedDevice", body: { deviceId: "00000000-0000-0000-0000-000000000000" } }, "DELETE", "/security/devices/00000000-0000-0000-0000-000000000000"],
  ];
  for (const [input, method, path] of routes) {
    const { result, sent } = await send(input);
    expect(result).toEqual({ ok: true, data: {} });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method, url: `http://127.0.0.1:18765${path}` });
    expect(sent[0]?.headers[APP_ADMIN_HEADER]).toBe(ADMIN);
    expect(sent[0]?.headers.authorization).toBe("Bearer token");
  }
  const patch = await send(routes[3]![0]);
  expect(JSON.parse(patch.sent[0]!.body!)).toEqual({ security: { allowed_hosts: ["a.example"] } });
});

// test-category: security
test("anything else is refused before a request is sent", async () => {
  for (const input of [
    { route: "getSettings" },
    { route: "updateSecuritySettings", body: { language: "en" } },
    { route: "updateSecuritySettings" },
    null,
  ]) {
    const { result, sent } = await send(input);
    expect(sent).toHaveLength(0);
    expect(result).toEqual({ ok: false, error: { schema: "butler.app.bridge-error.v1", code: "invalid_request" } });
  }
});

// test-category: security
test("without an admin file (an older Agent) the header is left out and the call goes as before", async () => {
  const { result, sent } = await send({ route: "getSecurity" }, { adminCredential: null });
  expect(result.ok).toBe(true);
  expect(Object.keys(sent[0]!.headers).map((name) => name.toLowerCase())).not.toContain(APP_ADMIN_HEADER);
});

// test-category: security
test("the admin value never comes back to the renderer, even when the gateway echoes it", async () => {
  const echoed = { status: 403, body: { error: { code: "loopback_required", message: `bad ${ADMIN}` } } };
  const refused = await send({ route: "getSecurity" }, { response: echoed });
  expect(refused.result).toEqual({
    ok: false,
    error: { schema: "butler.app.bridge-error.v1", code: "loopback_required", status: 403 },
  });
  expect(JSON.stringify(refused.result)).not.toContain(ADMIN);

  const unreachable = await requestSecurityRoute({ route: "getSecurity" }, {
    ensureReady: async () => undefined,
    serverUrl: "http://127.0.0.1:18765/",
    authHeaders: () => ({}),
    adminCredential: ADMIN,
    fetch: async () => { throw new Error(`connect failed ${ADMIN}`); },
  });
  expect(JSON.stringify(unreachable)).not.toContain(ADMIN);
  expect(unreachable).toEqual({ ok: false, error: { schema: "butler.app.bridge-error.v1", code: "request_failed" } });
});

// test-category: security
test("rotation re-reads the token and keeps the admin credential", async () => {
  await withData(async (butlerData) => {
    prepareAppLocalAuth({ butlerData, generateToken: () => "a".repeat(43) });
    writeAdmin(butlerData, ADMIN_FILE);
    const adminBefore = readFileSync(appLocalAdminPath(butlerData), "utf8");
    const supervisor = createBundledAgentSupervisor({
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
    let rotations = 0;
    const rotated = await send({ route: "rotateConnectionCode" }, {
      adminCredential: readAppLocalAdmin({ butlerData }),
      response: { status: 200, body: envelope({ code: "b".repeat(43), created_at: null }) },
      onRotated: () => {
        rotations += 1;
        writeFileSync(appLocalAuthPath(butlerData), JSON.stringify({ token: "b".repeat(43) }));
        supervisor.reloadLocalAuth();
      },
    });
    expect(rotated.result.ok).toBe(true);
    expect(rotations).toBe(1);
    expect(supervisor.authHeaders()).toEqual({ authorization: `Bearer ${"b".repeat(43)}` });
    expect(readFileSync(appLocalAdminPath(butlerData), "utf8")).toBe(adminBefore);

    const next = await send({ route: "getSecurity" }, { adminCredential: readAppLocalAdmin({ butlerData }) });
    expect(next.sent[0]?.headers[APP_ADMIN_HEADER]).toBe(ADMIN);

    // A refused rotation re-reads nothing.
    await send({ route: "rotateConnectionCode" }, {
      response: { status: 403, body: { error: { code: "loopback_required" } } },
      onRotated: () => { rotations += 1; },
    });
    expect(rotations).toBe(1);
  });
});

// test-category: race
test("a request right after a reissue elsewhere reads the token after ensureReady", async () => {
  let token = "old";
  const sent: string[] = [];
  await requestSecurityRoute({ route: "getSecurity" }, {
    // ensureReady re-reads a token rotated elsewhere (supervisor health probe).
    ensureReady: async () => { token = "new"; },
    serverUrl: "http://127.0.0.1:18765/",
    authHeaders: () => ({ authorization: `Bearer ${token}` }),
    adminCredential: ADMIN,
    fetch: async (_url: URL | string, init: RequestInit = {}) => {
      sent.push((init.headers as Record<string, string>).authorization);
      return new Response(JSON.stringify(envelope({})), { status: 200 });
    },
  });
  expect(sent).toEqual(["Bearer new"]);
});

// test-category: security
test("only the app's own renderer may ask main for a security call", () => {
  const app = { appOrigin: "app://butler" };
  expect(isSecuritySenderOrigin("app://butler", app)).toBe(true);
  expect(isSecuritySenderOrigin("http://127.0.0.1:5173", app)).toBe(false);
  expect(isSecuritySenderOrigin("http://127.0.0.1:5173", { ...app, devOrigin: "http://127.0.0.1:5173" })).toBe(true);
  expect(isSecuritySenderOrigin("https://evil.example", { ...app, devOrigin: "http://127.0.0.1:5173" })).toBe(false);
  expect(isSecuritySenderOrigin(undefined, app)).toBe(false);
  expect(isSecuritySenderOrigin("null", app)).toBe(false);
});
