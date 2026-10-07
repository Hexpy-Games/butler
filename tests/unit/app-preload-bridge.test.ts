// test-category: security
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { api, apiErrorCode } from "../../packages/butler-app/client/ui/src/app/api.ts";

describe("app-reference-electron-bridge.test.ts", () => {
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
});

describe("app-schedule-access-bridge.test.ts", () => {
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
});

describe("app-session-workspace-bridge.test.ts", () => {
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
});

describe("project-dashboard-electron-bridge.test.ts", () => {
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
});

describe("app-credential-bridge.test.ts", () => {
// #217 saved-key routes: GET /credentials, PATCH and DELETE /credentials/{name}.

function withBridge<T>(bridge: Record<string, unknown>, run: () => Promise<T>): Promise<T> {
  const previous = globalThis.window;
  Object.assign(globalThis, { window: { location: { origin: "http://localhost" }, butlerApp: bridge } });
  return run().finally(() => Object.assign(globalThis, { window: previous }));
}

test("renderer bridge maps the saved-key list, replace and delete routes", async () => {
  const calls: Array<{ method: string; input: unknown }> = [];
  const capture = (method: string, data: unknown) => async (input?: unknown) => {
    calls.push({ method, input });
    return { ok: true, data };
  };
  await withBridge({
    listCredentials: capture("listCredentials", { credentials: [], store: { backend: "fallback_file" } }),
    replaceCredential: capture("replaceCredential", { credential: { id: "openai" } }),
    deleteCredential: capture("deleteCredential", { removed_model_refs: [] }),
  }, async () => {
    const list = await api<{ credentials: unknown[] }>("/credentials");
    expect(list.credentials).toEqual([]);
    await api("/credentials/openai%202", { method: "PATCH", body: JSON.stringify({ api_key: "sk-new-key", verify: true }) });
    await api("/credentials/openai", { method: "DELETE" });
    await api("/credentials/openai?force=true", { method: "DELETE" });
  });
  expect(calls).toEqual([
    { method: "listCredentials", input: undefined },
    { method: "replaceCredential", input: { name: "openai 2", request: { api_key: "sk-new-key", verify: true } } },
    { method: "deleteCredential", input: { name: "openai", force: false } },
    { method: "deleteCredential", input: { name: "openai", force: true } },
  ]);
});

test("renderer bridge keeps the code of a refused replace or delete", async () => {
  const refused = (code: string, status: number) => async () =>
    ({ ok: false, error: { schema: "butler.app.bridge-error.v1", code, status } });
  const caught = (run: Promise<unknown>) => run.then(() => null, (error: unknown) => error);
  await withBridge({
    replaceCredential: refused("invalid_key", 400),
    deleteCredential: refused("credential_in_use_by_default", 409),
  }, async () => {
    const replace = await caught(api("/credentials/openai", { method: "PATCH", body: JSON.stringify({ api_key: "x", verify: true }) }));
    expect(apiErrorCode(replace)).toBe("invalid_key");
    const remove = await caught(api("/credentials/openai?force=true", { method: "DELETE" }));
    expect(apiErrorCode(remove)).toBe("credential_in_use_by_default");
    expect((remove as { status?: number }).status).toBe(409);
  });
});

test("actual Electron preload sends the saved-key routes and returns bounded envelopes", () => {
  const preloadPath = resolve(import.meta.dir, "../../packages/butler-app/client/electron/preload.cjs");
  const result = spawnSync("node", ["-e", `
    const Module = require("node:module"); const load = Module._load;
    let bridge; const calls = [];
    Module._load = (request, parent, main) => request === "electron" ? {
      contextBridge: { exposeInMainWorld(name, value) { if (name === "butlerApp") bridge = value; } },
      ipcRenderer: { invoke: async channel => channel === "butler:get-local-auth-headers" ? {} : null, on() {}, removeListener() {} }
    } : load(request, parent, main);
    global.fetch = async (url, options) => {
      const parsed = new URL(url);
      calls.push({ method: options.method ?? "GET", path: parsed.pathname + parsed.search, body: options.body ? JSON.parse(options.body) : null });
      if (options.method === "DELETE" && parsed.search === "") {
        return { ok: false, status: 409, json: async () => ({ error: { code: "credential_in_use", message: "2 registered model(s) use this API key." } }) };
      }
      return { ok: true, json: async () => ({ protocol_version: "butler.app.v1", data: { ok: true } }) };
    };
    require(${JSON.stringify(preloadPath)});
    (async () => {
      const results = [
        await bridge.listCredentials(),
        await bridge.replaceCredential({ name: "openai/2", request: { api_key: "sk-new", verify: true } }),
        await bridge.deleteCredential({ name: "openai", force: true }),
        await bridge.deleteCredential({ name: "openai" }),
      ];
      process.stdout.write(JSON.stringify({ calls, results }));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  const { calls, results } = JSON.parse(result.stdout);
  expect(calls.map((call: { method: string; path: string }) => `${call.method} ${call.path}`)).toEqual([
    "GET /credentials",
    "PATCH /credentials/openai%2F2",
    "DELETE /credentials/openai?force=true",
    "DELETE /credentials/openai",
  ]);
  expect(calls[1].body).toEqual({ api_key: "sk-new", verify: true });
  expect(results[0]).toEqual({ ok: true, data: { ok: true } });
  expect(results[3]).toEqual({ ok: false, error: { schema: "butler.app.bridge-error.v1", code: "credential_in_use", status: 409 } });
});
});
