/** Read only isolation facts from an explicitly started Electron main inspector. */
export async function nativeMainFacts(port: number, data: string) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets = await response.json() as Array<{ webSocketDebuggerUrl: string }>;
  const target = targets[0];
  if (!target) throw new Error("Native main inspector unavailable");
  return await new Promise<{ pid: number; dataIsolated: boolean; shellIsolated: boolean }>((done, fail) => {
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    let facts: { pid: number; dataIsolated: boolean; shellIsolated: boolean } | undefined;
    socket.onclose = () => facts ? done(facts) : fail(new Error("Native main inspector closed before its response"));
    socket.onerror = () => { socket.close(); fail(new Error("Native main inspector connection failed")); };
    socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: {
      expression: `JSON.stringify({pid:process.pid,dataIsolated:process.env.BUTLER_DATA===${JSON.stringify(data)},shellIsolated:process.env.BUTLER_APP_DISABLE_SHELL_REGISTRATION==="1"})`,
      returnByValue: true,
    } }));
    socket.onmessage = (event) => {
      const result = JSON.parse(String(event.data));
      if (result.id !== 1) return;
      if (result.error || result.result?.exceptionDetails) { socket.close(); fail(new Error("Native main isolation facts unavailable")); return; }
      facts = JSON.parse(result.result.result.value);
      socket.close();
    };
  });
}
