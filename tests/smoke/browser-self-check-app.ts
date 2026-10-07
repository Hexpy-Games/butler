/** P1b acceptance through the real App-owned native Agent, using only a local stub. */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { freeGatewayPort, freePort, startStubModel, writeOnboardingComplete, type StubModelRequest } from "../support/native-app-server";
import { electronPage, type ElectronPage } from "../support/electron-page-cdp";
import { electronMain } from "../support/electron-main-cdp";
import { smokeElectronArgs } from "../support/smoke-browser";
import { IdleWriteAttribution } from "../support/idle-write-attribution";

const root = process.cwd();
const evidence = process.env.BUTLER_BROWSER_EVIDENCE;
const executable = process.env.BUTLER_SMOKE_ELECTRON_EXECUTABLE;
const agent = process.env.BUTLER_NATIVE_AGENT_EXECUTABLE;
assert.ok(evidence && executable && agent, "Explicit evidence, Electron and branch Agent paths required");
mkdirSync(evidence, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), "output-app-"));
const home = join(dir, "home"), data = join(dir, "data"), installation = join(dir, "install");
const profile = join(dir, "profile");
for (const path of [home, data, join(installation, "bin")]) mkdirSync(path, { recursive: true });
cpSync(agent, join(installation, "bin/butler-agent"), { mode: 2 });
cpSync(join(root, "packages/butler-agent/resources"), join(installation, "resources"), { recursive: true });
cpSync(join(root, "packages/butler-app/client/ui/dist"), join(installation, "resources/app-client/dist"), { recursive: true });
const port = await freeGatewayPort(), inspector = await freePort();
const base = `http://127.0.0.1:${port}`;
const electronModule = `process.getBuiltinModule('module').createRequire(${JSON.stringify(join(root, "packages/butler-app/client/electron/package.json"))})('electron')`;
const main = <T>(expression: string) => electronMain<T>(inspector, expression);
let child: ChildProcess | undefined;
let page: ElectronPage | undefined;
let sessionId = "";
const logs: string[] = [];
const measurements: Record<string, unknown> = {};
const broken = "<!doctype html><meta name='viewport' content='width=device-width,initial-scale=1'><title>Fixture</title><style>body{margin:0}#wide{width:1290px}</style><h1 id='wide'>Output</h1><script>console.error('fixture console error');throw new Error('fixture exception')</script>";
const slow = "<!doctype html><title>Quit fixture</title><h1>Slow</h1><script>const start=performance.now();while(performance.now()-start<6000){}</script>";

// Match each turn's public tool history; no live provider or private runtime hooks.
const calls: StubModelRequest[] = [];
const provider = await startStubModel(request => request.stream ? "Published." : "{}", calls, request => {
  if (!request.stream) return null;
  const messages = request.messages as Array<{ role: string; content?: string }>;
  const lastUser = messages.findLastIndex(message => message.role === "user");
  const prompt = String(messages[lastUser]?.content);
  const toolCount = messages.slice(lastUser + 1).filter(message => message.role === "tool").length;
  const content = prompt.includes("Quit") ? slow : prompt.includes("Fix") ? "<!doctype html><h1>Fixed</h1>" : broken;
  const tool = toolCount === 0 ? { name: "write_file", arguments: { path: "site/index.html", content, create_parents: true } } :
    toolCount === 1 ? { name: "output_publish", arguments: { path: "site", title: "Fixture" } } : null;
  return tool;
});
writeFileSync(join(data, "butler.config.json"), JSON.stringify({ user: { name: "Smoke", language: "en" },
  system: { defaultModel: "local/stub" }, models: { local: [{ model_id: "stub", display_name: "Stub",
    server_url: `http://127.0.0.1:${provider.port}`, context_window_tokens: 128000 }] }, metrics: { enabled: false } }));
writeOnboardingComplete(data);

