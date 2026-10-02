import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { classifyAppForegroundActiveWork } from "../../client/electron/app-foreground-quit.mjs";
import { electronPage, type ElectronPage } from "../../../../tests/support/electron-page-cdp.ts";
import { smokeProviderReply } from "./smoke-provider.ts";

if (process.platform !== "win32") throw new Error("Packaged smoke requires Windows");
if (!process.env.BUTLER_SMOKE_PROFILE_ROOT) throw new Error("Run through deploy/windows-portable-smoke.ps1");
const packageRoot = resolve(process.argv[2]);
const root = mkdtempSync(join(tmpdir(), "Butler portable 전경 smoke-"));
const data = join(root, "data");
const pidFile = join(root, "app.pid");
const exitFile = join(root, "app.exit");
const owned = new Set<number>();
const priorProtocol = protocolRegistration();
const answer = "Windows Electron ready.";
const calls = { chat: 0, memory: 0 };
const stub = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  if (new URL(request.url).pathname !== "/v1/responses") return new Response(null, { status: 404 });
  const body = await request.json();
  return smokeProviderReply(body, "Reply with Windows Electron ready.", answer, calls);
} });
const debugPort = await freePort();
const serverPort = await freePort();
prepareData();
// Execute the reviewed launcher as a command, without changing host execution policy.
const launcher = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
  "$launch = ConvertFrom-Json $env:BUTLER_SMOKE_LAUNCH_INPUT; " +
  "& ([scriptblock]::Create([IO.File]::ReadAllText($env:BUTLER_SMOKE_LAUNCH_SCRIPT))) " +
  "-Electron $launch.Electron -AppRoot $launch.AppRoot -Profile $launch.Profile " +
  "-PidFile $launch.PidFile -ExitFile $launch.ExitFile -DebugPort $launch.DebugPort",
], { stdio: "ignore", env: {
  ...process.env, PSModuleAnalysisCachePath: join(root, "powershell-module-cache"),
  BUTLER_SMOKE_LAUNCH_SCRIPT: resolve("packages/butler-app/scripts/windows/launch-electron-smoke.ps1"),
  BUTLER_SMOKE_LAUNCH_INPUT: JSON.stringify({ Electron: join(packageRoot, "Butler.exe"), AppRoot: packageRoot,
    Profile: join(root, "profile"), PidFile: pidFile, ExitFile: exitFile, DebugPort: debugPort }),
  HOME: join(root, "home"), USERPROFILE: join(root, "home"),
  LOCALAPPDATA: join(root, "local"), APPDATA: join(root, "roaming"), BUTLER_DATA: data,
  BUTLER_APP_SERVER_PORT: String(serverPort), BUTLER_SECRET_STORE: "file",
  BUTLER_E2E_TIER: "stub", BUTLER_APP_DISABLE_SHELL_REGISTRATION: "1",
  OPENAI_API_KEY: "e2e-not-real", OPENAI_BASE_URL: `http://127.0.0.1:${stub.port}/v1`,
  BUTLER_PROVIDER_QUOTA_POLLING: "0", BUTLER_APP_ALLOW_PRECONFIRMED_E2E_QUIT: "1",
} });
let cdp: ElectronPage | null = null;
try {
  await waitFor(() => existsSync(pidFile), "Electron launch PID");
  const appPid = Number(readFileSync(pidFile, "utf8").trim());
  assert(Number.isInteger(appPid) && appPid > 0, "Invalid Electron launch PID");
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
    messages[1].role === "assistant" && messages[1].text === answer && calls.chat === 1,
    `Stub chat content/order/count mismatch: ${JSON.stringify({ calls, messages: messages.map((message: any) => ({
      role: message.role, text: message.text,
    })) })}`);
  await waitFor(() => calls.memory === 1, "one successful meaning extraction");
  cdp = await electronPage(debugPort);
  assert(await cdp.expression("typeof window.butlerApp?.quitApp === 'function'"), "Sandbox preload missing");
  await cdp.reload();
  assert((await api("/health")).data.ok === true, "Reloaded portable Agent is unhealthy");
  const navigation = (await api("/navigation")).data;
  const workerActivity = (await api("/worker-activity")).data;
  const queues = await Promise.all(navigation.chats.map(async (chat: { id: string }) =>
    (await api(`/session-queue?session_id=${encodeURIComponent(chat.id)}`)).data));
  const activeWork = classifyAppForegroundActiveWork({ navigation, workerActivity, queues });
  assert(activeWork.classification === "no_active_work", `Delivered chat still classified as active work: ${activeWork.classification} / ${activeWork.reasons.join(",")}`);
  for (const pid of processTree(appPid)) owned.add(pid);
  await cdp.expression("setTimeout(() => window.butlerApp.quitApp({confirmed:true}), 50); true");
  await waitFor(() => existsSync(exitFile), "App quit");
  assert(Number(readFileSync(exitFile, "utf8")) === 0, "App quit failed");
  await waitFor(() => [...owned].every((pid) => !alive(pid)), "owned process tree cleanup");
  assert(await portAvailable(serverPort), "Agent port remains open");
  assert(readJson("app/runtime/foreground/last-exit.json")?.graceful === true &&
    readJson("app/runtime/foreground/instance.json")?.clean_exit === true, "Unclean foreground shutdown");
  assert(protocolRegistration() === priorProtocol, "Portable App changed the protocol registration");
  console.log(JSON.stringify({ ok: true, windowCreated: true, agentChild: true, authenticatedHealth: 200,
    reloadVerified: true, deliveredWorkSettled: true, stubTurns: 1, providerCalls: calls.chat + calls.memory,
    chatCalls: calls.chat, memoryCalls: calls.memory, messages: messages.length, processesChecked: owned.size,
    quitExit: 0, leftoverProcesses: 0, portReleased: true, protocolUnchanged: true, rawTextIncluded: false }));
} catch (error) {
  console.error(error);
  console.error(JSON.stringify({
    windowReady: readJson("app/runtime/foreground/startup-progress.json")?.window_ready,
    instanceState: readJson("app/runtime/foreground/instance.json")?.state,
    launcherExitCode: launcher.exitCode,
    appExitCode: existsSync(exitFile) ? readFileSync(exitFile, "utf8").trim() : null,
  }));
  throw error;
} finally {
  cdp?.close();
  if (existsSync(pidFile)) {
    const appPid = Number(readFileSync(pidFile, "utf8").trim());
    if (Number.isInteger(appPid) && appPid > 0) {
      owned.add(appPid);
      if (alive(appPid)) for (const pid of processTree(appPid)) owned.add(pid);
    }
  }
  const instance = readJson("app/runtime/foreground/instance.json");
  if (instance?.agent_host_pid) owned.add(instance.agent_host_pid);
  if (launcher.pid) {
    owned.add(launcher.pid);
    if (alive(launcher.pid)) for (const pid of processTree(launcher.pid)) owned.add(pid);
  }
  for (const pid of owned) if (alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} }
  stub.stop(true);
  await waitFor(() => [...owned].every((pid) => !alive(pid)), "forced smoke process cleanup");
  // The PowerShell owner removes the isolated profile after Bun exits, releasing
  // all process-held Windows file handles before deleting the directory.
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
function protocolRegistration(): string {
  const script = `$key = Get-Item 'Registry::HKEY_CURRENT_USER\\Software\\Classes\\butler' -ErrorAction SilentlyContinue
if (!$key) { 'absent'; exit 0 }
@($key) + @(Get-ChildItem $key.PSPath -Recurse) | Sort-Object Name | ForEach-Object {
  $item = $_
  [ordered]@{ key = $item.Name; values = @($item.GetValueNames() | Sort-Object | ForEach-Object {
    [ordered]@{ name = $_; kind = [string]$item.GetValueKind($_); value = $item.GetValue($_) }
  }) }
} | ConvertTo-Json -Depth 6 -Compress`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
  assert(result.status === 0, "Could not inspect protocol registration");
  return result.stdout.trim();
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
