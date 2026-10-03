#!/usr/bin/env node
// Run outside the sandbox against a built executable; never the installed owner app.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";

const executable = process.argv[2];
if (!executable) throw new Error("Usage: node measure-startup.mjs /path/to/built/Butler.app/Contents/MacOS/Butler");
const root = mkdtempSync(join(tmpdir(), "butler-startup-timings-"));
for (const directory of ["home", "data", "profile"]) mkdirSync(join(root, directory));

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function measure(label) {
  const port = await freePort();
  const requested = Date.now();
  const child = spawn(resolve(executable), [], { stdio: ["ignore", "pipe", "pipe"], env: {
    ...process.env, HOME: join(root, "home"), BUTLER_DATA: join(root, "data"),
    BUTLER_APP_ELECTRON_USER_DATA_DIR: join(root, "profile"),
    BUTLER_APP_SERVER_DB: join(root, "data/app-server/butler-client.sqlite"),
    BUTLER_APP_SERVER_PORT: String(port), BUTLER_APP_SERVER_URL: `http://127.0.0.1:${port}`,
    BUTLER_APP_DISABLE_SHELL_REGISTRATION: "1",
  } });
  const events = [];
  let lineBuffer = "";
  let stopping = false;
  let hardStop;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    child.kill("SIGTERM");
    hardStop = setTimeout(() => child.kill("SIGKILL"), 15_000);
  };
  // Existing startup budget plus graceful shutdown; only this child is signalled.
  const deadline = setTimeout(stop, 150_000);
  const onInterrupt = () => stop();
  process.once("SIGINT", onInterrupt);
  child.stderr.resume(); // Do not print raw logs: they can contain private paths.
  child.stdout.on("data", (chunk) => {
    lineBuffer += chunk.toString();
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop();
    for (const line of lines) {
      try {
        const event = JSON.parse(line).startup;
        if (!event) continue;
        events.push(event);
        if (["window_ready", "failed"].includes(event.stage)) stop();
      } catch { /* Ignore non-timing stdout. */ }
    }
  });
  try { await once(child, "exit"); }
  finally { clearTimeout(deadline); clearTimeout(hardStop); process.removeListener("SIGINT", onInterrupt); }
  console.log(`\n${label}: fresh process${label === "cold-profile" ? ", fresh profile" : ", reused profile"}`);
  console.table(events.map((event) => ({ event: event.stage, process_ms: event.elapsed_ms,
    launch_request_ms: event.timestamp_ms === null ? null : Number((event.timestamp_ms - requested).toFixed(3)), timestamp_ms: event.timestamp_ms })));
  if (!events.some((event) => event.stage === "window_ready")) throw new Error(`${label}: main window did not become ready`);
  const ready = events.find((event) => event.stage === "app_ready");
  if (ready?.elapsed_ms > 1000) console.log("Electron pre-ready exceeds 1 s: evaluate the native pre-splash proposal in STARTUP.md.");
}

try {
  await measure("cold-profile");
  await measure("warm-profile");
  console.log("Direct executable launch. OS disk-cache coldness and Gatekeeper/Finder verification are NOT measured or bypassed.");
} finally { rmSync(root, { recursive: true, force: true }); }