async function waitUntil(read: () => Promise<boolean>, label: string, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await read()) return;
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error(`Timed out: ${label}`);
}
function auth(admin = false): Record<string, string> {
  const token = JSON.parse(readFileSync(join(data, "app/runtime/auth/local-agent-auth.json"), "utf8")).token;
  return { "content-type": "application/json", authorization: `Bearer ${token}`,
    ...(admin ? { "x-butler-admin": JSON.parse(readFileSync(join(data, "app/runtime/auth/local-admin.json"), "utf8")).secret } : {}) };
}
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(base + path, { method: body ? "POST" : "GET", headers: auth(), ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.ok(response.ok, `${path}: ${response.status}`);
  const value = await response.json();
  return value.data ?? value;
}
function publication(turn: string) {
  const db = new Database(join(data, "agent-runtime/btcc.sqlite"), { readonly: true });
  try {
    const row = db.query("SELECT result_json FROM btcc_guided_tool_calls WHERE tool_name='output_publish' AND turn_id=? ORDER BY rowid DESC LIMIT 1").get(turn) as { result_json: string } | null;
    return row ? JSON.parse(row.result_json) : null;
  } finally { db.close(); }
}
async function turns(): Promise<Array<{ id?: string; turn_id?: string; state: string }>> {
  const result = await api<{ turns: Array<{ id?: string; turn_id?: string; state: string }> }>(`/turns?chat_id=${sessionId}`);
  measurements.last_turns = result.turns;
  return result.turns;
}
const turnId = (turn: { id?: string; turn_id?: string }) => turn.turn_id ?? turn.id;
async function send(text: string): Promise<string> {
  const result = await api<{ turn_id?: string; turn?: { id?: string; turn_id?: string } }>("/messages", { chat_id: sessionId, text, client_message_id: crypto.randomUUID(), model: "local/stub", access_mode: "full_access" });
  const id = result.turn_id ?? result.turn?.turn_id ?? result.turn?.id;
  assert.ok(id, "accepted public message has a turn ID");
  return id;
}
async function delivered(id: string) {
  await waitUntil(async () => {
    const turn = (await turns()).find(turn => turnId(turn) === id);
    assert.ok(!turn || !["failed", "runtime_fault", "cancelled"].includes(turn.state), JSON.stringify(turn));
    return turn?.state === "delivered";
  }, `turn ${id} delivered`);
}
async function launch() {
  const debug = await freePort();
  child = spawn(executable!, [`--inspect=${inspector}`, `--remote-debugging-port=${debug}`, ...smokeElectronArgs(), join(root, "packages/butler-app/client/electron")], {
    stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOME: home, BUTLER_HOME: home, BUTLER_DATA: data,
      CODEX_HOME: join(home, ".codex"), BUTLER_NATIVE_AGENT_EXECUTABLE: join(installation, "bin/butler-agent"),
      BUTLER_APP_ELECTRON_USER_DATA_DIR: profile, BUTLER_APP_SERVER_URL: undefined, BUTLER_APP_UI_URL: undefined,
      BUTLER_APP_SERVER_PORT: String(port), BUTLER_APP_RENDERER_DIST: join(root, "packages/butler-app/client/ui/dist"),
      BUTLER_APP_DISABLE_SHELL_REGISTRATION: "1", BUTLER_APP_ALLOW_PRECONFIRMED_E2E_QUIT: "1",
      BUTLER_E2E_TIER: "stub", BUTLER_E2E_EMBED_SOURCES: "http://127.0.0.1:9", BUTLER_PROVIDER_QUOTA_POLLING: "0" } });
  for (const stream of [child.stdout, child.stderr]) stream!.on("data", bytes => logs.push(String(bytes)));
  child.on("exit", (code, signal) => logs.push(JSON.stringify({ event: "electron_exit", code, signal })));
  page = await electronPage(debug);
  await waitUntil(async () => (await page!.expression<{ ok: boolean }>("window.butlerApp.health()")).ok, "App-owned Agent ready");
  assert.equal(await main<string>("process.versions.electron"), "44.5.1");
  await main(`(() => {
    globalThis.outputWindows=[];
    globalThis.outputBaselineWindowIds=${electronModule}.BrowserWindow.getAllWindows().map(win=>win.id).sort((a,b)=>a-b);
    globalThis.outputMainWindowId=${electronModule}.BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().startsWith('app://butler/')).id;
    ${electronModule}.app.on('browser-window-created',(_event,win)=>win.webContents.once('did-finish-load',()=>{
      if(win.webContents.getURL().includes('/__o/'))outputWindows.push({visible:win.isVisible(),content:win.getContentBounds()});
    }));
  })()`);
  await main(`(() => {globalThis.quitSeen=false;${electronModule}.app.once('quit',()=>process.getBuiltinModule('node:fs').writeFileSync(${JSON.stringify(join(dir, "quit.json"))},JSON.stringify({windows:${electronModule}.BrowserWindow.getAllWindows().length})))})()`);
}
async function stopApp() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await waitUntil(async () => child!.exitCode !== null || child!.signalCode !== null, "owned Electron exit", 5000)
    .catch(() => { child!.kill("SIGKILL"); });
}
async function quitApp() {
  await page!.expression("window.butlerApp.quitApp({confirmed:true})");
  await waitUntil(async () => { try { return JSON.parse(readFileSync(join(dir, "quit.json"), "utf8")).windows === 0; } catch { return false; } }, "App quit event");
  page!.close(); page = undefined;
  await stopApp();
  rmSync(join(dir, "quit.json"));
}

