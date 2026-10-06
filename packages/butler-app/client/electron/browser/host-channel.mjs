import { checkOutput, closeOutputChecks } from "./output-check.mjs";

// Dedicated main-only SSE. Credentials and page diagnostics never reach a renderer.
export function createBrowserHost({ fetch, adminCredential, executeBrowser, snapshot, enabled = () => true }) {
  let controller = null;
  let reconnect = null;
  let running = false;
  let stateTimer = null;
  let stateFlush = Promise.resolve();
  const flushState = () => {
    stateFlush = stateFlush.catch(() => {}).then(async () => {
      if (running && controller && !controller.signal.aborted && snapshot?.()) {
        await request("/internal/browser-host/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tabs: snapshot().tabs }) });
      }
    });
    return stateFlush;
  };
  const request = (path, init = {}) => fetch(path, { ...init, signal: controller.signal,
    headers: { "x-butler-admin": adminCredential(), ...init.headers } });
  async function storeStills(frame, result) {
    let latest;
    for (const step of [result,...result.steps ?? []]) {
      const still=step.still;delete step.still;
      if (!still) continue;
      const response=await request("/internal/browser-host/stills",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({session:frame.session,tab:result.tab,still})});
      if (response.ok) { const payload=await response.json();step.tab=result.tab;step.still_file=payload.data?.still_file ?? payload.still_file;latest=step.still_file; }
    }
    if(latest) result.still_file=latest;
  }
  async function execute(frame) {
    await flushState();
    let result;
    try { result = frame.op === "output.check" ? await checkOutput(frame.args, frame.lease) : await executeBrowser?.(frame) ?? { status: "unknown", reason: "unsupported_op" }; }
    catch { result = { status: "unknown", reason: "executor_error" }; }
    await flushState();
    await storeStills(frame,result);
    await request(`/internal/browser-host/results/${encodeURIComponent(frame.id)}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(result),
    });
  }
  async function connect() {
    controller = new AbortController();
    try {
      const response = await request("/internal/browser-host");
      if (!response.ok) throw new Error("host_unavailable");
      await flushState();
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
    start() { if (!running && enabled()) { running = true; void connect(); } },
    changed() {
      if (!stateTimer && running) stateTimer = setTimeout(() => { stateTimer = null; void flushState().catch(() => {}); }, 50);
    },
    stop() { clearTimeout(stateTimer); running = false; clearTimeout(reconnect); controller?.abort(); closeOutputChecks(); },
  };
}
