// test-category: security
import { test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installAppLogging } from "../../packages/butler-app/client/electron/log/runtime.mjs";

test("renderer log ingress authenticates sender, binds process, validates fields and rate limits", async () => {
  const root = await mkdtemp(join(tmpdir(), "app-log-ingress-"));
  const app = new EventEmitter(), ipcMain = new EventEmitter();
  ipcMain.handle = () => {};
  const sender = {};
  const runtime = installAppLogging({ app, ipcMain, dataRoot: root, getVersion: () => "1.0.0",
    readConfig: async () => ({ effective: { level: "standard", category_levels: {} } }),
    isSender: event => event.sender === sender });
  const row = { level: "INFO", category: "app.ui", event: "ui.send", attrs: {} };
  const emit = input => ipcMain.emit("butler:app-log", { sender }, input);
  try {
    await runtime.refresh();
    ipcMain.emit("butler:app-log", { sender: {} }, row);
    emit({ ...row, process: "agent" });
    emit({ ...row, category: "lifecycle" });
    emit({ ...row, level: "TRACE" });
    emit({ ...row, attrs: { nested: {} } });
    emit({ ...row, attrs: { oversized: "a".repeat(17_000) } });
    emit({ ...row, traceparent: "00-" + "0".repeat(32) + "-" + "1".repeat(16) + "-01" });
    const traceparent = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01";
    for (let index = 0; index < 101; index++) emit({ ...row, traceparent, attrs: { index } });
    await runtime.quit();
    const directory = join(root, "logs/app/main");
    const rows = [];
    for (const name of await readdir(directory).catch(() => [])) rows.push(...(await readFile(join(directory, name), "utf8")).trim().split("\n").map(line => JSON.parse(line)));
    const actions = rows.filter(row => row.event === "ui.send");
    expect(actions.length).toBe(100);
    expect(actions.every(row => row.process === "app.renderer" && row.trace_id === "0123456789abcdef0123456789abcdef")).toBe(true);
    expect(actions.map(row => row.attrs.index)).toEqual(Array.from({ length: 100 }, (_, index) => index));
  } finally { await runtime.quit(); await rm(root, { recursive: true, force: true }); }
});

test("disabling diagnostics reverts App verbosity even when config access is denied", async () => {
  const root = await mkdtemp(join(tmpdir(), "app-log-disable-"));
  const app = new EventEmitter(), ipcMain = new EventEmitter();
  ipcMain.handle = () => {};
  const sender = {};
  let diagnostics = true;
  const runtime = installAppLogging({ app, ipcMain, dataRoot: root, getVersion: () => "1.0.0",
    readConfig: async () => diagnostics ? { effective: { level: "full", category_levels: {} }, full_expires_at: new Date(Date.now() + 3600_000).toISOString() } : null,
    readSettings: async () => ({ diagnostics_enabled: diagnostics }), isSender: event => event.sender === sender });
  const emit = marker => ipcMain.emit("butler:app-log", { sender }, {
    level: "DEBUG", category: "http.client", event: "image.fetch", attrs: { marker } });
  try {
    await runtime.refresh();
    emit("before-disable");
    await new Promise(resolve => setTimeout(resolve, 200));
    diagnostics = false;
    await runtime.refresh();
    emit("after-disable");
    await runtime.quit();
    const directory = join(root, "logs/app/debug");
    const rows = [];
    for (const name of await readdir(directory).catch(() => [])) rows.push(...(await readFile(join(directory, name), "utf8")).trim().split("\n").map(line => JSON.parse(line)));
    expect(rows.map(row => row.attrs.marker)).toEqual([]);
  } finally { await runtime.quit(); await rm(root, { recursive: true, force: true }); }
});

test("only the log owner refreshes on changes; IPC results do not become global secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "app-log-change-"));
  const app = new EventEmitter(), ipcMain = new EventEmitter(), handlers = new Map();
  ipcMain.handle = (name, handler) => handlers.set(name, handler);
  let owner = false, reads = 0;
  const sender = {};
  const runtime = installAppLogging({ app, ipcMain, dataRoot: root, getVersion: () => "1.0.0",
    isWriter: () => owner, isSender: event => event.sender === sender,
    readConfig: async () => { reads++; return { effective: { level: "full", category_levels: {} } }; } });
  try {
    await runtime.refresh();
    expect(reads).toBe(0);
    owner = true;
    await handlers.get("butler:app-log-change")({ sender });
    expect(reads).toBe(1);
    ipcMain.handle("arbitrary", () => ({ code: "book", token: "ordinary-result-value" }));
    await handlers.get("arbitrary")({ sender }, "private composer draft");
    ipcMain.emit("butler:app-log", { sender }, { level: "INFO", category: "app.ui", event: "ui.send", attrs: { marker: "book ordinary-result-value" } });
    await new Promise(resolve => setTimeout(resolve, 2100));
    expect(reads).toBe(1);
    await runtime.quit();
    const main = join(root, "logs/app/main");
    const text = (await Promise.all((await readdir(main)).map(name => readFile(join(main, name), "utf8")))).join("");
    expect(text).toContain("book ordinary-result-value");
    expect(text).toContain('"msg":"Message sent"');
    const debug = join(root, "logs/app/debug");
    const detail = (await Promise.all((await readdir(debug)).map(name => readFile(join(debug, name), "utf8")))).join("");
    expect(detail).not.toContain("private composer draft");
    expect(detail).toContain('"body_ref"');
  } finally { await runtime.quit(); await rm(root, { recursive: true, force: true }); }
});