async function checkPublished() {
  const remote = await fetch(base + "/internal/browser-host", { headers: { ...auth(true), "x-forwarded-for": "192.0.2.1" } });
  assert.equal(remote.status, 403);
  measurements.remote_host_status = remote.status;
  await main("(() => {globalThis.outputDelay=process.getBuiltinModule('node:perf_hooks').monitorEventLoopDelay({resolution:5});outputDelay.enable()})()");
  const startLoad = loadavg()[0];
  const turn = await send("Publish"); await delivered(turn);
  const result = publication(turn);
  assert.equal(result.check.status, "issues");
  assert.deepEqual(result.check.layout, { blank: false, overflow_px: { desktop: 10, mobile: 900 } });
  assert.ok(result.check.errors.shown.some((error: string) => error.includes("fixture console error")));
  const bytes = Buffer.byteLength(JSON.stringify(result.check)); assert.ok(bytes <= 2048);
  const publicationBytes = Buffer.byteLength(JSON.stringify(result)); assert.ok(publicationBytes <= 2048);
  measurements.published = { ...result.check, diagnostic_bytes: bytes, publication_bytes: publicationBytes, loadAverage1m: loadavg()[0] };
  for (const viewport of ["desktop", "mobile"]) {
    const response = await fetch(base + "/internal/browser/calls", { method: "POST", headers: auth(true),
      body: JSON.stringify({ output_id: result.output_id, session_id: sessionId, include_image: true, viewport }) });
    assert.equal(response.status, 200);
    const report = await response.json(); assert.equal(report.status, "issues");
    assert.deepEqual(report.layout.overflow_px, { desktop: 10, mobile: 900 });
    assert.ok(report.errors.shown.some((error: string) => error.includes("fixture console error")));
    const image = Buffer.from(report.image.data, "base64"); assert.ok(image.length <= 150 * 1024);
    writeFileSync(join(evidence!, `app-${viewport}.jpg`), image);
    measurements[viewport] = { ...report, image: { bytes: image.length }, loadAverage1m: loadavg()[0] };
  }
  const fixed = await send("Fix"); await delivered(fixed);
  assert.equal(publication(fixed).check.status, "ok");
  const p99 = await main<number>("(() => {outputDelay.disable();return outputDelay.percentile(99)/1e6})()");
  measurements.main_event_loop = { p99_ms: p99, budget_ms: 30, loadAverage1mStart: startLoad, loadAverage1m: loadavg()[0] };
  assert.ok(p99 <= 30, `main event-loop p99 ${p99}ms`);
  const inspectors = await main<Array<{ visible: boolean; content: { width: number; height: number } }>>("outputWindows");
  assert.equal(inspectors.length, 4); assert.ok(inspectors.every(window => !window.visible));
  assert.ok(inspectors.every(window => window.content.width === 1280 && window.content.height === 800));
  measurements.hidden_inspectors = inspectors;
  assert.equal(await main<boolean>(`JSON.stringify(${electronModule}.BrowserWindow.getAllWindows().map(win=>win.id).sort((a,b)=>a-b))===JSON.stringify(outputBaselineWindowIds)`), true, "all hidden inspectors destroyed; original App/lifecycle windows retained");
  console.log(JSON.stringify({ phase: "checks", ...measurements.main_event_loop as object, diagnostic_bytes: bytes }));
}

