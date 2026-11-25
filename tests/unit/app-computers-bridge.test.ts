// test-category: security
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { api } from "../../packages/butler-app/client/ui/src/app/api.ts";

function withBridge<T>(bridge: Record<string, unknown>, run: () => Promise<T>): Promise<T> {
  const previous = globalThis.window;
  Object.assign(globalThis, { window: { location: { origin: "http://localhost" }, butlerApp: bridge } });
  return run().finally(() => Object.assign(globalThis, { window: previous }));
}

const id = "01234567-89ab-4def-8123-456789abcdef";
const path = `/computers/${id}`;
const host = { address: "studio", port: 22 };
const added = { ...host, name: "Studio", folder: "~/projects" };
const model = { model_source: "follow" };
const kind = { kind: "default" };
const flow = "flow_1";
const routes = [
  ["GET", "/computers", undefined, "listComputers", undefined, undefined],
  ["POST", "/computers", added, "addComputer", added, { payload: added }],
  ["POST", "/computers/host-key", host, "checkComputerHostKey", host, { payload: host }],
  ["DELETE", path, undefined, "deleteComputer", { id }, { id }],
  ["POST", `${path}/start`, undefined, "startComputer", { id }, { id }],
  ["GET", `${path}/connection`, undefined, "getComputerConnection", { id }, { id }],
  ["POST", `${path}/reconnect`, undefined, "reconnectComputer", { id }, { id }],
  ["PATCH", path, model, "updateComputerModel", { id, payload: model }, { id, payload: model }],
  ["PUT", path, { ...added, ...model }, "editComputer", { id, payload: { ...added, ...model } }, { id, payload: { ...added, ...model } }],
  ["POST", `${path}/oauth/start`, kind, "startComputerOauth", { id, payload: kind }, { id, payload: kind }],
  ["GET", `${path}/oauth/${flow}`, undefined, "getComputerOauth", { id, flow }, { id, flow }],
  ["POST", `${path}/oauth/${flow}/cancel`, {}, "cancelComputerOauth", { id, flow }, { id, flow }],
] as const;

test("renderer maps computer routes to the security bridge actions", async () => {
  const calls: unknown[] = [];
  const bridge = Object.fromEntries(routes.map(([, , , action]) => [action, async (input: unknown) => {
    calls.push([action, input]);
    return { ok: true, data: {} };
  }]));
  await withBridge(bridge, async () => {
    for (const [method, path, body] of routes) await api(path, { method, body: JSON.stringify(body) });
    await expect(api("/computers/x/unknown")).rejects.toThrow("Unsupported Butler app API route");
  });
  expect(calls).toEqual(routes.map(([, , , action, input]) => [action, input]));
});

test("actual preload sends every security action through main's security channel", async () => {
  let bridge: Record<string, (input?: unknown) => Promise<unknown>> = {};
  const calls: unknown[] = [];
  runInNewContext(readFileSync(resolve(import.meta.dir, "../../packages/butler-app/client/electron/preload.cjs"), "utf8"), {
    process: { env: { BUTLER_APP_SERVER_URL: "http://127.0.0.1:12345" }, argv: [], platform: "darwin" },
    URL, URLSearchParams, TextEncoder, TextDecoder, setTimeout, clearTimeout,
    require: () => ({
      contextBridge: { exposeInMainWorld: (name: string, value: typeof bridge) => { if (name === "butlerApp") bridge = value; } },
      ipcRenderer: {
        invoke: async (channel: string, input: unknown) => { calls.push([channel, input]); return { ok: true, data: {} }; },
        on() {}, send() {}, removeListener() {},
      },
    }),
    fetch: () => { throw new Error("Computer requests must go through main"); },
  });
  const preloadRoutes = [
    ...routes.map(([, , , action, input, body]) => [action, input, action, body] as const),
    ["getButlerAccount", undefined, "getButlerAccount", undefined],
    ["postButlerAccount", {}, "postButlerAccount", { payload: {} }],
    ["setButlerAccountDevPlan", { plan: "free" }, "postButlerAccount", { payload: { action: "dev_plan", plan: "free" } }],
    ["signOutButlerAccount", undefined, "signOutButlerAccount", undefined],
    ["listButlerAccountDevices", undefined, "listButlerAccountDevices", undefined],
    ["revokeButlerAccountDevice", { id: "Device_1" }, "revokeButlerAccountDevice", { id: "Device_1" }],
    ["getButlerBackup", undefined, "getButlerBackup", undefined],
    ["postButlerBackup", {}, "postButlerBackup", { payload: {} }],
  ] as const;
  for (const [action, input] of preloadRoutes) expect(await bridge[action]!(input)).toEqual({ ok: true, data: {} });
  expect(calls).toEqual(preloadRoutes.map(([, , route, body]) => ["butler:security-request", body ? { route, body } : { route }]));
});
