import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { api } from "../../packages/butler-app/client/ui/src/app/api.ts";

const reads = ["records", "materials", "source", "history", "artifacts", "statistics"];
test("every dashboard renderer resource crosses the Electron bridge without losing cursor or source identity", async () => {
  const previous = globalThis.window;
  const inputs: any[] = [];
  const capture = async (input: unknown) => { inputs.push(input); return {}; };
  Object.assign(globalThis, { window: { location: { origin: "file://" }, butlerApp: {
    getProjectDashboardResource: capture, updateProjectDashboardResource: capture,
  } } });
  try {
    for (const resource of reads) {
      await api(`/projects/project%20one/dashboard/${resource}?cursor=a%2Bb%3D&kind=reference&id=work%7Cresult&timezone=Asia%2FSeoul`);
      expect(inputs.at(-1)).toEqual({ projectId: "project one", resource,
        query: "cursor=a%2Bb%3D&kind=reference&id=work%7Cresult&timezone=Asia%2FSeoul" });
    }
    for (const [resource, method] of [["preferences", "PATCH"], ["briefing", "POST"], ["attachment", "POST"]]) {
      const body = { expectedRevision: 1, sourceRevision: "a".repeat(64) };
      await api(`/projects/project%20one/dashboard/${resource}`, { method, body: JSON.stringify(body) });
      expect(inputs.at(-1)).toEqual({ projectId: "project one", resource, body });
    }
  } finally { Object.assign(globalThis, { window: previous }); }
});

test("actual preload limits dashboard resources and preserves HTTP method, query and body", () => {
  const preload = resolve(import.meta.dir, "../../packages/butler-app/client/electron/preload.cjs");
  const result = spawnSync("node", ["-e", `
    const Module = require("node:module"); const load = Module._load; let bridge; const calls = [];
    Module._load = (request, parent, main) => request === "electron" ? {
      contextBridge: { exposeInMainWorld(name, value) { if (name === "butlerApp") bridge = value; } },
      ipcRenderer: { invoke: async channel => channel === "butler:get-local-auth-headers" ? {} : null, on() {}, removeListener() {} }
    } : load(request, parent, main);
    global.fetch = async (url, options) => {
      calls.push({ path: new URL(url).pathname, query: new URL(url).search, method: options?.method ?? "GET", body: options?.body });
      return { ok: true, json: async () => ({ protocol_version: "butler.app.v1", data: {} }) };
    };
    require(${JSON.stringify(preload)});
    (async () => {
      for (const resource of ${JSON.stringify(reads)}) await bridge.getProjectDashboardResource({ projectId: "project one", resource, query: "cursor=a%2Bb%3D&kind=reference" });
      for (const resource of ["preferences", "briefing", "attachment"]) await bridge.updateProjectDashboardResource({ projectId: "project one", resource, body: { expectedRevision: 1 } });
      let rejected = 0;
      for (const resource of ["../messages", "preferences", "source?evil"]) try { await bridge.getProjectDashboardResource({ projectId: "p", resource }); } catch { rejected++; }
      try { await bridge.updateProjectDashboardResource({ projectId: "p", resource: "source" }); } catch { rejected++; }
      process.stdout.write(JSON.stringify({ calls, rejected }));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], { encoding: "utf8" });
  expect(result.status).toBe(0);
  const { calls, rejected } = JSON.parse(result.stdout);
  expect(rejected).toBe(4);
  expect(calls).toHaveLength(9);
  for (let i = 0; i < reads.length; i++) expect(calls[i]).toEqual({
    path: `/projects/project%20one/dashboard/${reads[i]}`, query: "?cursor=a%2Bb%3D&kind=reference", method: "GET",
  });
  expect(calls[6].method).toBe("PATCH"); expect(calls[7].method).toBe("POST");
  expect(calls[8].method).toBe("POST");
  expect(JSON.parse(calls[6].body)).toEqual({ expectedRevision: 1 });
});
