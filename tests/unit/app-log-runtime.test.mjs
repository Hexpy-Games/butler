// test-category: security
import { test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
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
    await Promise.resolve();
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
    for (const name of await readdir(directory)) rows.push(...(await readFile(join(directory, name), "utf8")).trim().split("\n").map(line => JSON.parse(line)));
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
    await Promise.resolve();
    emit("before-disable");
    await new Promise(resolve => setTimeout(resolve, 200));
    diagnostics = false;
    await new Promise(resolve => setTimeout(resolve, 2100));
    emit("after-disable");
    await runtime.quit();
    const directory = join(root, "logs/app/debug");
    const rows = [];
    for (const name of await readdir(directory)) rows.push(...(await readFile(join(directory, name), "utf8")).trim().split("\n").map(line => JSON.parse(line)));
    expect(rows.map(row => row.attrs.marker)).toEqual(["before-disable"]);
  } finally { await runtime.quit(); await rm(root, { recursive: true, force: true }); }
});