test("the known full expiry refreshes the agent fallback once", async () => {
  const root = await mkdtemp(join(tmpdir(), "app-log-expiry-change-"));
  const app = new EventEmitter(), ipcMain = new EventEmitter(), sender = {};
  ipcMain.handle = () => {};
  let reads = 0;
  const runtime = installAppLogging({ app, ipcMain, dataRoot: root, getVersion: () => "1.0.0",
    isSender: event => event.sender === sender,
    readConfig: async () => ++reads === 1
      ? { effective: { level: "full", category_levels: {} }, full_expires_at: new Date(Date.now() + 120).toISOString() }
      : { effective: { level: "detailed", category_levels: {} } } });
  try {
    await runtime.refresh();
    await new Promise(resolve => setTimeout(resolve, 230));
    expect(reads).toBe(2);
    ipcMain.emit("butler:app-log", { sender }, { level: "DEBUG", category: "http.client", event: "image.fetch", attrs: { marker: "agent-fallback" } });
    await runtime.quit();
    const dir = join(root, "logs/app/debug");
    const text = (await Promise.all((await readdir(dir)).map(name => readFile(join(dir, name), "utf8")))).join("");
    expect(text).toContain("agent-fallback");
  } finally { await runtime.quit(); await rm(root, { recursive: true, force: true }); }
});


test("window config refresh is skipped before readiness and bounded for a slow agent", async () => {
  const { refreshBeforeWindow } = await import("../../packages/butler-app/client/electron/log/events.mjs");
  let reads = 0, release;
  const pending = new Promise(resolve => { release = resolve; });
  const logging = { refresh: () => { reads++; return pending; } };
  await refreshBeforeWindow(logging, false);
  expect(reads).toBe(0);
  const started = performance.now();
  await refreshBeforeWindow(logging, true);
  const elapsed = performance.now() - started;
  expect(reads).toBe(1);
  expect(elapsed).toBeGreaterThanOrEqual(240);
  expect(elapsed).toBeLessThan(500);
  release();
  console.log(JSON.stringify({ slow_agent_window_wait_ms: elapsed }));
});

test("live gateway events refresh logging only on log settings changes and clear App logs", async () => {
  const { watchAppLogging } = await import("../../packages/butler-app/client/electron/log/events.mjs");
  let controller, refreshes = 0;
  const body = new ReadableStream({ start(value) { controller = value; } });
  const stop = watchAppLogging({ connect: async () => new Response(body),
    refresh: async () => { refreshes++; } });
  const settings = { log_level: "full", log_category_levels: {}, diagnostics_enabled: true };
  const emit = event => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  try {
    await tick();
    expect(refreshes).toBe(1);
    emit({ type: "settings.updated", payload: { settings } });
    await tick();
    expect(refreshes).toBe(2);
    emit({ type: "settings.updated", payload: { settings: { ...settings, appearance_theme: "dark" } } });
    await tick();
    expect(refreshes).toBe(2);
    for (const update of [{ log_level: "detailed" }, { log_category_levels: { ipc: "error" } }, { diagnostics_enabled: false }]) {
      Object.assign(settings, update);
      emit({ type: "settings.updated", payload: { settings } });
      await tick();
    }
    expect(refreshes).toBe(5);
    emit({ type: "logs.cleared", payload: {} });
    await tick();
    expect(refreshes).toBe(6);
  } finally { stop(); controller.close(); }
});


test("committed lower settings delete bodies even before the agent logger applies the level", async () => {
  const root = await mkdtemp(join(tmpdir(), "app-log-committed-level-"));
  const app = new EventEmitter(), ipcMain = new EventEmitter(), handlers = new Map(), sender = {};
  ipcMain.handle = (name, handler) => handlers.set(name, handler);
  let settings = { diagnostics_enabled: true, log_level: "full", log_category_levels: {} };
  const stale = { effective: { level: "full", category_levels: {} }, full_expires_at: new Date(Date.now() + 3600_000).toISOString() };
  const runtime = installAppLogging({ app, ipcMain, dataRoot: root, getVersion: () => "1.0.0",
    readConfig: async () => stale, readSettings: async () => settings, isSender: event => event.sender === sender });
  ipcMain.handle("capture", () => {});
  const bodies = join(root, "logs/app/bodies");
  try {
    await runtime.refresh();
    await handlers.get("capture")({ sender }, "before-commit");
    await new Promise(resolve => setTimeout(resolve, 200));
    expect((await readdir(bodies)).length).toBeGreaterThan(0);
    settings = { ...settings, log_level: "standard" };
    await runtime.refresh();
    expect(await stat(bodies).catch(() => null)).toBeNull();
    await handlers.get("capture")({ sender }, "after-commit");
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(await stat(bodies).catch(() => null)).toBeNull();
    expect(stale.effective.level).toBe("full");
  } finally { await runtime.quit(); await rm(root, { recursive: true, force: true }); }
});
