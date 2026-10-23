// test-category: security
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { api } from "../../packages/butler-app/client/ui/src/app/api.ts";

test("desktop renderer sends the JSON log routes through the logs bridge", async () => {
  const previous = globalThis.window;
  const inputs: unknown[] = [];
  Object.assign(globalThis, { window: { location: { origin: "http://localhost" }, butlerApp: {
    logs: async (input: unknown) => { inputs.push(input); return {}; },
  } } });
  try {
    await api("/logs?limit=50&source=all");
    await api("/logs/config", { method: "PUT", body: JSON.stringify({ level: "full", category_levels: {} }) });
    await api("/logs", { method: "DELETE" });
  } finally { Object.assign(globalThis, { window: previous }); }
  expect(inputs).toEqual([
    { path: "/logs?limit=50&source=all", method: "GET" },
    { path: "/logs/config", method: "PUT", body: { level: "full", category_levels: {} } },
    { path: "/logs", method: "DELETE" },
  ]);
});

test("actual preload allows only the log JSON routes and streams live records", () => {
  const preloadPath = resolve(import.meta.dir, "../../packages/butler-app/client/electron/preload.cjs");
  const result = spawnSync("node", ["-e", `
    const Module = require("node:module"); const load = Module._load;
    let bridge; const calls = [];
    Module._load = (request, parent, main) => request === "electron" ? {
      contextBridge: { exposeInMainWorld(name, value) { if (name === "butlerApp") bridge = value; } },
      ipcRenderer: { invoke: async () => null, on() {}, send() {}, removeListener() {} }
    } : load(request, parent, main);
    global.fetch = async (url, options = {}) => {
      const path = new URL(url).pathname;
      calls.push({ path, method: options.method ?? "GET", body: options.body ?? null });
      if (path === "/logs/live") {
        const bytes = new TextEncoder().encode('event: log\\ndata: {"msg":"live row"}\\n\\nevent: lagged\\ndata: 3\\n\\n');
        let sent = false;
        return { ok: true, body: { getReader: () => ({
          read: async () => sent ? new Promise(() => {}) : (sent = true, { done: false, value: bytes }),
        }) } };
      }
      return { ok: true, json: async () => ({ protocol_version: "butler.app.v1", data: {} }) };
    };
    require(${JSON.stringify(preloadPath)});
    (async () => {
      await bridge.logs({ path: "/logs/config", method: "PUT", body: { level: "minimal", category_levels: {} } });
      let refused = false;
      try { bridge.logs({ path: "/settings", method: "PATCH", body: {} }); } catch { refused = true; }
      const records = [];
      const close = bridge.subscribeLogs({ onRecord: (record) => records.push(record), onError: () => records.push("error") });
      await new Promise((done) => setTimeout(done, 50));
      close();
      process.stdout.write(JSON.stringify({ calls, refused, records }));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], { encoding: "utf8" });
  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.refused).toBe(true);
  expect(output.calls[0]).toEqual({ path: "/logs/config", method: "PUT", body: JSON.stringify({ level: "minimal", category_levels: {} }) });
  expect(output.calls.map((call: { path: string }) => call.path)).toEqual(["/logs/config", "/logs/live"]);
  expect(output.records).toEqual([{ msg: "live row" }]);
});