function snapshot(path: string): unknown[] {
  try { return readdirSync(path, { withFileTypes: true }).flatMap(entry => {
    const file = join(path, entry.name);
    return entry.isDirectory() ? snapshot(file) : [[file, statSync(file).size, statSync(file).mtimeMs]];
  }).sort(); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
type Io = { pid: number; process_start: string; write_bytes: number | null; status: string };
function processIo(pids: number[], before?: Io[]): Io[] {
  const executable = process.env.BUTLER_PROCESS_USAGE_EXECUTABLE;
  assert.ok(executable, "Explicit platform process-usage executable required");
  const result = spawnSync(executable, pids.map((pid, index) => before ? `${pid}@${before[index]!.process_start}` : String(pid)), { encoding: "utf8" });
  assert.equal(result.status, 0);
  const samples = JSON.parse(result.stdout) as Io[];
  assert.deepEqual(samples.map(sample => sample.pid), pids);
  assert.ok(samples.every(sample => sample.write_bytes !== null && sample.status === "available"));
  return samples;
}
async function idle() {
  // Finish the event-driven publication projections before starting idle.
  await new Promise(done => setTimeout(done, 3000));
  const outputs = join(data, "outputs");
  const partitions = join(profile, "Partitions");
  const before = [snapshot(outputs), snapshot(partitions)];
  assert.ok(before[0]!.length, "published output files must exist");
  const events: unknown[] = [];
  const appPids = await main<number[]>(`[...new Set([process.pid,...${electronModule}.app.getAppMetrics().map(metric=>metric.pid)])]`);
  const instance = JSON.parse(readFileSync(join(data, "app/runtime/foreground/instance.json"), "utf8"));
  measurements.menu_bar_helper_pid = null;
  try {
    const helperPid = Number(readFileSync(join(data, "app/runtime/menu-bar-helper.pid"), "utf8").trim());
    assert.ok(Number.isSafeInteger(helperPid) && helperPid > 0);
    appPids.push(helperPid);
    measurements.menu_bar_helper_pid = helperPid;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const pids = [...new Set([...appPids, instance.agent_host_pid as number])];
  const ioBefore = processIo(pids), ioSamples = [ioBefore];
  const loads = [loadavg()[0]], started = Date.now();
  measurements.idle_processes = await main(`({pid:process.pid,isPackaged:${electronModule}.app.isPackaged,metrics:${electronModule}.app.getAppMetrics(),paths:{userData:${electronModule}.app.getPath('userData'),sessionData:${electronModule}.app.getPath('sessionData')}})`);
  const attribution = new IdleWriteAttribution({ data, profile, home }, join(dir, "idle-copies"), evidence!);
  attribution.sample(0, ioBefore, loads[0]!);
  const watcher = watch(outputs, { recursive: true }, (event, file) => events.push({ event, file }));
  try {
    for (let sample = 0; sample < 20; sample++) {
      await new Promise(done => setTimeout(done, Math.max(0, started + (sample + 1) * 30_000 - Date.now()))); loads.push(loadavg()[0]);
      ioSamples.push(processIo(pids, ioBefore));
      attribution.sample(sample + 1, ioSamples.at(-1), loads.at(-1)!);
      console.log(`P1b App idle ${(sample + 1) / 2}/10 min; load1m=${loads.at(-1)}`);
    }
    const deltas = ioSamples.at(-1)!.map((sample, index) => ({ pid: sample.pid, write_bytes: sample.write_bytes! - ioBefore[index]!.write_bytes! }));
    measurements.idle = { elapsed_ms: Date.now() - started, writes: events.length, output_files: before[0]!.length, loadAverage1m: loads, process_io: { deltas, samples: ioSamples } };
    assert.deepEqual([snapshot(outputs), snapshot(partitions)], before);
    assert.deepEqual(events, [], "zero output-owned write notifications");
    assert.ok(deltas.every(sample => sample.write_bytes === 0), JSON.stringify(deltas));
    attribution.assertUnchanged();
  } finally { watcher.close(); }
}
async function recovery() {
  const active = await send("Quit");
  await waitUntil(async () => await main<boolean>(`${electronModule}.BrowserWindow.getAllWindows().some(w=>w.webContents.getURL().includes('/__o/')&&!w.isVisible())`), "active hidden check");
  for (const text of ["Fix follow-up one", "Fix follow-up two"]) await api("/session-queue", { chat_id: sessionId, text, model: "local/stub", access_mode: "full_access", client_message_id: crypto.randomUUID() });
  const queueBefore = await api<{ queued_messages: Array<{ state: string }> }>(`/session-queue?session_id=${sessionId}`);
  const activeBeforeQuit = (await turns()).find(turn => turnId(turn) === active);
  measurements.before_quit = { active: activeBeforeQuit, queue: queueBefore };
  assert.ok(activeBeforeQuit && !["delivered", "failed", "cancelled", "runtime_fault"].includes(activeBeforeQuit.state));
  assert.equal(queueBefore.queued_messages.filter(message => message.state === "queued").length, 2);
  await quitApp();
  const exit = JSON.parse(readFileSync(join(data, "app/runtime/foreground/last-exit.json"), "utf8"));
  assert.equal(exit.graceful, true);
  await launch();
  await waitUntil(async () => (await turns()).filter(turn => turn.state === "delivered" && turnId(turn) !== active).length >= 4, "both queued follow-ups recovered");
  const queue = await api<{ paused: boolean; queued_messages: Array<{ state: string; turn_id: string; safe_error_code?: string }> }>(`/session-queue?session_id=${sessionId}`);
  assert.equal(queue.paused, false); assert.ok(queue.queued_messages.every(message => message.state !== "queued"));
  const interrupted = queue.queued_messages.find(message => message.turn_id === active);
  if (!(await turns()).some(turn => turnId(turn) === active && turn.state === "delivered")) {
    assert.equal(interrupted?.safe_error_code, "turn_interrupted");
    await api(`/turns/${active}/retry`, {}); await delivered(active);
  }
  measurements.recovery = { queued_followups: 2, active_delivered: true, active_error_before_retry: interrupted?.safe_error_code ?? null, graceful: exit.graceful };
}

try {
  await launch();
  const created = await page!.expression<{ session: { id: string } }>("window.butlerApp.createSession({kind:'chat',title:'P1b acceptance'})");
  sessionId = created.session.id;
  await checkPublished();
  let idleFailure: Error | undefined;
  try { await idle(); }
  catch (error) {
    idleFailure = error instanceof Error ? error : new Error(String(error));
    measurements.idle_failure = idleFailure.message;
  }
  await recovery();
  await quitApp();
  // Same native Agent without an App host: publication still succeeds truthfully.
  child = spawn(join(installation, "bin/butler-agent"), ["--installation-root", installation, "--resource-root", join(installation, "resources")], {
    stdio: ["pipe", "ignore", "pipe"], env: { ...process.env, HOME: home, BUTLER_DATA: data, CODEX_HOME: join(home, ".codex"),
      BUTLER_APP_SERVER_URL: undefined, BUTLER_APP_SERVER_PORT: String(port), BUTLER_APP_FOREGROUND_LEASE: "1", BUTLER_E2E_TIER: "stub",
      BUTLER_E2E_EMBED_SOURCES: "http://127.0.0.1:9", BUTLER_PROVIDER_QUOTA_POLLING: "0" } });
  await waitUntil(async () => { try { return (await api<{ btcc_executor_ready: boolean }>("/runtime-readiness")).btcc_executor_ready; } catch { return false; } }, "headless Agent ready");
  const absent = await send("Fix no App"); await delivered(absent);
  assert.deepEqual(publication(absent).check, { status: "unavailable", reason: "no_browser" });
  measurements.no_app = publication(absent).check;
  if (idleFailure) throw idleFailure;
  writeFileSync(join(evidence, "app-acceptance.json"), JSON.stringify(measurements, null, 2));
  console.log("P1b real App acceptance passed");
} finally {
  page?.close(); await stopApp(); await new Promise<void>(done => provider.server.close(() => done()));
  const safe = logs.join("").replace(/(__o\/)[^/\s]+/gu, "$1[redacted]").replace(/Bearer\s+\S+/gu, "Bearer [redacted]");
  writeFileSync(join(evidence, "app.log"), safe);
  writeFileSync(join(evidence, "app-measurements.json"), JSON.stringify(measurements, null, 2));
  writeFileSync(join(evidence, "stub-calls.json"), JSON.stringify(calls.map(call => ({ stream: call.stream, roles: (call.messages as Array<{ role: string }>).map(message => message.role) })), null, 2));
  rmSync(dir, { recursive: true, force: true });
}
