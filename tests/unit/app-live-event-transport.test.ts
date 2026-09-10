import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { subscribeLiveEvents } from "../../packages/butler-app/client/ui/src/app/api.ts";

test("browser heartbeat is a health signal, never a timeline event", () => {
  const previousWindow = globalThis.window;
  const previousSource = globalThis.EventSource;
  class FakeSource extends EventTarget {
    static instances: FakeSource[] = [];
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    closed = false;
    constructor() { super(); FakeSource.instances.push(this); }
    close() { this.closed = true; }
  }
  Object.assign(globalThis, { window: { location: { origin: "http://localhost" } }, EventSource: FakeSource });
  try {
    const events: unknown[] = [];
    let opens = 0; let beats = 0;
    const stop = subscribeLiveEvents(42, event => events.push(event), () => {}, () => opens++, () => beats++);
    const source = FakeSource.instances[0]!;
    source.onopen?.();
    source.dispatchEvent(new Event("heartbeat"));
    source.onmessage?.({ data: JSON.stringify({ id: 43, type: "message.created" }) });
    expect({ opens, beats, events }).toEqual({ opens: 1, beats: 1, events: [{ id: 43, type: "message.created" }] });
    stop();
    expect(source.closed).toBe(true);
  } finally { Object.assign(globalThis, { window: previousWindow, EventSource: previousSource }); }
});

test("Electron preload separates fragmented heartbeats and releases its reader", () => {
  const preload = resolve(import.meta.dir, "../../packages/butler-app/client/electron/preload.cjs");
  const result = spawnSync("node", ["-e", `
    const Module = require("node:module"); const load = Module._load; let bridge;
    Module._load = (name, parent, main) => name === "electron" ? {
      contextBridge: { exposeInMainWorld(name, value) { if (name === "butlerApp") bridge = value; } },
      ipcRenderer: { invoke: async () => null, on() {}, removeListener() {} }
    } : load(name, parent, main);
    let controller, opens = 0, beats = 0, errors = 0; const events = [];
    const body = new ReadableStream({ start(c) { controller = c; } });
    global.fetch = async () => ({ ok: true, body });
    require(${JSON.stringify(preload)});
    const stop = bridge.subscribeLiveEvents({ cursor: 42 }, {
      onOpen() { opens++; }, onHeartbeat() { beats++; }, onError() { errors++; }, onEvent(e) { events.push(e); }
    });
    (async () => {
      await new Promise(r => setTimeout(r, 10));
      const encoder = new TextEncoder();
      for (const part of ['event: heart', 'beat\\r\\ndata: null\\r\\n\\r\\n', ': heartbeat\\n\\n', 'id: 43\\ndata: {"id":43,"type":"message.created"}\\n\\n']) controller.enqueue(encoder.encode(part));
      await new Promise(r => setTimeout(r, 10)); stop();
      await new Promise(r => setTimeout(r, 10));
      console.log(JSON.stringify({ opens, beats, errors, events, locked: body.locked }));
    })().catch(e => { console.error(e); process.exitCode = 1; });
  `], { encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ opens: 1, beats: 2, errors: 0,
    events: [{ id: 43, type: "message.created" }], locked: false });
});
