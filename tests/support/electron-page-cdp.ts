/** The page-CDP protocol used by the existing native Electron smokes. */
import { strict as assert } from "node:assert";

export interface ElectronPage {
  evaluate<T>(fn: () => T): Promise<Awaited<T>>;
  expression<T>(expression: string): Promise<T>;
  waitForFunction(fn: () => unknown): Promise<void>;
  reload(): Promise<void>;
  diagnostics(): Promise<unknown>;
  close(): void;
}

export async function electronPage(port: number): Promise<ElectronPage> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()).catch(() => []) as Array<{ type: string; url?: string; webSocketDebuggerUrl?: string }>;
    const target = targets.find(t => t.type === "page" && t.url?.startsWith("app://butler/") && t.webSocketDebuggerUrl);
    if (target) return connect(target.webSocketDebuggerUrl!);
    await new Promise(done => setTimeout(done, 200));
  }
  throw new Error("Electron page did not start.");
}

async function connect(url: string): Promise<ElectronPage> {
  const socket = new WebSocket(url);
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => { socket.close(); fail(new Error("Electron CDP connection timed out.")); }, 10_000);
    socket.addEventListener("open", () => { clearTimeout(timer); done(); }, { once: true });
    socket.addEventListener("close", () => { clearTimeout(timer); fail(new Error("Electron CDP closed before connecting.")); }, { once: true });
    socket.addEventListener("error", () => fail(new Error("Electron CDP connection failed.")), { once: true });
  });
  const errors: string[] = [];
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let id = 0;
  socket.addEventListener("message", message => {
    const payload = JSON.parse(String(message.data));
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
  async function expression<T>(text: string): Promise<T> {
    const result = await send("Runtime.evaluate", { expression: text, awaitPromise: true, returnByValue: true }) as { exceptionDetails?: unknown; result: { value: T } };
    assert.ok(!result.exceptionDetails, `Electron evaluation failed: ${JSON.stringify(result.exceptionDetails)}`);
    return result.result.value;
  }
  await send("Log.enable", {});
  await send("Runtime.enable", {});
  async function diagnostics() {
    return { errors, page: await expression("({url:location.href,ready:document.readyState,preload:Boolean(window.butlerApp)})").catch(() => null) };
  }
  async function waitForFunction(fn: () => unknown) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (await expression(`(${fn.toString()})()`).catch(() => false)) return;
      await new Promise(done => setTimeout(done, 200));
    }
    throw new Error(`Electron UI did not become ready: ${fn.toString()}; ${JSON.stringify(await diagnostics())}`);
  }
  return {
    expression, waitForFunction, diagnostics,
    evaluate: fn => expression(`(${fn.toString()})()`),
    reload: async () => { await send("Page.reload", {}); await waitForFunction(() => Boolean(window.butlerApp)); },
    close: () => socket.close(),
  };
}
