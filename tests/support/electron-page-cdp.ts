/** The page-CDP protocol used by the existing native Electron smokes. */
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface ElectronPage {
  evaluate<T>(fn: () => T): Promise<Awaited<T>>;
  expression<T>(expression: string): Promise<T>;
  frameExpression<T>(origin: string, expression: string): Promise<T>;
  press(key: "Escape" | "Enter" | "Home" | "End" | "ArrowRight" | "ArrowDown" | "ArrowUp" | "Shift+Delete"): Promise<void>;
  insertText(text: string): Promise<void>;
  screenshot(): Promise<Uint8Array>;
  clickText(text: string, scope: string): Promise<void>;
  clickSelector(selector: string): Promise<void>;
  /** Clicks the one element whose computed role and accessible name match exactly. */
  clickRole(role: string, name: string): Promise<void>;
  movePointer(x: number, y: number): Promise<void>;
  rightClick(x: number, y: number): Promise<void>;
  pointerDown(x: number, y: number): Promise<void>;
  dragPointer(x: number, y: number): Promise<void>;
  pointerUp(x: number, y: number): Promise<void>;
  drag(from: {x:number;y:number}, to: {x:number;y:number}): Promise<void>;
  /** Polls `fn(arg)` in the page; `arg` crosses as JSON. */
  waitForFunction<T = undefined>(fn: (arg: T) => unknown, arg?: T): Promise<void>;
  reload(): Promise<void>;
  diagnostics(): Promise<unknown>;
  close(): void;
}

export async function electronPage(port: number, origin = "app://butler/"): Promise<ElectronPage> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()).catch(() => []) as Array<{ type: string; url?: string; webSocketDebuggerUrl?: string }>;
    const target = targets.find(t => t.type === "page" && t.url?.startsWith(origin) && t.webSocketDebuggerUrl);
    if (target) return connect(target.webSocketDebuggerUrl!);
    await new Promise(done => setTimeout(done, 200));
  }
  throw new Error("Electron page did not start.");
}

/**
 * Page of the App launched with `--remote-debugging-port=0`: each launch binds a fresh port and
 * records it in `<profile>/DevToolsActivePort`. Use this when the App relaunches itself (update),
 * because its descendants may keep a fixed port bound. `previous` is the endpoint already used.
 */
export async function electronProfilePage(profile: string, previous: string | null, origin = "app://butler/"): Promise<{ page: ElectronPage; endpoint: string }> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const endpoint = await readFile(join(profile, "DevToolsActivePort"), "utf8").then(text => text.trim(), () => null);
    if (endpoint && endpoint !== previous) {
      const port = Number(endpoint.split("\n")[0]);
      // A stale port can still be held, without accepting, by a handle another process inherited.
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2_000) })
        .then(r => r.json()).catch(() => []) as Array<{ type: string; url?: string; webSocketDebuggerUrl?: string }>;
      const target = targets.find(t => t.type === "page" && t.url?.startsWith(origin) && t.webSocketDebuggerUrl);
      if (target) return { page: await connect(target.webSocketDebuggerUrl!), endpoint };
    }
    await new Promise(done => setTimeout(done, 200));
  }
  throw new Error("Electron page did not start.");
}

/** Cross-site output frames can have their own Chromium target. */
export async function electronFrame(port: number, origin: string): Promise<ElectronPage | null> {
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(r=>r.json()) as Array<{ url?:string;webSocketDebuggerUrl?:string }>;
  const frame = targets.find(target=>target.url?.startsWith(`${origin}/__o/`) && target.webSocketDebuggerUrl);
  return frame ? connect(frame.webSocketDebuggerUrl!) : null;
}

