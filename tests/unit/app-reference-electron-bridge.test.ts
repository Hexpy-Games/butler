import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { api } from "../../packages/butler-app/client/ui/src/app/api.ts";

const content = { version: 1, parts: [{ type: "text", text: "비교 " },
  { type: "session_ref", sessionId: "source", titleSnapshot: "보험" }] };

test("renderer bridge preserves structured references for send, queue and queue edit", async () => {
  const previous = globalThis.window;
  const inputs: unknown[] = [];
  const capture = async (input: unknown) => { inputs.push(input); return {}; };
  Object.assign(globalThis, { window: { location: { origin: "http://localhost" }, butlerApp: {
    sendMessage: capture, queueMessage: capture, updateQueuedMessage: capture,
  } } });
  try {
    for (const [path, method] of [["/messages", "POST"], ["/session-queue", "POST"], ["/session-queue/q1", "PATCH"]]) {
      await api(path!, { method, body: JSON.stringify({ chat_id: "target", text: "비교 @보험", content_parts: content }) });
    }
    expect(inputs).toHaveLength(3);
    for (const input of inputs) expect((input as { contentParts: unknown }).contentParts).toEqual(content);
  } finally { Object.assign(globalThis, { window: previous }); }
});

test("actual Electron preload serializes references on all three message ingress routes", () => {
  const preloadPath = resolve(import.meta.dir, "../../packages/butler-app/client/electron/preload.cjs");
  const result = spawnSync("node", ["-e", `
    const Module = require("node:module"); const load = Module._load;
    let bridge; const bodies = [];
    Module._load = (request, parent, main) => request === "electron" ? {
      contextBridge: { exposeInMainWorld(name, value) { if (name === "butlerApp") bridge = value; } },
      ipcRenderer: { invoke: async channel => channel === "butler:get-local-auth-headers" ? {} : null, on() {}, removeListener() {} }
    } : load(request, parent, main);
    global.fetch = async (url, options) => {
      bodies.push({ path: new URL(url).pathname, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ protocol_version: "butler.app.v1", data: {} }) };
    };
    require(${JSON.stringify(preloadPath)});
    (async () => {
      const input = { chatId: "target", queuedMessageId: "q1", text: "비교 @보험", contentParts: ${JSON.stringify(content)} };
      await bridge.sendMessage(input); await bridge.queueMessage(input); await bridge.updateQueuedMessage(input);
      process.stdout.write(JSON.stringify(bodies));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], { encoding: "utf8" });
  expect(result.status).toBe(0);
  const calls = JSON.parse(result.stdout);
  expect(calls.map((call: { path: string }) => call.path)).toEqual(["/messages", "/session-queue", "/session-queue/q1"]);
  for (const call of calls) expect(call.body.content_parts).toEqual(content);
});
