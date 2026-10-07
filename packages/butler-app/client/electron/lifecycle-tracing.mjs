import { writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
/** Opt-in Chromium renderer trace; normal launches do no tracing work. */
export async function traceLifecycleWindow(window) {
  if (process.env.BUTLER_LIFECYCLE_TRACE !== "1") return () => {};
  const debuggerSession = window.webContents.debugger;
  debuggerSession.attach("1.3");
  const events = [];
  let complete;
  const finished = new Promise((done) => { complete = done; });
  debuggerSession.on("message", (_event, method, params) => {
    if (method === "Tracing.dataCollected") events.push(...params.value);
    if (method === "Tracing.tracingComplete") complete();
  });
  await debuggerSession.sendCommand("Tracing.start", { categories: "devtools.timeline,blink.user_timing,v8,startup", transferMode: "ReportEvents" });
  return async () => {
    await debuggerSession.sendCommand("Tracing.end");
    await finished;
    debuggerSession.detach();
    const frame = events.find((event) => event.name === "first_frame")?.ts;
    const copy = events.find((event) => event.name === "copy_ready")?.ts;
    const before = events.filter((event) => frame && event.ts <= frame);
    const breakdown = Object.fromEntries(["ParseHTML", "UpdateLayoutTree", "EvaluateScript", "Paint", "Layout"].map((name) => [name, before.filter((event) => event.name === name).reduce((total, event) => total + (event.dur ?? 0) / 1000, 0)]));
    const result = { breakdown, localizedPaintBeforeNotification: !!copy && before.some((event) => event.name === "Paint" && event.ts >= copy) };
    const directory = resolve(process.env.BUTLER_LIFECYCLE_TRACE_DIRECTORY ?? ".tmp/startup-evidence");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `native-${process.platform}-${process.pid}.json`), JSON.stringify({ traceEvents: events }));
    console.info(JSON.stringify({ lifecycleTrace: result }));
  };
}
