// test-category: race
import { test, expect, mock, spyOn } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
mock.module("electron", () => ({ app: { on() {} }, BrowserWindow: class {}, WebContentsView: class {}, ipcMain: { on() {}, handle() {} }, nativeImage: {}, session: {}, powerMonitor: {}, clipboard: {}, dialog: {} }));
const require = createRequire(import.meta.url);
const { beginDialog, resolveDialog, answerDialog, wireDialogs } = require("../../packages/butler-app/client/electron/browser/dialogs.mjs");
const { actBatch } = require("../../packages/butler-app/client/electron/browser/act.mjs");
const { createStillOutbox } = require("../../packages/butler-app/client/electron/browser/still-outbox.mjs");
const browser = { publish() {}, sync() {} };
async function fixture(run: (tab: any, queue: any) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "dialog-settlement-"));
  const delivered: any[] = [];
  const queue = createStillOutbox({ directory, send: async (value: any) => { delivered.push(value); }, retryMs: [] });
  const dbg = Object.assign(new EventEmitter(), { sendCommand: async () => {} });
  const image: any = { resize: () => image, toBitmap: () => Buffer.alloc(4), toJPEG: () => Buffer.from("image"), isEmpty: () => false };
  const contents = Object.assign(new EventEmitter(), { debugger: dbg, isDestroyed: () => false, isLoading: () => false,
    executeJavaScriptInIsolatedWorld: async () => true, capturePage: async () => image });
  const tab: any = { id: "t", epoch: 1, owner: "conversation:s", holder: "agent", view: { webContents: contents }, delivered };
  try { await run(tab, queue); } finally { clearTimeout(tab.dialog?.timer); queue.stop(); await rm(directory, { recursive: true, force: true }); }
}
async function reserve(tab: any, queue: any, id = "act") {
  await queue.reserve({ id, session: "s", tab: "t", args: { steps: [{}] } });
  tab.pendingBatch = [{ status: "unknown", reason: "dialog_pending" }];
  tab.pendingStill = { id, session: "s", deliver: (value: any) => queue.deliver(id, value) };
  await queue.finish(id, { steps: tab.pendingBatch });
}
async function empty(tab: any, queue: any) {
  await Promise.all([...(tab.stillJobs ?? [])].map((job: any) => job.promise));
  await queue.flush(); expect(queue.pending).toBe(0);
}
for (const exit of ["timeout", "user", "page", "next-act", "second-dialog"]) test(`dialog still settles on ${exit}`, () => fixture(async (tab, queue) => {
  let timeout: (() => void) | undefined;
  const original = globalThis.setTimeout;
  const clock = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms: number, ...args: any[]) => {
    if (ms === 120_000) { timeout = fn; return original(() => {}, ms); }
    return original(fn, ms, ...args);
  }) as typeof setTimeout);
  try {
    wireDialogs(browser, tab);
    beginDialog(browser, tab, { type: "confirm" }, exit === "page" ? undefined : () => {});
    await reserve(tab, queue);
    if (exit === "timeout") { timeout!(); await new Promise(done => setImmediate(done)); }
    if (exit === "user") await resolveDialog(browser, tab, { accept: false });
    if (exit === "page") tab.view.webContents.debugger.emit("message", {}, "Page.javascriptDialogClosed", {});
    if (exit === "next-act") await actBatch(tab, { steps: [] }, "s");
    if (exit === "second-dialog") {
      tab.view.webContents.executeJavaScriptInIsolatedWorld = async () => { beginDialog(browser, tab, { type: "confirm" }, () => {}); return true; };
      const first = await answerDialog(browser, tab, { dialog: tab.dialog.id, accept: true });
      expect(first.status).toBe("dialog_pending");
      tab.view.webContents.executeJavaScriptInIsolatedWorld = async () => true;
      await answerDialog(browser, tab, { dialog: tab.dialog.id, accept: true });
    }
    await empty(tab, queue);
    expect(tab.delivered).toHaveLength(1);
    if (exit === "second-dialog") expect(tab.delivered[0].still.base64).toBe(Buffer.from("image").toString("base64"));
    else expect(typeof tab.delivered[0].reason).toBe("string");
  } finally { clock.mockRestore(); }
}));
test("20 dialog-stopped acts drain their complete backlog", () => fixture(async (tab, queue) => {
  for (let index = 0; index < 20; index++) {
    beginDialog(browser, tab, { type: "confirm" }, () => {});
    await reserve(tab, queue, String(index));
    await resolveDialog(browser, tab, { accept: false });
  }
  await empty(tab, queue);
  expect(queue.records.size).toBe(0);
}));
