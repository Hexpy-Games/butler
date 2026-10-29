// test-category: pure-logic
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { api } from "../../packages/butler-app/client/ui/src/app/api";

test("image usage and selection reads cross the renderer bridge with their range", async () => {
  const previous = globalThis.window;
  const reads: unknown[] = [];
  Object.assign(globalThis, { window: { location: { origin: "http://localhost" }, butlerApp: {
    imageModelSettings: async (input: unknown) => { reads.push(input); return { ok: true, data: { selected: null } }; },
    getImageUsage: async (input: unknown) => { reads.push(input); return { models: [] }; },
  } } });
  try {
    expect(await api<{ selected: null }>("/settings/image-model")).toEqual({ selected: null });
    for (const days of [7, 30]) expect(await api<{ models: unknown[] }>(`/usage/images?days=${days}`)).toEqual({ models: [] });
    expect(reads).toEqual([{ method: "GET", body: undefined }, { days: 7 }, { days: 30 }]);
  } finally { Object.assign(globalThis, { window: previous }); }
});

test("the actual preload forwards image reads to the authenticated native gateway", () => {
  const preload = resolve("packages/butler-app/client/electron/preload.cjs");
  const result = spawnSync("node", ["-e", `
    const Module = require("node:module"); const load = Module._load;
    let bridge; const reads = [];
    Module._load = (request, parent, main) => request === "electron" ? {
      contextBridge: { exposeInMainWorld(name, value) { if (name === "butlerApp") bridge = value; } },
      ipcRenderer: { invoke: async channel => channel === "butler:get-local-auth-headers" ? {} : null, on() {}, send() {}, removeListener() {} }
    } : load(request, parent, main);
    global.fetch = async url => {
      const parsed = new URL(url); reads.push(parsed.pathname + parsed.search);
      return { ok: true, json: async () => ({ protocol_version: "butler.app.v1", data: {} }) };
    };
    require(${JSON.stringify(preload)});
    (async () => {
      await bridge.imageModelSettings();
      await bridge.getImageUsage();
      await bridge.getImageUsage({ days: 30 });
      process.stdout.write(JSON.stringify(reads));
    })().catch(() => { process.exitCode = 1; });
  `], { encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(["/settings/image-model", "/usage/images?days=7", "/usage/images?days=30"]);
});
