// test-category: race
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { test, expect, mock } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
mock.module("electron", () => ({ app: { on() {} }, BrowserWindow: class {}, WebContentsView: class {}, ipcMain: { on() {}, handle() {} }, nativeImage: {}, session: {}, powerMonitor: {}, clipboard: {}, dialog: {} }));
function captureTab() {
  const contents = new EventEmitter();
  const image: any = { resize: () => image, toBitmap: () => Buffer.alloc(4), toJPEG: () => Buffer.from("abc"), isEmpty: () => false };
  Object.assign(contents, { debugger: new EventEmitter(), isDestroyed: () => false, isLoading: () => false,
    capturePage: async () => image, executeJavaScriptInIsolatedWorld: async () => true });
  return { epoch: 1, owner: "conversation:s", holder: "agent", view: { webContents: contents } };
}
const require = createRequire(import.meta.url);
const { drainStills, enqueueStill } = require("../../packages/butler-app/client/electron/browser/still-delivery.mjs");

test("a refused close does not cancel further input", async () => {
  const { requestClose, resolveDialog } = require("../../packages/butler-app/client/electron/browser/dialogs.mjs");
  const tab = { cancelled: false, owner: "conversation:s", dialog: { id: "d", type: "beforeunload", beforeUnloadClose: true } };
  const browser = { publish() {}, sync() {} };
  expect((await requestClose(browser, tab)).status).toBe("dialog_pending");
  await resolveDialog(browser, tab, { accept: false });
  expect(tab.cancelled).toBe(false);
});

test("delivery failure retains captured bytes instead of reporting upload_failed", async () => {
  const values: any[] = [];
  const tab: any = captureTab();
  enqueueStill(tab, 0, 1, async (value: any) => { values.push(value); throw Error("offline"); });
  await drainStills(tab);
  expect(values.some(value => value.reason === "upload_failed")).toBe(false);
});

test("durable outbox retries non-2xx, preserves the full queue and replays on connect", async () => {
  const { createStillOutbox } = require("../../packages/butler-app/client/electron/browser/still-outbox.mjs");
  const directory = await mkdtemp(join(tmpdir(), "still-outbox-"));
  let online = false, attempts = 0;
  const received: any[] = [];
  const send = async (value: any) => { attempts++; if (!online) throw Error("503"); received.push(value); };
  const queue = createStillOutbox({ directory, send, retryMs: [1, 2] });
  try {
    await queue.reserve({ id: "a", session: "s", tab: "t", args: { steps: [{}, {}, {}] } });
    await queue.finish("a", { steps: [{ status: "completed" }, { status: "unknown", reason: "dialog_pending" }, { status: "completed" }] });
    for (let step = 0; step < 3; step++) await queue.deliver("a", { step, still: { mime: "image/jpeg", base64: "YWJj" } });
    await queue.flush();
    expect(attempts).toBeGreaterThan(1);
    expect((await readdir(directory)).length).toBeGreaterThan(0);
    queue.stop();
    online = true;
    const replay = createStillOutbox({ directory, send, retryMs: [1, 2] });
    await replay.connect();
    await replay.flush();
    expect(received.map(value => value.step)).toEqual([0, 1, 2]);
    expect(received.every(value => value.still.base64 === "YWJj")).toBe(true);
    expect(await readdir(directory)).toEqual([]);
    replay.stop();
  } finally { queue.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("same-process SSE reconnect does not abort an in-flight JPEG upload", async () => {
  const { createBrowserHost } = require("../../packages/butler-app/client/electron/browser/host-channel.mjs");
  const directory = await mkdtemp(join(tmpdir(), "still-channel-"));
  let channel: ReadableStreamDefaultController<Uint8Array>, release: () => void, began: () => void;
  const uploading = new Promise<void>(done => { began = done; });
  const held = new Promise<void>(done => { release = done; });
  let uploadSignal: AbortSignal, connects = 0;
  const host = createBrowserHost({ stillDirectory: directory, adminCredential: () => "stub",
    executeBrowser: async (frame: any) => {
      await frame.deliverStill({ step: 0, still: { mime: "image/jpeg", base64: "YWJj" } });
      return { status: "ok", steps: [{ status: "completed" }] };
    },
    fetch: async (path: string, init: any) => {
      if (path === "/internal/browser-host") {
        connects++;
        return new Response(new ReadableStream({ start(controller) {
          channel = controller;
          if (connects === 1) controller.enqueue(new TextEncoder().encode('data: {"id":"a","op":"tab.act","session":"s","tab":"t","args":{"steps":[{}]}}\n\n'));
        } }));
      }
      if (path.endsWith("/stills")) { uploadSignal = init.signal; began(); await held; }
      return new Response("{}");
    },
  });
  try {
    host.start(); await uploading;
    channel!.close();
    await new Promise(done => setTimeout(done, 1100));
    expect(connects).toBe(2);
    expect(uploadSignal!.aborted).toBe(false);
    release!(); await host.flushStills();
    expect(await readdir(directory)).toEqual([]);
  } finally { release!(); host.stop(); channel!.close(); await rm(directory, { recursive: true, force: true }); }
});

test("quit deadline spools active-act pixels and every queued still for the next process", async () => {
  const { createStillOutbox } = require("../../packages/butler-app/client/electron/browser/still-outbox.mjs");
  const directory = await mkdtemp(join(tmpdir(), "still-quit-"));
  const queue = createStillOutbox({ directory, send: async () => { throw Error("offline"); }, retryMs: [] });
  const tab: any = { ...captureTab(), activeAct: new Promise(() => {}) };
  try {
    await queue.reserve({ id: "a", session: "s", tab: "t", args: { steps: [{}, {}, {}] } });
    for (let step = 0; step < 3; step++) enqueueStill(tab, step, 1, (value: any) => queue.deliver("a", value));
    await tab.stillCapture;
    await drainStills(tab, performance.now() + 10);
    await queue.lane;
    queue.stop();
    const received: any[] = [];
    const next = createStillOutbox({ directory, send: async (value: any) => { received.push(value); }, retryMs: [] });
    await next.connect();
    expect(received.map(value => value.step)).toEqual([0, 1, 2]);
    expect(received.every(value => value.still.base64 === "YWJj")).toBe(true);
    next.stop();
  } finally { queue.stop(); await rm(directory, { recursive: true, force: true }); }
});
