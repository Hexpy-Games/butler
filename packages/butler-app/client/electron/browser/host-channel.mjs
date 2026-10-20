import { createStillOutbox } from "./still-outbox.mjs";
import { createVisitQueue } from "./history.mjs";
import { checkOutput, closeOutputChecks } from "./output-check.mjs";
import { closeReaderRenders, renderReader } from "./reader-render.mjs";

// Dedicated main-only SSE. Credentials and page diagnostics never reach a renderer.
// `onClosed` (the hidden host): a lost channel ends the host instead of reconnecting.
export function createBrowserHost({ fetch, adminCredential, executeBrowser, resetBrowser, snapshot, enabled = () => true, onClosed, stillDirectory, replayDirectories, onStillDelivered }) {
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
        const response=await request("/internal/browser-host/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tabs: snapshot().tabs, still_backlog: stills.pending }) });
        if(response.ok) published=current;
      }
    });
    return stateFlush;
  };
  const request = (path, init = {}) => fetch(path, { ...init, signal: controller.signal,
    headers: { "x-butler-admin": adminCredential(), ...init.headers } });
  const stills = createStillOutbox({ directory: stillDirectory, replayDirectories, onChanged: () => { revision++; if (running) void flushState().catch(() => {}); }, send: value => uploadStill(fetch, adminCredential, value, onStillDelivered) });
  const execute = createExecutor({ flushState, stills, executeBrowser, request });
  async function connect() {
    resetBrowser?.();
    controller = new AbortController();published=-1;
    try {
      const response = await request("/internal/browser-host");
      if (!response.ok) throw new Error("host_unavailable");
      await flushState();
      await history.flush();
      void stills.connect().catch(() => {});
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
    finally { controller.abort(); resetBrowser?.(); closeOutputChecks(); closeReaderRenders(); }
    if (running && onClosed) { running = false; onClosed(); }
    else if (running) reconnect = setTimeout(connect, 1000);
  }
  const history = createVisitQueue(async visits => {
    const response = await request("/internal/browser-host/visits", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ visits }) });
    if (!response.ok) throw new Error("history_unavailable");
  });
  return {
    history,
    flushStills: () => stills.flush(),
    ...createSecrets(request, () => running && controller),
    start() { if (!running && enabled()) { running = true; void connect(); } },
    changed() {
      revision++;
      if (!stateTimer && running) stateTimer = setTimeout(() => { stateTimer = null; void flushState().catch(() => {}); }, 50);
    },
    stop() { stills.stop(); clearTimeout(stateTimer); running = false; clearTimeout(reconnect); controller?.abort(); resetBrowser?.(); closeOutputChecks(); closeReaderRenders(); },
  };
}

function createExecutor({ flushState, stills, executeBrowser, request }) {
  return async function execute(frame) {
    await flushState();
    let result;
    const evidence = frame.op === "tab.act";
    try {
      if (evidence) {
        try { await stills.reserve(frame); }
        catch (error) { result = { status: "not_dispatched", reason: error.message === "still_storage_full" ? "still_storage_full" : "still_storage_unavailable" }; }
      }
      result ??= frame.op === "output.check" ? await checkOutput(frame.args, frame.lease)
        : frame.op === "reader.render" ? await renderReader(frame.args)
          : await executeBrowser?.({ ...frame, deliverStill: value => stills.deliver(frame.id, value) })
            ?? { status: "unknown", reason: "unsupported_op" };
    }
    catch (error) {
      // Keep the cause: an executor error is otherwise invisible to diagnosis.
      console.error(`[browser] ${frame.op} failed:`, error?.stack ?? String(error));
      result = { status: "unknown", reason: "executor_error" };
    }
    if (evidence) await stills.finish(frame.id, result);
    await flushState();
    // Media and rendered pages carry bounded bytes on their own routes.
    const results = frame.op === "tab.image_collect" ? "images" : ["reader.render", "tab.read"].includes(frame.op) ? "renders" : "results";
    await request(`/internal/browser-host/${results}/${encodeURIComponent(frame.id)}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(result),
    });
  };
}

function createSecrets(request, available) {
  /** The fill password, once per token; never logged, never returned to Rust. */
  async function credential(token, origin) {
    const unavailable = { error: "credential_unavailable" };
    if (!available() || !/^[0-9a-f]{32}$/u.test(token) || typeof origin !== "string") return unavailable;
    try {
      const response = await request(`/internal/browser-host/credentials/${token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ origin }) });
      if (!response.ok) return response.status === 403 ? { error: "origin_mismatch" } : unavailable;
      const value = await response.json();
      return typeof value?.password === "string" ? { password: value.password } : unavailable;
    } catch { return unavailable; }
  }
  /** A saved card's or profile's values, once per token, for the exact origins
   * the token binds; never logged, never returned to Rust. */
  async function vault(token, origin, frameOrigins) {
    const unavailable = { error: "vault_unavailable" };
    if (!available() || !/^[0-9a-f]{32}$/u.test(token) || typeof origin !== "string" || !Array.isArray(frameOrigins)) return unavailable;
    try {
      const response = await request(`/internal/browser-host/vault/${token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ origin, frame_origins: frameOrigins }) });
      if (!response.ok) return response.status === 403 ? { error: "origin_mismatch" } : unavailable;
      const values = await response.json();
      return values && typeof values === "object" && !Array.isArray(values) ? { values } : unavailable;
    } catch { return unavailable; }
  }
  return { credential, vault };
}

async function uploadStill(fetch, credential, value, onDelivered) {
  // SSE reconnection must not cancel an independent evidence upload.
  const response = await fetch("/internal/browser-host/stills", { method: "POST",
    signal: AbortSignal.timeout(5000), headers: { "x-butler-admin": credential(), "content-type": "application/json" },
    body: JSON.stringify(value) });
  if (!response.ok) {
    const code = await response.json().then(value => value.error?.code).catch(() => undefined);
    const reason = typeof code === "string" && /^[a-z_]{1,64}$/u.test(code) ? code : "still_upload_failed";
    throw Object.assign(Error(reason), { status: response.status });
  }
  onDelivered?.({ id: value.act_id, session: value.session });
}
