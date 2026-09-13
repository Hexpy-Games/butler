import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { api } from "../../packages/butler-app/client/ui/src/app/api.ts";

test("workspace selection crosses renderer and actual Electron preload", async () => {
  const previous = globalThis.window;
  const requests: unknown[] = [];
  Object.assign(globalThis, { window: { location: { origin: "file://" }, butlerApp: {
    createSession: async (input: unknown) => { requests.push(input); return {}; },
  } } });
  try {
    for (const mode of ["local", "worktree"]) {
      await api("/sessions", { method: "POST", body: JSON.stringify({
        kind: "project", project_id: "project-one", workspace_mode: mode,
      }) });
      expect(requests.at(-1)).toMatchObject({ kind: "project", projectId: "project-one", workspaceMode: mode });
    }
  } finally { Object.assign(globalThis, { window: previous }); }
  const preload = resolve(import.meta.dir, "../../packages/butler-app/client/electron/preload.cjs");
  const result = spawnSync("node", ["-e", `
    const Module = require("node:module"); const load = Module._load; let bridge; const calls = [];
    Module._load = (request, parent, main) => request === "electron" ? {
      contextBridge: { exposeInMainWorld(name, value) { if (name === "butlerApp") bridge = value; } },
      ipcRenderer: { invoke: async channel => channel === "butler:get-local-auth-headers" ? {} : null, on() {}, removeListener() {} }
    } : load(request, parent, main);
    global.fetch = async (url, options) => {
      calls.push({ path: new URL(url).pathname, method: options.method, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ protocol_version: "butler.app.v1", data: {} }) };
    };
    require(${JSON.stringify(preload)});
    (async () => {
      for (const input of ${JSON.stringify(requests)}) await bridge.createSession(input);
      process.stdout.write(JSON.stringify(calls));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], { encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(["local", "worktree"].map(mode => ({
    path: "/sessions", method: "POST",
    body: { kind: "project", project_id: "project-one", workspace_mode: mode },
  })));
});
