import { createAppLogWriter } from "./writer.mjs";
import { normalizeCrash } from "../ui-crash-log.mjs";

let writer;
export function appLog(level, category, event, attrs = {}, extra = {}) {
  writer?.record({ level, category, event, msg: event, attrs, ...extra });
}
export function networkLog(event, raw, attrs = {}) {
  try { appLog("DEBUG", "http.client", event, { ...attrs, url: new URL(raw).origin }); } catch { /* No non-web URLs. */ }
}
const LEVELS = new Set(["INFO", "ERROR", "DEBUG", "TRACE"]);
const CATEGORIES = new Set(["app.ui", "http.client"]);
const EVENTS = new Set(["ui.send", "ui.stop", "ui.model_pick", "ui.retry", "ui.error", "image.fetch"]);
const TRACE = /^00-(?!0{32})([a-f0-9]{32})-(?!0{16})([a-f0-9]{16})-[a-f0-9]{2}$/u;

export function installAppLogging({ app, ipcMain, dataRoot, getVersion, readConfig, isSender }) {
  writer = createAppLogWriter(dataRoot);
  const limits = new WeakMap();
  ipcMain.on("butler:app-log", (event, row) => {
    if (!isSender(event) || !validateRenderer(row)) return;
    const now = Date.now();
    const budget = limits.get(event.sender) ?? { start: now, count: 0 };
    if (now - budget.start >= 1000) { budget.start = now; budget.count = 0; }
    limits.set(event.sender, budget);
    if (++budget.count > 100) return;
    const trace = row.traceparent?.match(TRACE);
    writer.record({ level: row.level, category: row.category, event: row.event, msg: row.event,
      ...(trace ? { trace_id: trace[1], span_id: trace[2] } : {}),
      ...(row.chat_id ? { chat_id: row.chat_id } : {}), ...(row.turn_id ? { turn_id: row.turn_id } : {}),
      attrs: row.attrs ?? {} }, "app.renderer");
  });
  // Wrap the existing handlers, preserving their sender checks, values and failures.
  const handle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (name, listener) => handle(name, async (event, ...args) => {
    const start = performance.now();
    try {
      if (writer.enabled("ipc", "TRACE")) appLog("TRACE", "ipc", "ipc.payload", { name, payload: args });
      const result = await listener(event, ...args);
      writer.observe(result);
      return result;
    } finally { appLog("DEBUG", "ipc", "ipc.completed", { name }, { duration_ms: performance.now() - start }); }
  });
  let refreshing = false;
  const refresh = async () => {
    if (refreshing) return;
    refreshing = true;
    try { writer.configure(await readConfig()); } catch { /* Keep last effective level while reconnecting. */ }
    finally { refreshing = false; }
  };
  const poll = setInterval(refresh, 2000); poll.unref();
  let version = "unknown";
  const ready = Promise.all([refresh(), Promise.resolve().then(getVersion)]).then(([, value]) => {
    version = value; appLog("INFO", "lifecycle", "app.start", { version });
  }).catch(() => appLog("ERROR", "lifecycle", "app.version_failed"));
  void ready;
  app.on("render-process-gone", (_event, _contents, details) => appLog("ERROR", "app.ui", "renderer.crash", details));
  app.on("child-process-gone", (_event, details) => appLog("ERROR", "lifecycle", "process.crash", details));
  return {
    secrets(value) { writer.observe(value); },
    crash(input) { writer.record({ level: "ERROR", category: "app.ui", event: "ui.error", msg: "UI error", error: normalizeCrash(input, version) }, "app.renderer"); },
    async quit() { clearInterval(poll); await writer.quit(); },
    updater(updater) {
      updater.on("error", error => appLog("ERROR", "lifecycle", "update.failed", {}, { error: { message: error.message } }));
      for (const event of ["update-available", "update-not-available", "update-downloaded"]) updater.on(event, () => appLog("INFO", "lifecycle", `update.${event}`));
    },
    spawn(child) {
      appLog("INFO", "lifecycle", "agent.spawn", { pid: child.pid });
      child.once("exit", (code, signal) => appLog(code === 0 ? "INFO" : "ERROR", "lifecycle", "agent.exit", { code, signal }));
      child.once("error", error => appLog("ERROR", "lifecycle", "agent.spawn_failed", { code: error.code }));
      return child;
    },
  };
}

function validateRenderer(row) {
  if (!row || typeof row !== "object" || !LEVELS.has(row.level) || !CATEGORIES.has(row.category) || !EVENTS.has(row.event)) return false;
  if (Object.keys(row).some(key => !["level", "category", "event", "traceparent", "chat_id", "turn_id", "attrs"].includes(key))) return false;
  if (row.traceparent !== undefined && (typeof row.traceparent !== "string" || !TRACE.test(row.traceparent))) return false;
  for (const key of ["chat_id", "turn_id"]) if (row[key] !== undefined && (typeof row[key] !== "string" || row[key].length > 128)) return false;
  if (row.attrs !== undefined && (!row.attrs || Array.isArray(row.attrs) || typeof row.attrs !== "object")) return false;
  if (Object.entries(row.attrs ?? {}).some(([key, value]) => key.length > 128 || !["string", "number", "boolean"].includes(typeof value))) return false;
  if (row.category === "http.client" ? row.event !== "image.fetch" || row.level !== "DEBUG"
    : row.event === "image.fetch" || (row.event === "ui.error" ? row.level !== "ERROR" : row.level !== "INFO")) return false;
  try { return Buffer.byteLength(JSON.stringify(row)) <= 16 * 1024; } catch { return false; }
}
