/** Main inspector only; no diagnostic IPC in the App renderer. */
export async function mainInspector(port: number, running: () => boolean = () => true) {
  const deadline = Date.now() + 60_000;
  let targets: Array<{ webSocketDebuggerUrl: string }> = [];
  while (!targets.length && Date.now() < deadline) {
    if (!running()) throw new Error("Electron exited before inspector opened");
    targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()).catch(() => []);
    if (!targets.length) await Bun.sleep(100);
  }
  if (!targets[0]) throw new Error("Main inspector unavailable");
  const socket = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise<void>((done, fail) => {
    socket.addEventListener("open", () => done(), { once: true });
    socket.addEventListener("error", () => fail(new Error("Inspector connection failed")), { once: true });
  });
  let id = 0;
  const pending = new Map<number, { done: (value: unknown) => void; fail: (error: Error) => void }>();
  socket.addEventListener("message", event => {
    const reply = JSON.parse(String(event.data));
    const entry = pending.get(reply.id); if (!entry) return;
    pending.delete(reply.id);
    if (reply.error || reply.result?.exceptionDetails) entry.fail(new Error(JSON.stringify(reply)));
    else entry.done(reply.result.result.value);
  });
  return {
    evaluate<T>(expression: string): Promise<T> {
      return new Promise((done, fail) => {
        const request = ++id;
        const timer = setTimeout(() => { pending.delete(request); fail(new Error("Inspector request timed out")); }, 30_000);
        pending.set(request, { done: value => { clearTimeout(timer); done(value as T); }, fail: error => { clearTimeout(timer); fail(error); } });
        socket.send(JSON.stringify({ id: request, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
      });
    },
    close() { for (const entry of pending.values()) entry.fail(new Error("Inspector closed")); pending.clear(); socket.close(); },
  };
}
