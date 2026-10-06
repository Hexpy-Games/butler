#!/usr/bin/env node
// Direct launches in disposable profiles. No installed owner app or shell registration.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";

const args = process.argv.slice(2);
const valueOptions = ["--runs", "--json", "--electron-root"];
const executable = args.find((arg, index) => !arg.startsWith("--") && !valueOptions.includes(args[index - 1]));
if (!executable) throw new Error("Usage: measure-startup.mjs <built executable> [--runs 5] [--json file] [--electron-root directory]");
const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const runs = Number(option("--runs", "5"));
if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");
const root = mkdtempSync(join(tmpdir(), "butler-startup-timings-"));
const samples = [];
async function freePort() {
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = server.address().port;
  await new Promise((done) => server.close(done)); return port;
}
function profile(label) {
  const directory = join(root, label);
  for (const name of ["home", "data", "profile", "appdata", "local", "temp"]) mkdirSync(join(directory, name), { recursive: true });
  return { HOME: join(directory, "home"), USERPROFILE: join(directory, "home"),
    APPDATA: join(directory, "appdata"), LOCALAPPDATA: join(directory, "local"), TEMP: join(directory, "temp"), TMP: join(directory, "temp"),
    BUTLER_DATA: join(directory, "data"), BUTLER_APP_ELECTRON_USER_DATA_DIR: join(directory, "profile"),
    BUTLER_APP_SERVER_DB: join(directory, "data/app-server/butler-client.sqlite") };
}
function launchArgs(extra = []) {
  const entry = option("--electron-root");
  return [...(process.env.BUTLER_SMOKE_BROWSER_ARGS ? JSON.parse(process.env.BUTLER_SMOKE_BROWSER_ARGS) : []),
    ...(entry ? [resolve(entry)] : basename(executable).toLowerCase() === "update.exe" ? ["--processStart", "Butler.exe"] : []), ...extra];
}
async function measure(mode, run, env) {
  const port = await freePort();
  const requested = Date.now();
  const environment = { ...process.env, ...env, BUTLER_APP_SERVER_PORT: String(port),
    BUTLER_APP_DISABLE_SHELL_REGISTRATION: "1",
    BUTLER_SECRET_STORE: "file", BUTLER_PLATFORM_SYSTEM_SECRETS: "0" };
  // An explicit URL selects external-server mode and prevents the App-owned
  // Agent from starting. Measure the native foreground lifecycle instead.
  delete environment.BUTLER_APP_SERVER_URL;
  const child = spawn(resolve(executable), launchArgs(), { shell: false, stdio: ["ignore", "pipe", "pipe"], env: environment });
  const events = [];
  const profiles = [];
  const traces = [];
  let stopping = false;
  let forcedStop = false;
  let hardStop;
  let signal;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    signal = spawn(resolve(executable), launchArgs(["--butler-quit-main-ui"]), { shell: false, stdio: "ignore", env: environment });
    signal.on("error", () => {});
    hardStop = setTimeout(() => {
      forcedStop = true;
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", shell: false });
        killer.on("error", () => {});
      } else child.kill("SIGKILL");
    }, 15_000);
  };
  const deadline = setTimeout(stop, 150_000);
  process.once("SIGINT", stop);
  // Electron hosts can emit main-process console timing lines on either pipe.
  for (const stream of [child.stdout, child.stderr]) {
    let pending = "";
    stream.on("data", (chunk) => {
      const lines = (pending + chunk.toString()).split("\n"); pending = lines.pop();
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.lifecycleProfile) profiles.push(parsed.lifecycleProfile);
          if (parsed.lifecycleTrace) traces.push(parsed.lifecycleTrace);
          const event = parsed.startup;
          if (event) { events.push(event); if (["window_ready", "failed"].includes(event.stage)) stop(); }
        } catch { /* No general app logs in timing evidence. */ }
      }
    });
  }
  try { await once(child, "exit"); }
  finally { clearTimeout(deadline); clearTimeout(hardStop); process.removeListener("SIGINT", stop); }
  if (signal && signal.exitCode === null && signal.signalCode === null) await once(signal, "exit");
  const elapsed = (name) => events.find((event) => event.stage === name)?.elapsed_ms;
  if (!events.some((event) => event.stage === "window_ready")) console.log(JSON.stringify({ failure: "window_not_ready", mode, run, exitCode: child.exitCode, events }));
  if (!events.some((event) => event.stage === "window_ready")) throw new Error(`${mode}/${run}: main window did not become ready`);
  if (forcedStop) {
    const output = option("--json");
    if (output) writeFileSync(resolve(output), JSON.stringify({ runs, samples, failure: { mode, run, forcedStop, events, profiles } }, null, 2));
    throw new Error(`${mode}/${run}: forced_stop`);
  }
  if (process.env.BUTLER_LIFECYCLE_PROFILE === "1") {
    const card = profiles.find((profile) => profile.kind === "startup")?.card;
    if (!card?.title || !card.line || !card.fontReady || !card.markReady || card.images !== 0) throw new Error(`${mode}/${run}: incomplete first card frame`);
  }
  const metrics = Object.fromEntries(events.filter((event) => event.elapsed_ms !== null).map((event) => [event.stage, event.elapsed_ms]));
  metrics.splash_after_ready = elapsed("splash_painted") - elapsed("app_ready");
  if (!Number.isFinite(metrics.splash_after_ready)) throw new Error(`${mode}/${run}: missing splash_painted or app_ready timing`);
  for (const stage of ["prepare", "service", "screen", "upgrade", "data"]) {
    const start = elapsed(`stage_${stage}_start`), end = elapsed(`stage_${stage}_end`);
    if (start !== undefined && end !== undefined) metrics[`interval_${stage}`] = end - start;
  }
  samples.push({ mode, run, launchKind: basename(executable).toLowerCase() === "update.exe" ? "squirrel-update" : /app-[^/\\]+[/\\]/.test(executable) ? "squirrel-direct" : "direct-or-stub", forcedStop, metrics, profiles, traces,
    events: events.map((event) => ({ ...event, launch_request_ms: event.timestamp_ms - requested })) });
  console.log(JSON.stringify({ mode, run, splash_after_ready: metrics.splash_after_ready }));
}
function report() {
  const rows = [];
  for (const mode of ["cold", "warm"]) {
    const selected = samples.filter((sample) => sample.mode === mode);
    const names = new Set(selected.flatMap((sample) => Object.keys(sample.metrics)));
    for (const event of names) {
      const values = selected.map((sample) => sample.metrics[event]).filter(Number.isFinite).sort((a, b) => a - b);
      const median = values.length % 2 ? values[Math.floor(values.length / 2)] : (values[values.length / 2 - 1] + values[values.length / 2]) / 2;
      rows.push({ mode, event, samples: values.length, median_ms: Number(median.toFixed(3)), p95_ms: Number(values[Math.ceil(values.length * 0.95) - 1].toFixed(3)) });
    }
  }
  console.table(rows);
  const output = option("--json");
  if (output) writeFileSync(resolve(output), JSON.stringify({ runs, samples, summary: rows }, null, 2));
  if (rows.some((row) => row.event === "splash_after_ready" && row.p95_ms > 300)) throw new Error("splash_painted − app_ready exceeds 300 ms");
  if (rows.some((row) => row.event === "app_ready" && row.median_ms > 1000)) console.log("Electron pre-ready p50 exceeds 1 s; evaluate native pre-splash.");
}
try {
  for (let run = 1; run <= runs; run++) await measure("cold", run, profile(`cold-${run}`));
  const warm = profile(`cold-${runs}`);
  for (let run = 1; run <= runs; run++) await measure("warm", run, warm);
  report();
  console.log("Direct launch; Gatekeeper/Finder and cold OS disk cache are not measured.");
} finally { rmSync(root, { recursive: true, force: true }); }
