import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { electronPage, type ElectronPage } from "../../../../tests/support/electron-page-cdp.ts";

if (process.platform !== "win32") throw new Error("Packaged smoke requires Windows");
const packageRoot = resolve(process.argv[2]);
const root = mkdtempSync(join(tmpdir(), "Butler portable 전경 smoke-"));
const data = join(root, "data");
const pidFile = join(root, "app.pid");
const exitFile = join(root, "app.exit");
const owned = new Set<number>();
const answer = "Windows Electron ready.";
let calls = 0;
const stub = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  if (new URL(request.url).pathname !== "/v1/responses") return new Response(null, { status: 404 });
  const body = await request.json();
  assert(JSON.stringify(body).includes("Reply with Windows Electron ready."), "Unexpected stub prompt");
  calls++;
  return Response.json({ id: "resp_windows", object: "response", status: "completed", model: "gpt-6-luna",
    output: [{ type: "message", id: "msg_windows", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: answer, annotations: [] }] }],
    usage: { input_tokens: 100, output_tokens: 4, total_tokens: 104 } });
} });
const debugPort = await freePort();
const serverPort = await freePort();
prepareData();
const launcher = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-File",
  resolve("packages/butler-app/scripts/windows/launch-electron-smoke.ps1"),
  "-Electron", join(packageRoot, "Butler.exe"), "-AppRoot", packageRoot,
  "-Profile", join(root, "profile"), "-PidFile", pidFile, "-ExitFile", exitFile,
  "-DebugPort", String(debugPort),
], { stdio: "ignore", env: {
  ...process.env, HOME: join(root, "home"), USERPROFILE: join(root, "home"),
  LOCALAPPDATA: join(root, "local"), APPDATA: join(root, "roaming"), BUTLER_DATA: data,
  BUTLER_APP_SERVER_PORT: String(serverPort), BUTLER_SECRET_STORE: "file",
  OPENAI_API_KEY: "e2e-not-real", OPENAI_BASE_URL: `http://127.0.0.1:${stub.port}/v1`,
  BUTLER_PROVIDER_QUOTA_POLLING: "0", BUTLER_APP_ALLOW_PRECONFIRMED_E2E_QUIT: "1",
} });
let cdp: ElectronPage | null = null;
try {
  await waitFor(() => existsSync(pidFile), "Electron launch PID");
  const appPid = Number(readFileSync(pidFile, "utf8").trim());
  owned.add(appPid);
  await waitFor(() => readJson("app/runtime/foreground/startup-progress.json")?.window_ready === true, "window created");
  const instance = readJson("app/runtime/foreground/instance.json");
  const agentPid = instance?.agent_host_pid;
  assert(Number.isInteger(agentPid) && alive(agentPid), "Agent child is not running");
  owned.add(agentPid);
  assert(instance?.app_pid === appPid && instance?.containment_kind === "direct_child", "Foreground ownership mismatch");
  const processes = processTree(appPid);
  for (const pid of processes) owned.add(pid);
  const parent = spawnSync("powershell.exe", ["-NoProfile", "-Command",
    `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${agentPid}').ParentProcessId`], { encoding: "utf8" });
  assert(parent.status === 0 && Number(parent.stdout.trim()) === appPid, "Agent is not the App child");
  const auth = readJson("app/runtime/auth/local-agent-auth.json");
  assert(typeof auth?.token === "string", "Local authentication missing");
  const api = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${serverPort}${path}`, {
      method, headers: { Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert(response.ok, `API ${path} returned ${response.status}`);
    return await response.json();
  };
  const health = await api("/health");
  assert(health.protocol_version === "butler.app.v1" && health.data.ok === true, "Health response mismatch");
  const unauthorized = await fetch(`http://127.0.0.1:${serverPort}/sessions`);
  assert(unauthorized.status === 401, "Unauthenticated access allowed");
  await api("/settings", "PATCH", { model: "openai/gpt-6-luna", reasoning_effort: "low", access_mode: "ask_first" });
  const prompt = "Reply with Windows Electron ready.";
  await api("/messages", "POST", { chat_id: "general", text: prompt, client_message_id: crypto.randomUUID() });
  await waitFor(async () => {
    const reply = await api("/turns?chat_id=general");
    return reply.data.turns.some((turn: { state: string }) => turn.state === "delivered");
  }, "stub turn delivery", 60_000);
  const messages = (await api("/messages?chat_id=general")).data.messages;
  assert(messages.length === 2 && messages[0].role === "user" && messages[0].text === prompt &&
    messages[1].role === "assistant" && messages[1].text === answer && calls === 1, "Stub chat content/order/count mismatch");
  cdp = await electronPage(debugPort);
  assert(await cdp.expression("typeof window.butlerApp?.quitApp === 'function'"), "Sandbox preload missing");
  for (const pid of processTree(appPid)) owned.add(pid);
  await cdp.expression("setTimeout(() => window.butlerApp.quitApp({confirmed:true}), 50); true");
  await waitFor(() => existsSync(exitFile), "App quit");
  assert(Number(readFileSync(exitFile, "utf8")) === 0, "App quit failed");
  await waitFor(() => [...owned].every((pid) => !alive(pid)), "owned process tree cleanup");
  assert(await portAvailable(serverPort), "Agent port remains open");
  assert(readJson("app/runtime/foreground/last-exit.json")?.graceful === true &&
    readJson("app/runtime/foreground/instance.json")?.clean_exit === true, "Unclean foreground shutdown");
  console.log(JSON.stringify({ ok: true, windowCreated: true, agentChild: true, authenticatedHealth: 200,
    stubTurns: 1, providerCalls: calls, messages: messages.length, processesChecked: owned.size,
    quitExit: 0, leftoverProcesses: 0, portReleased: true, rawTextIncluded: false }));
} finally {
  cdp?.close();
  if (existsSync(pidFile)) {
    const appPid = Number(readFileSync(pidFile, "utf8").trim());
    owned.add(appPid);
    if (alive(appPid)) for (const pid of processTree(appPid)) owned.add(pid);
  }
  const instance = readJson("app/runtime/foreground/instance.json");
  if (instance?.agent_host_pid) owned.add(instance.agent_host_pid);
  for (const pid of owned) if (alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} }
  launcher.kill();
  stub.stop(true);
  rmSync(root, { recursive: true, force: true });
}

