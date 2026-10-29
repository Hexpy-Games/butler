// test-category: security
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const preloadPath = resolve(import.meta.dir, "../../packages/butler-app/client/electron/preload.cjs");
const VALID = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

/** Each user-action bridge call with `traceparent`, as the local agent receives its headers. */
function sentHeaders(traceparent: unknown): Array<{ path: string; headers: Record<string, string> }> {
  const result = spawnSync("node", ["-e", `
    const Module = require("node:module"); const load = Module._load;
    let bridge; const sent = [];
    Module._load = (request, parent, main) => request === "electron" ? {
      contextBridge: { exposeInMainWorld(name, value) { if (name === "butlerApp") bridge = value; } },
      ipcRenderer: { invoke: async channel => channel === "butler:get-local-auth-headers" ? { authorization: "Bearer local" } : null,
        on() {}, send() {}, removeListener() {} }
    } : load(request, parent, main);
    global.fetch = async (url, options) => {
      sent.push({ path: new URL(url).pathname, headers: options.headers });
      return { ok: true, json: async () => ({ protocol_version: "butler.app.v1", data: {} }) };
    };
    require(${JSON.stringify(preloadPath)});
    (async () => {
      const traceparent = ${JSON.stringify(traceparent)};
      // A caller cannot smuggle other headers through the input.
      const extra = { headers: { authorization: "Bearer other", cookie: "x" } };
      await bridge.sendMessage({ chatId: "c", text: "t", traceparent, ...extra });
      await bridge.queueMessage({ chatId: "c", text: "t", traceparent, ...extra });
      await bridge.sendQueuedMessageNow({ queuedMessageId: "queue", traceparent, ...extra });
      await bridge.retryTurn({ turnId: "turn", traceparent, ...extra });
      await bridge.retryTurnWithCurrentControls({ turnId: "turn", traceparent, ...extra });
      await bridge.cancelTurn({ turnId: "turn", traceparent, ...extra });
      await bridge.updateSessionControls({ sessionId: "c", controls: {}, traceparent, ...extra });
      process.stdout.write(JSON.stringify(sent));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], { encoding: "utf8" });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
}

test("the desktop bridge forwards a well-formed traceparent and keeps its own credentials", () => {
  const calls = sentHeaders(VALID);
  expect(calls.map((call) => call.path)).toEqual([
    "/messages", "/session-queue", "/session-queue/queue/send-now", "/turns/turn/retry", "/turns/turn/retry-current", "/turns/turn/cancel", "/sessions/c/controls",
  ]);
  for (const call of calls) {
    expect(call.headers).toEqual({ "content-type": "application/json", traceparent: VALID, authorization: "Bearer local" });
  }
});

test("anything but an exact lowercase W3C traceparent is dropped", () => {
  const rejected: unknown[] = [
    VALID.toUpperCase(),
    `x${VALID}`,
    `${VALID}\nauthorization: Bearer other`,
    `${VALID} `,
    "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
    "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
    "00-4bf92f3577b34da6a3ce929d0e0e473-00f067aa0ba902b7-01",
    "01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    { traceparent: VALID },
    ["traceparent", VALID],
    null,
  ];
  for (const value of rejected) {
    for (const call of sentHeaders(value)) {
      expect(call.headers).toEqual({ "content-type": "application/json", authorization: "Bearer local" });
    }
  }
});
