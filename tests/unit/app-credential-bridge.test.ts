import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { api, apiErrorCode } from "../../packages/butler-app/client/ui/src/app/api.ts";

// #217 saved-key routes: GET /credentials, PATCH and DELETE /credentials/{name}.

function withBridge<T>(bridge: Record<string, unknown>, run: () => Promise<T>): Promise<T> {
  const previous = globalThis.window;
  Object.assign(globalThis, { window: { location: { origin: "http://localhost" }, butlerApp: bridge } });
  return run().finally(() => Object.assign(globalThis, { window: previous }));
}

test("renderer bridge maps the saved-key list, replace and delete routes", async () => {
  const calls: Array<{ method: string; input: unknown }> = [];
  const capture = (method: string, data: unknown) => async (input?: unknown) => {
    calls.push({ method, input });
    return { ok: true, data };
  };
  await withBridge({
    listCredentials: capture("listCredentials", { credentials: [], store: { backend: "fallback_file" } }),
    replaceCredential: capture("replaceCredential", { credential: { id: "openai" } }),
    deleteCredential: capture("deleteCredential", { removed_model_refs: [] }),
  }, async () => {
    const list = await api<{ credentials: unknown[] }>("/credentials");
    expect(list.credentials).toEqual([]);
    await api("/credentials/openai%202", { method: "PATCH", body: JSON.stringify({ api_key: "sk-new-key", verify: true }) });
    await api("/credentials/openai", { method: "DELETE" });
    await api("/credentials/openai?force=true", { method: "DELETE" });
  });
  expect(calls).toEqual([
    { method: "listCredentials", input: undefined },
    { method: "replaceCredential", input: { name: "openai 2", request: { api_key: "sk-new-key", verify: true } } },
    { method: "deleteCredential", input: { name: "openai", force: false } },
    { method: "deleteCredential", input: { name: "openai", force: true } },
  ]);
});

test("renderer bridge keeps the code of a refused replace or delete", async () => {
  const refused = (code: string, status: number) => async () =>
    ({ ok: false, error: { schema: "butler.app.bridge-error.v1", code, status } });
  const caught = (run: Promise<unknown>) => run.then(() => null, (error: unknown) => error);
  await withBridge({
    replaceCredential: refused("invalid_key", 400),
    deleteCredential: refused("credential_in_use_by_default", 409),
  }, async () => {
    const replace = await caught(api("/credentials/openai", { method: "PATCH", body: JSON.stringify({ api_key: "x", verify: true }) }));
    expect(apiErrorCode(replace)).toBe("invalid_key");
    const remove = await caught(api("/credentials/openai?force=true", { method: "DELETE" }));
    expect(apiErrorCode(remove)).toBe("credential_in_use_by_default");
    expect((remove as { status?: number }).status).toBe(409);
  });
});

test("actual Electron preload sends the saved-key routes and returns bounded envelopes", () => {
  const preloadPath = resolve(import.meta.dir, "../../packages/butler-app/client/electron/preload.cjs");
  const result = spawnSync("node", ["-e", `
    const Module = require("node:module"); const load = Module._load;
    let bridge; const calls = [];
    Module._load = (request, parent, main) => request === "electron" ? {
      contextBridge: { exposeInMainWorld(name, value) { if (name === "butlerApp") bridge = value; } },
      ipcRenderer: { invoke: async channel => channel === "butler:get-local-auth-headers" ? {} : null, on() {}, removeListener() {} }
    } : load(request, parent, main);
    global.fetch = async (url, options) => {
      const parsed = new URL(url);
      calls.push({ method: options.method ?? "GET", path: parsed.pathname + parsed.search, body: options.body ? JSON.parse(options.body) : null });
      if (options.method === "DELETE" && parsed.search === "") {
        return { ok: false, status: 409, json: async () => ({ error: { code: "credential_in_use", message: "2 registered model(s) use this API key." } }) };
      }
      return { ok: true, json: async () => ({ protocol_version: "butler.app.v1", data: { ok: true } }) };
    };
    require(${JSON.stringify(preloadPath)});
    (async () => {
      const results = [
        await bridge.listCredentials(),
        await bridge.replaceCredential({ name: "openai/2", request: { api_key: "sk-new", verify: true } }),
        await bridge.deleteCredential({ name: "openai", force: true }),
        await bridge.deleteCredential({ name: "openai" }),
      ];
      process.stdout.write(JSON.stringify({ calls, results }));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  const { calls, results } = JSON.parse(result.stdout);
  expect(calls.map((call: { method: string; path: string }) => `${call.method} ${call.path}`)).toEqual([
    "GET /credentials",
    "PATCH /credentials/openai%2F2",
    "DELETE /credentials/openai?force=true",
    "DELETE /credentials/openai",
  ]);
  expect(calls[1].body).toEqual({ api_key: "sk-new", verify: true });
  expect(results[0]).toEqual({ ok: true, data: { ok: true } });
  expect(results[3]).toEqual({ ok: false, error: { schema: "butler.app.bridge-error.v1", code: "credential_in_use", status: 409 } });
});