async function transport(url: string) {
  const socket = new WebSocket(url);
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => { socket.close(); fail(new Error("Electron CDP connection timed out.")); }, 10_000);
    socket.addEventListener("open", () => { clearTimeout(timer); done(); }, { once: true });
    socket.addEventListener("close", () => { clearTimeout(timer); fail(new Error("Electron CDP closed before connecting.")); }, { once: true });
    socket.addEventListener("error", () => fail(new Error("Electron CDP connection failed.")), { once: true });
  });
  const errors: string[] = [];
  const contexts = new Map<number, string>();
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let id = 0;
  socket.addEventListener("message", message => {
    const payload = JSON.parse(String(message.data));
    if (payload.method === "Runtime.executionContextCreated" && payload.params.context.auxData?.isDefault) {
      contexts.set(payload.params.context.id, payload.params.context.origin);
    }
    if (payload.method === "Runtime.executionContextDestroyed") contexts.delete(payload.params.executionContextId);
    if (payload.method === "Runtime.executionContextsCleared") contexts.clear();
    if (payload.method === "Log.entryAdded" && payload.params.entry.level === "error") errors.push(payload.params.entry.text);
    if (payload.method === "Runtime.exceptionThrown") errors.push(payload.params.exceptionDetails.exception?.description ?? payload.params.exceptionDetails.text);
    const entry = pending.get(payload.id);
    if (!entry) return;
    pending.delete(payload.id);
    if (payload.error) entry.reject(new Error(payload.error.message));
    else entry.resolve(payload.result);
  });
  socket.addEventListener("close", () => {
    for (const entry of pending.values()) entry.reject(new Error("Electron CDP closed."));
    pending.clear();
  });
  const send = (method: string, params: Record<string, unknown>) => new Promise<unknown>((resolve, reject) => {
    const next = ++id;
    pending.set(next, { resolve, reject });
    setTimeout(() => { if (pending.delete(next)) reject(new Error(`Electron CDP timed out: ${method}`)); }, 10_000);
    socket.send(JSON.stringify({ id: next, method, params }));
  });
  return { socket, send, errors, contexts };
}

/** In-page `this` → centre point of an enabled, hit-testable click target. */
const CLICK_POINT = `function() {
  'use strict';
  const node=this;
  if(!node || node.disabled || node.getAttribute('aria-disabled')==='true')throw new Error('Click target unavailable');
  node.scrollIntoView({block:'center'});
  const box=node.getBoundingClientRect(),x=box.x+box.width/2,y=box.y+box.height/2;
  if(!box.width || !box.height || !node.contains(document.elementFromPoint(x,y)))throw new Error('Click target not hit-testable');
  return {x,y};
}`;

