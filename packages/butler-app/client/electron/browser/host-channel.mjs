import { checkOutput, closeOutputChecks } from "./output-check.mjs";

// Dedicated main-only SSE. Credentials and page diagnostics never reach a renderer.
export function createBrowserHost({ fetch, adminCredential, executeBrowser, resetBrowser, snapshot, enabled = () => true }) {
  let controller = null;
  let reconnect = null;
  let running = false;
  let stateTimer = null;
  let stateFlush = Promise.resolve();
  let revision=0,published=-1;
  const flushState = () => {
    stateFlush = stateFlush.catch(() => {}).then(async () => {
      if (running && controller && !controller.signal.aborted && snapshot && revision!==published) {
        const current=revision;
        const response=await request("/internal/browser-host/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tabs: snapshot().tabs }) });
        if(response.ok) published=current;
      }
    });
    return stateFlush;
  };
  const request = (path, init = {}) => fetch(path, { ...init, signal: controller.signal,
    headers: { "x-butler-admin": adminCredential(), ...init.headers } });
  async function execute(frame) {
    await flushState();
    let result;
    try { result = frame.op === "output.check" ? await checkOutput(frame.args, frame.lease) : await executeBrowser?.(frame) ?? { status: "unknown", reason: "unsupported_op" }; }
    catch (error) {
      // Keep the cause: an executor error is otherwise invisible to diagnosis.
      console.error(`[browser] ${frame.op} failed:`, error?.stack ?? String(error));
      result = { status: "unknown", reason: "executor_error" };
    }
    await flushState();
    await request(`/internal/browser-host/results/${encodeURIComponent(frame.id)}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(result),
    });
  }
  async function connect() {
    resetBrowser?.();
    controller = new AbortController();published=-1;
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
          if (data) {
            const frame = JSON.parse(data.slice(5));
            if (frame.op?.startsWith("use.")) { await executeBrowser?.(frame); await flushState(); }
            else void execute(frame).catch(() => {});
          }
        }
      }
    } catch { /* Disconnect is an unknown result, never replay a call. */ }
    finally { controller.abort(); resetBrowser?.(); closeOutputChecks(); }
    if (running) reconnect = setTimeout(connect, 1000);
  }
  /** The fill password, once per token; never logged, never returned to Rust. */
  async function credential(token, origin) {
    const unavailable = { error: "credential_unavailable" };
    if (!running || !controller || !/^[0-9a-f]{32}$/u.test(token) || typeof origin !== "string") return unavailable;
    try {
      const response = await request(`/internal/browser-host/credentials/${token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ origin }) });
      if (!response.ok) return response.status === 403 ? { error: "origin_mismatch" } : unavailable;
      const value = await response.json();
      return typeof value?.password === "string" ? { password: value.password } : unavailable;
    } catch { return unavailable; }
  }
  return {
    credential,
    start() { if (!running && enabled()) { running = true; void connect(); } },
    changed() {
      revision++;
      if (!stateTimer && running) stateTimer = setTimeout(() => { stateTimer = null; void flushState().catch(() => {}); }, 50);
    },
    stop() { clearTimeout(stateTimer); running = false; clearTimeout(reconnect); controller?.abort(); resetBrowser?.(); closeOutputChecks(); },
  };
}
