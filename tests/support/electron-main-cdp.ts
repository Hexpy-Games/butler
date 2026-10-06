/** Main-process inspector; does not expose diagnostics through product IPC. */
export async function electronMain<T>(inspectorPort: number, expression: string, queryInstances = false): Promise<T> {
  const targets = await fetch(`http://127.0.0.1:${inspectorPort}/json/list`).then(r => r.json());
  const socket = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise<void>((done, fail) => {
    socket.addEventListener("open", () => done(), { once: true });
    socket.addEventListener("error", fail, { once: true });
  });
  let id = 0;
  const send = (method: string, params: Record<string, unknown>) => new Promise<{ result: { value: T; objectId: string }; objects: { objectId: string } }>((done, fail) => {
    const requestId = ++id;
    const timer = setTimeout(() => fail(new Error("Main inspector timed out")), 10_000);
    const receive = (event: MessageEvent) => {
      const reply = JSON.parse(String(event.data));
      if (reply.id !== requestId) return;
      clearTimeout(timer); socket.removeEventListener("message", receive);
      if (reply.error || reply.result.exceptionDetails) fail(new Error(JSON.stringify(reply)));
      else done(reply.result);
    };
    socket.addEventListener("message", receive);
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  try {
    const result = await send("Runtime.evaluate", { expression: `(async () => (${expression}))()`,
      awaitPromise: true, returnByValue: !queryInstances });
    if (!queryInstances) return result.result.value;
    const objects = await send("Runtime.queryObjects", { prototypeObjectId: result.result.objectId });
    const bounds = await send("Runtime.callFunctionOn", { objectId: objects.objects.objectId,
      // Heap queries include unbranded prototype objects; native brand checks
      // exclude those, while errors from actual tray objects still fail.
      functionDeclaration: "function(){return this.flatMap(t=>{try{return t.isDestroyed()?[]:[t.getBounds()]}catch(e){if(e.message.startsWith('Illegal invocation:'))return [];throw e}})}", returnByValue: true });
    return bounds.result.value;
  } finally { socket.close(); }
}
