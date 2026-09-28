import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { api, apiErrorCode } from "../../packages/butler-app/client/ui/src/app/api.ts";

function withBridge<T>(bridge: Record<string, unknown>, run: () => Promise<T>): Promise<T> {
  const previous = globalThis.window;
  Object.assign(globalThis, { window: { location: { origin: "http://localhost" }, butlerApp: bridge } });
  return run().finally(() => Object.assign(globalThis, { window: previous }));
}

test("renderer bridge forwards a schedule's access mode on create and update", async () => {
  const inputs: Array<{ method: string; input: Record<string, unknown> }> = [];
  const capture = (method: string) => async (input: Record<string, unknown>) => {
    inputs.push({ method, input });
    return { ok: true, data: { automation: { id: "automation-1", access_mode: input.accessMode } } };
  };
  await withBridge({ createAutomation: capture("createAutomation"), updateAutomation: capture("updateAutomation") }, async () => {
    const created = await api<{ automation: { access_mode: string } }>("/automations", {
      method: "POST",
      body: JSON.stringify({ title: "T", prompt_body: "P", target_session_id: "general", interval_seconds: 3600, access_mode: "read_only" }),
    });
    expect(created.automation.access_mode).toBe("read_only");
    await api("/automations/automation-1", { method: "PATCH", body: JSON.stringify({ access_mode: "ask_first" }) });
  });
  expect(inputs).toEqual([
    { method: "createAutomation", input: expect.objectContaining({ targetSessionId: "general", accessMode: "read_only" }) },
    { method: "updateAutomation", input: expect.objectContaining({ automationId: "automation-1", accessMode: "ask_first" }) },
  ]);
});

test("renderer bridge keeps the code and status of a refused schedule save", async () => {
  const refused = async () => ({ ok: false, error: { schema: "butler.app.bridge-error.v1", code: "invalid_json", status: 400 } });
  const error = await withBridge({ createAutomation: refused }, () =>
    api("/automations", { method: "POST", body: JSON.stringify({ access_mode: "sometimes" }) }).then(() => null, (caught: unknown) => caught));
  expect(apiErrorCode(error)).toBe("invalid_json");
  expect((error as { status?: number }).status).toBe(400);
});

test("actual Electron preload sends access_mode and returns a bounded envelope for a 400", () => {
  const preloadPath = resolve(import.meta.dir, "../../packages/butler-app/client/electron/preload.cjs");
  const result = spawnSync("node", ["-e", `
    const Module = require("node:module"); const load = Module._load;
    let bridge; const calls = [];
    Module._load = (request, parent, main) => request === "electron" ? {
      contextBridge: { exposeInMainWorld(name, value) { if (name === "butlerApp") bridge = value; } },
      ipcRenderer: { invoke: async channel => channel === "butler:get-local-auth-headers" ? {} : null, on() {}, removeListener() {} }
    } : load(request, parent, main);
    global.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ method: options.method, path: new URL(url).pathname, body });
      if (body.access_mode === "sometimes") {
        return { ok: false, status: 400, json: async () => ({ error: { code: "invalid_json", message: "Request body must be JSON." } }) };
      }
      return { ok: true, json: async () => ({ protocol_version: "butler.app.v1", data: { automation: { access_mode: body.access_mode } } }) };
    };
    require(${JSON.stringify(preloadPath)});
    (async () => {
      const base = { title: "T", promptBody: "P", targetSessionId: "general", intervalSeconds: 3600 };
      const results = [
        await bridge.createAutomation({ ...base, accessMode: "full_access" }),
        await bridge.createAutomation(base),
        await bridge.updateAutomation({ automationId: "automation-1", accessMode: "read_only" }),
        await bridge.createAutomation({ ...base, accessMode: "sometimes" }),
      ];
      process.stdout.write(JSON.stringify({ calls, results }));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  const { calls, results } = JSON.parse(result.stdout);
  expect(calls.map((call: { method: string; path: string }) => `${call.method} ${call.path}`)).toEqual([
    "POST /automations", "POST /automations", "PATCH /automations/automation-1", "POST /automations",
  ]);
  expect(calls[0].body.access_mode).toBe("full_access");
  expect("access_mode" in calls[1].body).toBe(false);
  expect(calls[2].body.access_mode).toBe("read_only");
  expect(results[0]).toEqual({ ok: true, data: { automation: { access_mode: "full_access" } } });
  expect(results[3]).toEqual({ ok: false, error: { schema: "butler.app.bridge-error.v1", code: "invalid_json", status: 400 } });
});