function prepareData() {
  for (const directory of ["home", "local", "roaming", "data/personalization", "data/state/scheduler"]) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  writeFileSync(join(data, "butler.config.json"), JSON.stringify({ user: { name: "E2E", language: "en" },
    system: { defaultModel: "openai/gpt-6-luna" }, metrics: { enabled: false } }));
  const now = new Date().toISOString();
  writeFileSync(join(data, "personalization/onboarding.json"), JSON.stringify({ schema: "butler.first_chat_onboarding.v1",
    status: "complete", gateway: "any", fields: {}, skipped_fields: [], created_at: now, updated_at: now, completed_at: now }));
  for (const id of ["session-sync", "consolidation-cycle"]) {
    writeFileSync(join(data, `state/scheduler/${id}.json`), JSON.stringify({ lastRunDate: now.slice(0, 10), lastRunAt: now, status: "ok" }));
  }
}
function readJson(path: string): Record<string, any> | null {
  try { return JSON.parse(readFileSync(join(data, path), "utf8")); } catch { return null; }
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function waitFor(check: () => boolean | Promise<boolean>, label: string, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(100);
  }
  throw new Error(`Timed out: ${label}`);
}
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object", "Port allocation failed");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
async function portAvailable(port: number): Promise<boolean> {
  const server = createServer();
  return await new Promise((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}
function processTree(pid: number): number[] {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command",
    "$all = @(Get-CimInstance Win32_Process); $ids = @(" + pid + "); do { $next = @($all | Where-Object { $_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids } | ForEach-Object { $_.ProcessId }); $ids += $next } while ($next.Count); ConvertTo-Json -Compress -InputObject @($ids)"], { encoding: "utf8" });
  assert(result.status === 0, "Process tree query failed");
  return JSON.parse(result.stdout);
}
