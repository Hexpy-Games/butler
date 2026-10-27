import { expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { api } from "../../packages/butler-app/client/ui/src/app/api.ts";
import { root, type Route } from "./app-bridge-route-analysis";

export interface Invocation { method: string; input: unknown; site?: string }
const preloadPath = resolve(root, "../electron/preload.cjs");
export function preloadProbe(
  invocations: Invocation[] = [],
  refused: Invocation[] = [],
  response?: { status: number; body: unknown },
) {
  const result = spawnSync("node", ["-e", `
    const Module = require("node:module"); const load = Module._load;
    let bridge; let site; const calls = []; const refusals = []; const errors = []; const values = [];
    const response = ${JSON.stringify(response ?? null)};
    Module._load = (request, parent, main) => request === "electron" ? {
      contextBridge: { exposeInMainWorld(name, value) { if (name === "butlerApp") bridge = value; } },
      ipcRenderer: { invoke: async () => null, on() {}, send() {}, removeListener() {} }
    } : load(request, parent, main);
    global.fetch = async (url, options = {}) => {
      const parsed = new URL(url);
      calls.push({ ...(site ? { site } : {}), path: parsed.pathname + parsed.search, method: options.method ?? "GET", ...(options.body === undefined ? {} : { body: JSON.parse(options.body) }) });
      return response ? { ok: response.status < 400, status: response.status, json: async () => response.body }
        : { ok: true, json: async () => ({ protocol_version: "butler.app.v1", data: {} }) };
    };
    require(${JSON.stringify(preloadPath)});
    (async () => {
      for (const invocation of ${JSON.stringify(invocations)}) {
        const { method, input } = invocation; site = invocation.site;
        try {
          const value = await bridge[method](input); values.push(value);
          errors.push(value?.ok === false ? JSON.stringify(value.error) : null);
        }
        catch (error) { values.push(null); errors.push(String(error)); }
      }
      for (const { method, input } of ${JSON.stringify(refused)}) {
        try { await bridge[method](input); refusals.push(false); }
        catch { refusals.push(true); }
      }
      process.stdout.write(JSON.stringify({ keys: Object.keys(bridge), calls, refusals, errors, values }));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], { encoding: "utf8", env: { ...process.env, BUTLER_APP_SERVER_URL: "http://127.0.0.1:1" } });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as { errors: Array<string | null>; values: unknown[]; keys: string[]; refusals: boolean[]; calls: Array<{ path: string; method: string; body?: unknown; site?: string }> };
}

export function recordingBridge(recorded: Invocation[]) {
  return new Proxy({}, { get: (_target, key) => async (input: unknown) => {
    recorded.push({ method: String(key), input });
    return { ok: true, data: {} };
  } });
}
export async function withBridge<T>(bridge: object, run: () => Promise<T>): Promise<T> {
  const previous = globalThis.window;
  Object.assign(globalThis, { window: { location: { origin: "http://localhost" }, butlerApp: bridge } });
  try { return await run(); }
  finally { Object.assign(globalThis, { window: previous }); }
}

// Representative opaque IDs also exercise route tables that validate UUIDs, hashes or trace IDs.
export const placeholders = ["x", "00000000-0000-4000-8000-000000000000", "a".repeat(64), "a".repeat(32),
  `p-${"a".repeat(64)}`, "file-00000000-0000-4000-8000-000000000000", "/message-files/file-00000000-0000-4000-8000-000000000000"];
export interface RecordedRoute {
  route: Route; path: string; candidate: string; placeholder: string; invocations: Invocation[];
}
export async function exercise(route: Route, path: string, recorded: Invocation[], ids = placeholders) {
  const errors: string[] = [];
  for (const placeholder of ids) {
    const candidate = path.replace(/\bx\b/g, placeholder);
    const before = recorded.length;
    try { await api(candidate, { method: route.method, ...(route.method === "GET" ? {} : { body: "{}" }) }); }
    catch (error) { errors.push(String(error)); }
    if (recorded.length > before) return {
      errors: errors.filter(error => !/Unsupported Butler app API route/.test(error)), gap: false,
      accepted: { route, path, candidate, placeholder, invocations: recorded.slice(before) },
    };
  }
  return { errors, gap: true };
}

function refusalReasons(entry: RecordedRoute, errors: Array<string | null>) {
  return errors.flatMap((error, index) => error === null ? []
    : [`${entry.route.site} ${entry.route.method} ${entry.candidate} -> ${entry.invocations[index].method}: ${error}`]);
}

// Replay the exact renderer inputs first, then batch every alternative for rejected routes.
export async function checkPreload(accepted: RecordedRoute[]) {
  const invocations = accepted.flatMap(entry => entry.invocations.map(invocation => ({ ...invocation, site: entry.route.site })));
  const firstStart = performance.now();
  const output = preloadProbe(invocations);
  const firstPreloadMs = performance.now() - firstStart;
  const retryStart = performance.now();
  let offset = 0;
  const pending = [];
  const alternatives: Invocation[] = [];
  for (const entry of accepted) {
    const errors = output.errors.slice(offset, offset + entry.invocations.length);
    offset += entry.invocations.length;
    if (errors.every(error => error === null)) continue;
    const attempts = refusalReasons(entry, errors);
    const candidates = [];
    for (const placeholder of placeholders.filter(id => id !== entry.placeholder && /\bx\b/u.test(entry.path))) {
      const recorded: Invocation[] = [];
      const result = await withBridge(recordingBridge(recorded), () => exercise(entry.route, entry.path, recorded, [placeholder]));
      if (!result.accepted) continue;
      const start = alternatives.length;
      alternatives.push(...recorded.map(invocation => ({ ...invocation, site: entry.route.site })));
      candidates.push({ entry: result.accepted, rendererErrors: result.errors, start, end: alternatives.length });
    }
    pending.push({ attempts, candidates });
  }
  const replay = alternatives.length ? preloadProbe(alternatives) : undefined;
  const refusals: string[] = [];
  for (const { attempts, candidates } of pending) {
    let allowed = false;
    for (const candidate of candidates) {
      const errors = replay!.errors.slice(candidate.start, candidate.end);
      attempts.push(...refusalReasons(candidate.entry, errors));
      if (!candidate.rendererErrors.length && errors.every(error => error === null)) allowed = true;
    }
    if (!allowed) refusals.push(...attempts);
  }
  return {
    gateway: matchGateway([...output.calls, ...(replay?.calls ?? [])]),
    keys: output.keys, refusals, checked: invocations.length + alternatives.length,
    firstPreloadMs, retryMs: performance.now() - retryStart, nodeChildren: 1 + Number(!!replay),
  };
}


// router.rs has no method information; this checks path membership only.
// Include the secondary table explicitly chained by router::table().
function matchGateway(forwards: ReturnType<typeof preloadProbe>["calls"]) {
  const directory = resolve(root, "../../../butler-agent/rust/crates/butler-gateway/src/gateway/http");
  const patterns = ["router.rs", "canon_sidebar.rs"].flatMap(file => {
    const source = readFileSync(resolve(directory, file), "utf8");
    const entries = [...source.matchAll(/\(\s*"([^"\n]+)"\s*,\s*Handler::\w+\s*,?\s*\)/gu)];
    expect(entries.length, `Cannot parse gateway route table ${file}`).toBeGreaterThan(0);
    return entries.map(([, path]) => new RegExp(`^${path!.split("/").map(segment => {
      if (/^\{\*[^}]+\}$/u.test(segment)) return ".+";
      if (/^\{[^}]+\}$/u.test(segment)) return "[^/]+";
      return segment.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    }).join("/")}$`, "u"));
  });
  const unmatched = forwards.filter(forward => !patterns.some(pattern => pattern.test(new URL(forward.path, "http://local").pathname)))
    .map(({ method, path, site }) => `${method} ${path} (${site})`);
  return { matched: forwards.length - unmatched.length, unmatched };
}
