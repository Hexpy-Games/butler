import { checkOutput, closeOutputChecks } from "./output-check.mjs";

// Dedicated main-only SSE. Credentials and page diagnostics never reach a renderer.
export function createBrowserHost({ fetch, adminCredential }) {
  let controller = null;
  let reconnect = null;
  let running = false;
  const request = (path, init = {}) => fetch(path, { ...init, signal: controller.signal,
    headers: { "x-butler-admin": adminCredential(), ...init.headers } });
  async function execute(frame) {
    const result = frame.op === "output.check" ? await checkOutput(frame.args, frame.lease) : { status: "unknown", reason: "unsupported_op" };
    await request(`/internal/browser-host/results/${encodeURIComponent(frame.id)}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(result),
    });
  }
  async function connect() {
    controller = new AbortController();
    try {
      const response = await request("/internal/browser-host");
      if (!response.ok) throw new Error("host_unavailable");
      let pending = "";
      const decoder = new TextDecoder();
      for await (const chunk of response.body) {
        pending += decoder.decode(chunk, { stream: true }).replaceAll("\r\n", "\n");
        let boundary;
        while ((boundary = pending.indexOf("\n\n")) !== -1) {
          const event = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          const data = event.split("\n").find(line => line.startsWith("data:"));
          if (data) void execute(JSON.parse(data.slice(5))).catch(() => {});
        }
      }
    } catch { /* Disconnect is an unknown result, never replay a call. */ }
    finally { controller.abort(); closeOutputChecks(); }
    if (running) reconnect = setTimeout(connect, 1000);
  }
  return {
    start() { if (!running) { running = true; void connect(); } },
    stop() { running = false; clearTimeout(reconnect); controller?.abort(); closeOutputChecks(); },
  };
}
