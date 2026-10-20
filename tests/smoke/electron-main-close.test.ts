// test-category: race
import { test, expect, spyOn } from "bun:test";
import { connectElectronMain } from "../support/electron-main-cdp";

test("main inspector close joins its disconnect before the caller sends a quit signal", async () => {
  let disconnected = false;
  const original = globalThis.WebSocket;
  class Socket extends EventTarget {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 1;
    constructor(_url: string) { super(); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
    close() {
      if (this.readyState >= 2) return;
      this.readyState = 2;
      setTimeout(() => { disconnected = true; this.readyState = 3; this.dispatchEvent(new Event("close")); }, 30);
    }
  }
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(Response.json([{ webSocketDebuggerUrl: "ws://127.0.0.1/inspector" }]));
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  try {
    const client = await connectElectronMain(0);
    await client.close();
    expect(disconnected).toBe(true);
  } finally { globalThis.WebSocket = original; fetch.mockRestore(); }
});
