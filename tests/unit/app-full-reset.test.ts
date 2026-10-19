// test-category: security
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  FULL_RESET_CONFIRMATION,
  FULL_RESET_PENDING_FILE,
  relaunchAfterFullReset,
  requestFullReset,
} from "../../packages/butler-app/client/electron/app-full-reset.mjs";
import { DATA_GENERATION_FILE, reconcileAppDataGeneration } from "../../packages/butler-app/client/electron/app-data-generation.mjs";
import { appLocalAuthPath, fullResetPending, prepareAppLocalAuth } from "../../packages/butler-app/client/electron/app-agent-supervisor.mjs";

const envelope = (data: unknown) => ({ protocol_version: "butler.app.v1", data });

function fakeFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: unknown }> = [];
  const fetch = async (url: URL, init: RequestInit) => {
    calls.push({ url: url.pathname, method: String(init.method), headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined });
    const next = responses.shift()!;
    return new Response(JSON.stringify(next.body), { status: next.status });
  };
  return { fetch, calls };
}

const options = (fetch: (url: URL, init: RequestInit) => Promise<Response>) => ({
  ensureReady: async () => undefined, fetch, serverUrl: "http://127.0.0.1:1/",
  authHeaders: async () => ({ authorization: "Bearer t" }), adminCredential: "a".repeat(40),
});

test("a reset takes a fresh nonce, then posts the fixed token with the admin credential", async () => {
  const { fetch, calls } = fakeFetch([
    { status: 200, body: envelope({ nonce: "n1", expires_at: "2026-10-18T00:02:00Z" }) },
    { status: 202, body: envelope({ operation_id: "op-1", restart: "app" }) },
  ]);
  expect(await requestFullReset({ operationId: "op-1" }, options(fetch))).toEqual({ ok: true });
  expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(["GET /data/reset", "POST /data/reset"]);
  expect(calls[1]!.body).toEqual({ operation_id: "op-1", nonce: "n1", confirmation: FULL_RESET_CONFIRMATION });
  for (const call of calls) expect(call.headers["x-butler-admin"]).toBe("a".repeat(40));
});

test("a refused reset answers only a bounded code and never posts without a nonce", async () => {
  const refused = fakeFetch([{ status: 403, body: { error: { code: "admin_credential_required", message: "no" } } }]);
  expect(await requestFullReset({ operationId: "op-1" }, options(refused.fetch))).toMatchObject({ ok: false, error: { code: "admin_credential_required", status: 403 } });
  expect(refused.calls).toHaveLength(1);
  const busy = fakeFetch([
    { status: 200, body: envelope({ nonce: "n1" }) },
    { status: 409, body: { error: { code: "full_reset_in_progress", message: "busy" } } },
  ]);
  expect(await requestFullReset({ operationId: "op-1" }, options(busy.fetch))).toMatchObject({ ok: false, error: { code: "full_reset_in_progress", status: 409 } });
  const invalid = fakeFetch([]);
  expect(await requestFullReset({ operationId: "bad id/" }, options(invalid.fetch))).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  expect(invalid.calls).toHaveLength(0);
});

test("the relaunch quiesces the renderer and stops the Agent before clearing App data", async () => {
  const userData = mkdtempSync(join(tmpdir(), "butler-full-reset-"));
  try {
    for (const name of ["browser", "browser-downloads"]) mkdirSync(join(userData, name));
    for (const name of ["butler-native-settings.json", "renderer-storage-origin-migration.json"]) writeFileSync(join(userData, name), "{}");
    const steps: string[] = [];
    await relaunchAfterFullReset({
      userDataPath: userData, previousGeneration: "g1",
      quiesceRenderer: async () => { steps.push("quiesce"); },
      stopAgent: async () => { steps.push("stop"); throw new Error("foreground_shutdown_failed"); },
      clearSessions: async () => { steps.push(`clear:${existsSync(join(userData, "browser"))}`); },
      relaunch: () => { steps.push("relaunch"); },
    });
    expect(steps).toEqual(["quiesce", "stop", "clear:true", "relaunch"]);
    expect(["browser", "browser-downloads", "butler-native-settings.json"].some((name) => existsSync(join(userData, name)))).toBe(false);
    expect(existsSync(join(userData, "renderer-storage-origin-migration.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(userData, FULL_RESET_PENDING_FILE), "utf8")).previous_data_generation).toBe("g1");
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
});

test("a changed data generation clears renderer storage; an unchanged one after a reset reports failure", async () => {
  const userData = mkdtempSync(join(tmpdir(), "butler-data-generation-"));
  try {
    let clears = 0;
    const run = (generation: string | null) => reconcileAppDataGeneration({
      userDataPath: userData, readGeneration: async () => generation, clearRendererStorage: async () => { clears += 1; },
    });
    expect(await run(null)).toEqual({ outcome: "unknown", resetFailed: false });
    expect(await run("g1")).toEqual({ outcome: "recorded", resetFailed: false });
    expect(await run("g1")).toEqual({ outcome: "same", resetFailed: false });
    expect(clears).toBe(0);
    writeFileSync(join(userData, FULL_RESET_PENDING_FILE), JSON.stringify({ previous_data_generation: "g1" }));
    expect(await run("g1")).toEqual({ outcome: "same", resetFailed: true });
    expect(existsSync(join(userData, FULL_RESET_PENDING_FILE))).toBe(false);
    writeFileSync(join(userData, FULL_RESET_PENDING_FILE), JSON.stringify({ previous_data_generation: "g1" }));
    expect(await run("g2")).toEqual({ outcome: "cleared", resetFailed: false });
    expect(clears).toBe(1);
    expect(JSON.parse(readFileSync(join(userData, DATA_GENERATION_FILE), "utf8")).data_generation).toBe("g2");
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
});

test("no token file is created in a data folder with a pending reset", () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-reset-auth-"));
  try {
    mkdirSync(join(butlerData, "state"));
    writeFileSync(join(butlerData, "state", "full-reset.json"), "{}");
    expect(fullResetPending({ butlerData })).toBe(true);
    expect(prepareAppLocalAuth({ butlerData, generateToken: () => "g".repeat(43) })).toEqual({
      filePath: appLocalAuthPath(butlerData), created: false, token: null,
    });
    expect(existsSync(appLocalAuthPath(butlerData))).toBe(false);
    rmSync(join(butlerData, "state", "full-reset.json"));
    expect(prepareAppLocalAuth({ butlerData, generateToken: () => "g".repeat(43) }).created).toBe(true);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});
