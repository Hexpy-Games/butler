// test-category: security
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { api } from "../../packages/butler-app/client/ui/src/app/api.ts";

test("pending ask routes preserve session and ask identities through the renderer bridge", async () => {
  const previous = globalThis.window;
  const calls: unknown[] = [];
  const capture = (method: string) => async (input: unknown) => { calls.push({ method, input }); return {}; };
  Object.assign(globalThis, { window: { location: { origin: "http://localhost" }, butlerApp: {
    getSessionPendingAsks: capture("session"), getPendingAsks: capture("global"), dismissPendingAsk: capture("dismiss"),
  } } });
  try {
    await api("/sessions/chat%20a/pending-asks");
    await api("/pending-asks?limit=7&before=now%7Cquestion%3Aref");
    await api("/sessions/chat%20a/pending-asks/question%3Aref/dismiss", { method: "POST" });
    expect(calls).toEqual([
      { method: "session", input: { sessionId: "chat a" } },
      { method: "global", input: { limit: 7, before: "now|question:ref" } },
      { method: "dismiss", input: { sessionId: "chat a", askId: "question:ref" } },
    ]);
  } finally { Object.assign(globalThis, { window: previous }); }
});

test("actual pending ask preload uses authenticated JSON routes and encodes each path component", () => {
  const preload = resolve(import.meta.dir, "../../packages/butler-app/client/electron/preload.cjs");
  const result = spawnSync("node", ["-e", `
    const Module = require("node:module"), original = Module._load;
    let bridge; const calls = [];
    Module._load = (request, parent, main) => request === "electron" ? {
      contextBridge: { exposeInMainWorld(name, value) { if (name === "butlerApp") bridge = value; } },
      ipcRenderer: { invoke: async channel => channel === "butler:get-local-auth-headers" ? { authorization: "Bearer fixture" } : null, on() {}, send() {}, removeListener() {} }
    } : original(request, parent, main);
    global.fetch = async (url, options) => {
      calls.push({ path: new URL(url).pathname, query: new URL(url).search, method: options.method ?? "GET", client: options.headers.authorization });
      return { ok: true, json: async () => ({ protocol_version: "butler.app.v1", data: {} }) };
    };
    require(${JSON.stringify(preload)});
    (async () => {
      await bridge.getSessionPendingAsks({ sessionId: "chat/a" });
      await bridge.getPendingAsks({ limit: 7, before: "now|question:ref" });
      await bridge.dismissPendingAsk({ sessionId: "chat/a", askId: "question:ref/a" });
      process.stdout.write(JSON.stringify(calls));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], { encoding: "utf8" });
  expect(result.status).toBe(0);
  const calls = JSON.parse(result.stdout);
  expect(calls.map((call: { path: string }) => call.path)).toEqual([
    "/sessions/chat%2Fa/pending-asks", "/pending-asks", "/sessions/chat%2Fa/pending-asks/question%3Aref%2Fa/dismiss",
  ]);
  expect(new URLSearchParams(calls[1].query).get("before")).toBe("now|question:ref");
  expect(calls[2].method).toBe("POST");
  for (const call of calls) expect(call.client).toBe("Bearer fixture");
});