async function connect(url: string): Promise<ElectronPage> {
  const { socket, send, errors, contexts } = await transport(url);
  async function expression<T>(text: string, contextId?: number): Promise<T> {
    const result = await send("Runtime.evaluate", { expression: text, contextId, awaitPromise: true, returnByValue: true }) as { exceptionDetails?: unknown; result: { value: T } };
    assert.ok(!result.exceptionDetails, `Electron evaluation failed: ${JSON.stringify(result.exceptionDetails)}`);
    return result.result.value;
  }
  await send("Log.enable", {});
  await send("Runtime.enable", {});
  async function diagnostics() {
    return { errors, page: await expression("({url:location.href,ready:document.readyState,preload:Boolean(window.butlerApp)})").catch(() => null) };
  }
  await send("Page.enable", {});
  async function waitForFunction<T>(fn: (arg: T) => unknown, arg?: T) {
    const deadline = Date.now() + 30_000;
    const call = `(${fn.toString()})(${arg === undefined ? "" : JSON.stringify(arg)})`;
    while (Date.now() < deadline) {
      if (await expression(call).catch(() => false)) return;
      await new Promise(done => setTimeout(done, 200));
    }
    throw new Error(`Electron UI did not become ready: ${fn.toString()}; ${JSON.stringify(await diagnostics())}`);
  }
  async function clickPoint(point: { x: number; y: number }) {
    await send("Input.dispatchMouseEvent", {type:"mousePressed",...point,button:"left",clickCount:1});
    await send("Input.dispatchMouseEvent", {type:"mouseReleased",...point,button:"left",clickCount:1});
  }
  return {
    expression, waitForFunction, diagnostics,
    movePointer: async (x,y) => { await send("Input.dispatchMouseEvent", {type:"mouseMoved",x,y,buttons:0}); },
    rightClick: async (x, y) => {
      await send("Input.dispatchMouseEvent", { type:"mouseMoved", x, y, buttons:0 });
      await send("Input.dispatchMouseEvent", { type:"mousePressed", x, y, button:"right", buttons:2, clickCount:1 });
      await send("Input.dispatchMouseEvent", { type:"mouseReleased", x, y, button:"right", buttons:0, clickCount:1 });
    },
    pointerDown: async (x,y) => { await send("Input.dispatchMouseEvent", {type:"mousePressed",x,y,button:"left",buttons:1,clickCount:1}); },
    dragPointer: async (x,y) => { await send("Input.dispatchMouseEvent", {type:"mouseMoved",x,y,button:"left",buttons:1}); },
    pointerUp: async (x,y) => { await send("Input.dispatchMouseEvent", {type:"mouseReleased",x,y,button:"left",buttons:0,clickCount:1}); },
    drag: async (from,to) => {
      await send("Input.dispatchMouseEvent",{type:"mousePressed",...from,button:"left",buttons:1,clickCount:1});
      for(let step=1;step<=12;step++) {
        await send("Input.dispatchMouseEvent",{type:"mouseMoved",x:from.x+(to.x-from.x)*step/12,y:from.y+(to.y-from.y)*step/12,button:"left",buttons:1});
        await new Promise(done=>setTimeout(done,16));
      }
      await send("Input.dispatchMouseEvent",{type:"mouseReleased",...to,button:"left",buttons:0,clickCount:1});
    },
    press: async key => {
      const shifted = key === "Shift+Delete";
      const actual = shifted ? "Delete" : key;
      const windowsVirtualKeyCode = { Escape: 27, Enter: 13, Home: 36, End: 35, ArrowRight: 39, ArrowDown: 40, ArrowUp: 38, Delete: 46 }[actual];
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: actual, code: actual, windowsVirtualKeyCode, modifiers: shifted ? 8 : 0 });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: actual, code: actual, windowsVirtualKeyCode, modifiers: shifted ? 8 : 0 });
    },
    insertText: async text => { await send("Input.insertText", { text }); },
    frameExpression: (origin, text) => {
      const id = [...contexts].find(([, value]) => value === origin)?.[0];
      if (!id) return Promise.reject(new Error("Electron output context not ready"));
      return expression(text, id);
    },
    screenshot: async () => {
      const result = await send("Page.captureScreenshot", { format:"png" }) as { data:string };
      return Buffer.from(result.data, "base64");
    },
    clickSelector: async selector => {
      await clickPoint(await expression<{x:number;y:number}>(`(${CLICK_POINT}).call(document.querySelector(${JSON.stringify(selector)}))`));
    },
    clickRole: async (role, name) => {
      const { root } = await send("DOM.getDocument", { depth: 0 }) as { root: { nodeId: number } };
      const { nodes } = await send("Accessibility.queryAXTree", { nodeId: root.nodeId, role, accessibleName: name }) as { nodes: Array<{ ignored: boolean; backendDOMNodeId?: number }> };
      const found = nodes.filter(node => !node.ignored && node.backendDOMNodeId);
      if (found.length !== 1) throw new Error(`Click target unavailable: ${found.length} ${role} named ${JSON.stringify(name)}`);
      const { object } = await send("DOM.resolveNode", { backendNodeId: found[0]!.backendDOMNodeId }) as { object: { objectId: string } };
      const result = await send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: CLICK_POINT, returnByValue: true }) as { exceptionDetails?: unknown; result: { value: { x: number; y: number } } };
      assert.ok(!result.exceptionDetails, `Electron evaluation failed: ${JSON.stringify(result.exceptionDetails)}`);
      await clickPoint(result.result.value);
    },
    clickText: async (text, scope) => {
      const point = await expression<{ x:number;y:number }>(`(() => {
        const matches=Array.from(document.querySelectorAll(${JSON.stringify(scope)})).filter(e=>(e.getAttribute('aria-label') || e.textContent)?.trim()===${JSON.stringify(text)});
        const node=matches.find(e=>{const box=e.getBoundingClientRect();return box.y>=0 && box.bottom<=innerHeight;}) ?? matches[0];
        if (!node) throw new Error('Click target missing');
        node.scrollIntoView({block:'center'});
        const box=node.getBoundingClientRect();return {x:box.x+box.width/2,y:box.y+box.height/2};
      })()`);
      await send("Input.dispatchMouseEvent", { type:"mousePressed", ...point, button:"left", clickCount:1 });
      await send("Input.dispatchMouseEvent", { type:"mouseReleased", ...point, button:"left", clickCount:1 });
    },
    evaluate: fn => expression(`(${fn.toString()})()`),
    reload: async () => {
      // The preload bridge exists before navigation completes. Reloading then
      // aborts main's initial loadURL and makes startup fail with ERR_ABORTED.
      await waitForFunction(() => document.readyState === "complete" && Boolean(window.butlerApp));
      const loaded = new Promise<void>((done, fail) => {
        const timer = setTimeout(() => { socket.removeEventListener("message", onMessage); fail(new Error("Electron reload did not finish.")); }, 30_000);
        const onMessage = (event: MessageEvent) => {
          if (JSON.parse(String(event.data)).method !== "Page.loadEventFired") return;
          clearTimeout(timer); socket.removeEventListener("message", onMessage); done();
        };
        socket.addEventListener("message", onMessage);
      });
      await Promise.all([loaded, send("Page.reload", {})]);
      await waitForFunction(() => document.readyState === "complete" && Boolean(window.butlerApp));
    },
    close: () => socket.close(),
  };
}
