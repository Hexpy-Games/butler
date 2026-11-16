/** Disposable hosted-runner proof of Electron -> gpui Squirrel activation. */
import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, closeSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { freePort } from "../../../../tests/support/native-app-server.ts";
import { windowsPowerShellEnvironment } from "../../client/electron/windows-powershell-environment.mjs";
import { windowsPackageVersion } from "../../client/electron/scripts/windows-package-version.mjs";
import { assertIdle, assertRegistrations, measureIdleProcesses, readPostUpdateRegistration, rerunUpdatedHook, staleRegistrations } from "./gpui-update-checks.ts";
import { assertShortcuts, powershell, preserveInstallerLogs, readJson, removeProfile, shortcutPaths, waitFor } from "./installer-smoke-support.ts";
if (process.platform !== "win32" || process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_ENVIRONMENT !== "github-hosted") {
  throw new Error("Registry/shortcut/installer smoke is restricted to disposable GitHub-hosted runners");
}
assert.ok(process.argv[2] && process.argv[3], "Expected Electron installer directory and gpui release directory");
const release = resolve(process.argv[2]);
const candidate = resolve(process.argv[3]);
const from = process.env.BUTLER_WINDOWS_SMOKE_FROM!;
const to = process.env.BUTLER_WINDOWS_SMOKE_TO!;
assert.ok(from && to, "BUTLER_WINDOWS_SMOKE_FROM and BUTLER_WINDOWS_SMOKE_TO are required");
const fromPackage = windowsPackageVersion(from);
const toPackage = windowsPackageVersion(to);
const artifact = readJson(join(candidate, "app-update-manifest.json"))?.artifacts
  ?.find((item: any) => item.platform === "windows-x64");
assert.equal(artifact?.version, to, "Candidate manifest must describe the exact update version");
const port = await freePort();
const root = realpathSync.native(mkdtempSync(join(tmpdir(), "butler-gpui-update-")));
const data = join(root, "data");
const env = { ...windowsPowerShellEnvironment(), HOME: join(root, "home"), USERPROFILE: join(root, "home"), BUTLER_DATA: data,
  LOCALAPPDATA: join(root, "home/AppData/Local"), APPDATA: join(root, "home/AppData/Roaming"),
  TEMP: join(root, "tmp"), TMP: join(root, "tmp"), SQUIRREL_TEMP: join(root, "home/AppData/Local"),
  BUTLER_E2E_TIER: "stub", BUTLER_SECRET_STORE: "file", BUTLER_APP_SERVER_PORT: String(port),
  BUTLER_APP_ELECTRON_USER_DATA_DIR: join(root, "profile"), BUTLER_APP_UPDATE_MANIFEST: join(root, "manifest.json"),
  ELECTRON_ENABLE_LOGGING: "1", ELECTRON_LOG_FILE: join(root, "electron.log"),
};
const installed = join(env.LOCALAPPDATA, "butler-app");
const stub = join(installed, "Butler.exe");
const updater = join(installed, "Update.exe");
const oldApp = join(installed, `app-${fromPackage}`, "Butler.exe");
const newFolder = join(installed, `app-${toPackage}`);
const instanceFile = join(data, "app/runtime/foreground/instance.json");
const serviceFile = join(data, "state/butler-agent-native-service.json");
const durations: Record<string, number> = {};
let shortcuts: string[] = [];
let oldAppPid = 0;
let oldAgentPid = 0;
let uninstalled = false;
let failed = false;
let helperClosed = true;
let phase = "prepare";
let processTrace: ReturnType<typeof startProcessTrace> | undefined;
try {
  processTrace = startProcessTrace();
  await processTrace.ready();
  const local = powershell("[Environment]::GetFolderPath('LocalApplicationData', [Environment+SpecialFolderOption]::DoNotVerify)", env);
  assert.equal(resolve(local).toLowerCase(), resolve(env.LOCALAPPDATA).toLowerCase(), "Squirrel profile must be isolated");
  for (const path of [env.HOME, data, env.LOCALAPPDATA, env.APPDATA, env.TEMP]) mkdirSync(path, { recursive: true });
  writeFileSync(env.BUTLER_APP_UPDATE_MANIFEST, JSON.stringify({ app_version: from, artifacts: [] }));
  shortcuts = [join(env.APPDATA, "Microsoft/Windows/Start Menu/Programs/Butler.lnk"), shortcutPaths(env)[1]!];
  mkdirSync(dirname(shortcuts[1]!), { recursive: true });
  await step("install", async () => {
    run(join(release, `ButlerSetup-${from}-x64.exe`), ["--silent"]);
    await waitFor(() => existsSync(stub) && existsSync(updater), "Squirrel install");
    await waitFor(() => shortcuts.every(path => existsSync(path)), "both shortcuts");
    assertShortcuts(shortcuts, true);
  });
  await step("electron", startElectron);
  await step("update", activateUpdate);
  await step("gpui", proveGpui);
  await step("uninstall", uninstall);
} catch (error) {
  failed = true;
  printLogs();
  throw error;
} finally {
  await cleanup();
}
console.log(JSON.stringify({ ok: true, from, to, ...durations }));

async function cleanup() {
  const errors: unknown[] = [];
  for (const action of [
    stopInstalled,
    async () => { if (!uninstalled && existsSync(updater)) runUninstall(); },
  ]) {
    try { await action(); } catch (error) { errors.push(error); }
  }
  try {
    await waitFor(() => helperClosed, "update helper streams closed");
  } catch (error) { errors.push(error); }
  try { await processTrace?.stop(); } catch (error) { errors.push(error); }
  try { printProcessStarts(); } catch (error) { errors.push(error); }
  try { preserveLogs(); } finally { removeProfile(root, env); }
  for (const error of errors) console.error(`Smoke cleanup failed: ${String(error)}`);
  if (errors.length && !failed) throw errors[0];
}

function startProcessTrace() {
  const stopFile = join(root, "process-starts.stop");
  const readyFile = join(root, "process-starts.ready");
  const script = join(root, "process-starts.ps1");
  writeFileSync(join(root, "process-starts.jsonl"), "");
  writeFileSync(script, `$ErrorActionPreference = 'Stop'
    function Write-ProcessStart($notification) {
      $started = $notification.SourceEventArgs.NewEvent
      $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($started.ProcessID)" -ErrorAction Ignore
      [ordered]@{
        event = 'start'; time = [DateTime]::FromFileTimeUtc([long]$started.TIME_CREATED).ToString('o')
        ProcessName = $started.ProcessName; ProcessID = $started.ProcessID; ParentProcessID = $started.ParentProcessID
        ExecutablePath = $process.ExecutablePath; CommandLine = $process.CommandLine
      } | ConvertTo-Json -Compress | Add-Content -LiteralPath $env:BUTLER_PROCESS_TRACE_LOG -Encoding UTF8
      Remove-Event -EventIdentifier $notification.EventIdentifier
    }
    function Write-ProcessStop($notification) {
      $stopped = $notification.SourceEventArgs.NewEvent
      [ordered]@{
        event = 'stop'; time = [DateTime]::FromFileTimeUtc([long]$stopped.TIME_CREATED).ToString('o')
        ProcessName = $stopped.ProcessName; ProcessID = $stopped.ProcessID; ParentProcessID = $stopped.ParentProcessID
        ExitStatus = $stopped.ExitStatus
      } | ConvertTo-Json -Compress | Add-Content -LiteralPath $env:BUTLER_PROCESS_TRACE_LOG -Encoding UTF8
      Remove-Event -EventIdentifier $notification.EventIdentifier
    }
    Register-CimIndicationEvent -ClassName Win32_ProcessStartTrace -SourceIdentifier ButlerProcessStarts | Out-Null
    Register-CimIndicationEvent -ClassName Win32_ProcessStopTrace -SourceIdentifier ButlerProcessStops | Out-Null
    try {
      New-Item -ItemType File -Path $env:BUTLER_PROCESS_TRACE_READY | Out-Null
      while (-not (Test-Path -LiteralPath $env:BUTLER_PROCESS_TRACE_STOP)) {
        $notification = Wait-Event -Timeout 1
        if ($null -ne $notification) {
          if ($notification.SourceIdentifier -eq 'ButlerProcessStarts') { Write-ProcessStart $notification }
          else { Write-ProcessStop $notification }
        }
      }
    } finally {
      Unregister-Event -SourceIdentifier ButlerProcessStarts
      Unregister-Event -SourceIdentifier ButlerProcessStops
      Get-Event -SourceIdentifier ButlerProcessStarts -ErrorAction SilentlyContinue | ForEach-Object { Write-ProcessStart $_ }
      Get-Event -SourceIdentifier ButlerProcessStops -ErrorAction SilentlyContinue | ForEach-Object { Write-ProcessStop $_ }
    }`);
  const output = openSync(join(root, "process-start-subscriber.log"), "a");
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", script], {
      env: { ...env, BUTLER_PROCESS_TRACE_STOP: stopFile, BUTLER_PROCESS_TRACE_READY: readyFile,
        BUTLER_PROCESS_TRACE_LOG: join(root, "process-starts.jsonl") },
      stdio: ["ignore", output, output], windowsHide: true,
    });
  } finally { closeSync(output); }
  let closed = false;
  let exit: number | null = null;
  let spawnError: Error | undefined;
  child.on("error", error => { spawnError = error; closed = true; });
  child.on("close", code => { exit = code; closed = true; });
  return {
    ready: () => waitFor(() => {
      if (closed) throw spawnError ?? new Error(`Process-start subscriber exited before readiness: ${exit}`);
      return existsSync(readyFile);
    }, "process-start subscriber ready"),
    stop: async () => {
      writeFileSync(stopFile, "stop");
      try { await waitFor(() => closed, "process-start subscriber exit"); } finally {
        if (!closed && child.pid) {
          run("taskkill.exe", ["/PID", String(child.pid), "/F"]);
          await waitFor(() => closed, "terminated process-start subscriber streams closed");
        }
      }
      if (spawnError) throw spawnError;
      assert.equal(exit, 0, "Process-start subscriber must succeed");
    },
  };
}

type ProcessStart = {
  event: "start"; time: string; ProcessName: string; ProcessID: number; ParentProcessID: number;
  ExecutablePath: string | null; CommandLine: string | null;
};
type ProcessStop = { event: "stop"; time: string; ProcessName: string; ProcessID: number; ParentProcessID: number; ExitStatus: number };
type ProcessMark = { event: "mark"; name: string; time: string };
function markProcessTrace(name: string) {
  appendFileSync(join(root, "process-starts.jsonl"), `${JSON.stringify({ event: "mark", name, time: new Date().toISOString() })}\n`);
}
function printProcessStarts() {
  const trace = join(root, "process-starts.jsonl");
  const events: (ProcessStart | ProcessStop | ProcessMark)[] = existsSync(trace) ? readFileSync(trace, "utf8").replace(/^\uFEFF/u, "")
    .split(/\r?\n/u).filter(line => line.trim()).map(line => JSON.parse(line)) : [];
  const starts = events.filter((row): row is ProcessStart => row.event === "start");
  const stops = events.filter((row): row is ProcessStop => row.event === "stop");
  starts.sort((a, b) => a.time.localeCompare(b.time));
  stops.sort((a, b) => a.time.localeCompare(b.time));
  const byPid = new Map<number, ProcessStart[]>();
  for (const start of starts) {
    const history = byPid.get(start.ProcessID) ?? [];
    history.push(start);
    byPid.set(start.ProcessID, history);
  }
  const names = new Set(["butler_cef_host.exe", "butler.exe", "butler-agent.exe", "update.exe"]);
  const processStarts = starts.filter(start => names.has(start.ProcessName.toLowerCase())
    || [start.ExecutablePath, start.CommandLine].some(value => value?.toLowerCase().includes(installed.toLowerCase())))
    .map(start => {
      // PIDs can be reused: take the most recent parent start preceding this child.
      const parent = byPid.get(start.ParentProcessID)?.findLast(row => row.time <= start.time);
      return { ...start, parent: parent ? { ProcessName: parent.ProcessName, ExecutablePath: parent.ExecutablePath } : null };
    });
  console.log(JSON.stringify({ processStarts }));
  const processLifetimes = processStarts.filter(start => [start.ExecutablePath, start.CommandLine]
    .some(value => value?.toLowerCase().includes(installed.toLowerCase()))).map(start => {
    const next = byPid.get(start.ProcessID)?.find(row => row.time > start.time);
    const stop = stops.find(row => row.ProcessID === start.ProcessID && row.time >= start.time
      && (!next || row.time < next.time));
    return { ...start, stopTime: stop?.time ?? null, ExitStatus: stop?.ExitStatus ?? null };
  });
  console.log(JSON.stringify({ processLifetimes, marks: events.filter(row => row.event === "mark") }));
}

async function step(name: string, action: () => Promise<void>) {
  phase = name;
  const started = Date.now();
  try { await action(); } finally {
    durations[`${name}Ms`] = Date.now() - started;
    console.log(JSON.stringify({ step: name, durationMs: durations[`${name}Ms`] }));
  }
}

async function startElectron() {
  const log = openSync(join(root, "app-stdio.log"), "a");
  try {
    const child = spawn(stub, [], { env, detached: true, stdio: ["ignore", log, log] });
    child.on("error", error => writeFileSync(join(root, "launch-error.log"), String(error)));
    child.unref();
  } finally { closeSync(log); }
  await waitFor(() => {
    const instance = readJson(instanceFile);
    return instance?.state === "ready" && Number.isInteger(instance.app_pid) && readJson(serviceFile)?.state === "ready";
  }, "Electron App and Agent ready", 120_000);
  oldAppPid = readJson(instanceFile)!.app_pid;
  oldAgentPid = readJson(serviceFile)!.pid;
  writeFileSync(join(data, "sentinel.txt"), "retained");
}

async function activateUpdate() {
  const name = `butler-app-${toPackage}-full.nupkg`;
  const folder = join(data, "updates/artifacts");
  mkdirSync(folder, { recursive: true });
  const packagePath = join(folder, name);
  copyFileSync(join(candidate, name), packagePath);
  staleRegistrations(shortcuts, env, powershell); // Only the gpui updated hook can restore these.
  const helperLog = openSync(join(root, "helper-stderr.log"), "a");
  helperClosed = false;
  const helper = spawn(join(dirname(oldApp), "resources/bundled-agent/bin/butler-agent.exe"),
    ["--installation-root", dirname(oldApp), "--resource-root", join(dirname(oldApp), "resources/bundled-agent/resources"),
      "app-update-install", packagePath, oldApp, String(oldAppPid)], { env, stdio: ["pipe", "pipe", helperLog] });
  closeSync(helperLog);
  let output = "";
  let ended = false;
  let exit: number | null = null;
  let spawnError: Error | undefined;
  helper.on("error", error => { spawnError = error; ended = true; });
  helper.on("close", code => { exit = code; ended = true; helperClosed = true; });
  helper.stdout!.on("data", chunk => {
    output += chunk.toString();
    writeFileSync(join(root, "helper-stdout.log"), output);
  });
  helper.stdin!.on("error", error => { spawnError = error; });
  await waitFor(() => {
    if (ended) throw spawnError ?? new Error(`Update helper exited before readiness: ${exit}`);
    return output.split(/\r?\n/u).includes("app-update-ready");
  }, "update helper ready", 120_000);
  helper.stdin!.end("activate\n");
  run("taskkill.exe", ["/PID", String(oldAppPid), "/T", "/F"]);
  await waitFor(() => ended, "Squirrel update helper exit", 120_000);
  if (spawnError) throw spawnError;
  assert.equal(exit, 0, "Update helper must succeed");
}

type InstalledProcess = { pid: number; name: string; path: string; parentPid: number; modules: string[] };
function installedProcesses(): InstalledProcess[] {
  return JSON.parse(powershell(`$root = [IO.Path]::GetFullPath($env:BUTLER_SMOKE_INSTALL).TrimEnd('\\') + '\\'
    ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process |
      ForEach-Object {
        $process = $_
        $modules = @()
        try {
          $modules = @((Get-Process -Id $process.ProcessId -ErrorAction Stop).Modules |
            ForEach-Object { $_.FileName } |
            Where-Object { $_ -and $_.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) })
        } catch { $modules = @() }
        if (($process.ExecutablePath -and $process.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) -or $modules.Count -gt 0) {
          @{ pid = $process.ProcessId; name = $process.Name; path = [string]$process.ExecutablePath;
            parentPid = $process.ParentProcessId; modules = $modules }
        }
      })`, { ...env, BUTLER_SMOKE_INSTALL: installed }));
}
async function proveGpui() {
  assert.ok(existsSync(join(newFolder, "butler_cef_host.exe")), "Updated CEF host missing");
  const appPath = join(newFolder, "Butler.exe").toLowerCase();
  const agentPath = join(newFolder, "resources/bundled-agent/bin/butler-agent.exe").toLowerCase();
  await waitFor(async () => {
    const instance = readJson(serviceFile);
    if (instance?.state !== "ready" || instance.app_supervised !== true || instance.pid === oldAgentPid) return false;
    const rows = installedProcesses();
    if (!rows.some(row => row.path.toLowerCase() === appPath)) return false;
    if (!rows.some(row => row.pid === instance.pid && row.path.toLowerCase() === agentPath)) return false;
    const token = readJson(join(data, "app/runtime/auth/local-agent-auth.json"))?.token;
    if (!token || !instance.app_endpoint) return false;
    const response = await fetch(new URL("/health", instance.app_endpoint), {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000),
    }).catch(() => null);
    return response?.ok === true && (await response.json()).data.ok === true;
  }, "updated gpui App and authenticated supervised Agent", 120_000);
  assert.equal(readFileSync(join(data, "sentinel.txt"), "utf8"), "retained");
  assert.ok(existsSync(join(data, "butler.config.json")), "User configuration missing");
  const idle = await measureIdleProcesses(newFolder, env, powershell); console.log(JSON.stringify(idle)); assertIdle(idle);
  const squirrelRegistration = readPostUpdateRegistration(shortcuts, env, powershell);
  console.log(JSON.stringify({ squirrelUpdatedRegistration: squirrelRegistration })); assertRegistrations(squirrelRegistration, stub, installed, "Squirrel-run updated hook");
  staleRegistrations(shortcuts, env, powershell);
  const { hook, updatedHook } = rerunUpdatedHook(newFolder, toPackage, env);
  console.log(JSON.stringify({ updatedHook }));
  assert.equal(hook.status, 0, `Updated hook exitCode must be 0: ${hook.error?.message ?? hook.status}`);
  const postUpdateRegistration = readPostUpdateRegistration(shortcuts, env, powershell);
  console.log(JSON.stringify({ postUpdateRegistration })); assertRegistrations(postUpdateRegistration, stub, installed, "Rerun updated hook");
}
async function stopInstalled() {
  markProcessTrace("stopInstalled:begin");
  try {
    const processes = installedProcesses();
    for (const { pid } of processes) {
      // A parent tree kill may already have ended another collected child.
      if (!installedProcesses().some(row => row.pid === pid)) continue;
      const killed = spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { env, encoding: "utf8" });
      if (killed.status !== 0) assert.ok(!installedProcesses().some(row => row.pid === pid), `Failed to stop owned PID ${pid}`);
    }
    await waitFor(() => installedProcesses().length === 0, "installed processes stopped");
  } finally { markProcessTrace("stopInstalled:end"); }
}
async function startUninstallSampler() {
  const handle = process.env.BUTLER_SMOKE_HANDLE_EXE;
  if (!handle) return null;
  assert.ok(existsSync(handle), "Handle executable missing");
  const stopFile = join(root, "uninstall-handle.stop");
  const readyFile = join(root, "uninstall-handle.ready");
  const log = join(root, "uninstall-handles.log");
  const script = join(root, "uninstall-handles.ps1");
  writeFileSync(script, `$ErrorActionPreference = 'Stop'
    while (-not (Test-Path -LiteralPath $env:BUTLER_HANDLE_STOP)) {
      $seenAt = [DateTime]::UtcNow.ToString('o')
      $lines = @(& $env:BUTLER_SMOKE_HANDLE_EXE -accepteula -nobanner $env:BUTLER_HANDLE_FOLDER 2>&1 | ForEach-Object { "$_" })
      @{ seenAt = $seenAt; lines = $lines } | ConvertTo-Json -Compress | Add-Content -LiteralPath $env:BUTLER_HANDLE_LOG -Encoding UTF8
      if (-not (Test-Path -LiteralPath $env:BUTLER_HANDLE_READY)) {
        New-Item -ItemType File -Path $env:BUTLER_HANDLE_READY | Out-Null
      }
      if (-not (Test-Path -LiteralPath $env:BUTLER_HANDLE_STOP)) { Start-Sleep -Milliseconds 100 }
    }`);
  const output = openSync(join(root, "uninstall-handle-sampler.log"), "a");
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", script], {
      env: { ...env, BUTLER_SMOKE_HANDLE_EXE: handle, BUTLER_HANDLE_FOLDER: newFolder,
        BUTLER_HANDLE_STOP: stopFile, BUTLER_HANDLE_READY: readyFile, BUTLER_HANDLE_LOG: log },
      stdio: ["ignore", output, output], windowsHide: true,
    });
  } finally { closeSync(output); }
  let closed = false;
  let exit: number | null = null;
  let spawnError: Error | undefined;
  child.on("error", error => { spawnError = error; closed = true; });
  child.on("close", code => { exit = code; closed = true; });
  const stop = () => writeFileSync(stopFile, "stop");
  const finish = async () => {
    try { await waitFor(() => closed, "uninstall Handle sampler exit"); } finally {
      if (!closed && child.pid) run("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"]);
    }
    if (spawnError) throw spawnError;
    assert.equal(exit, 0, "Handle sampler must succeed");
  };
  try {
    await waitFor(() => {
      if (closed) throw spawnError ?? new Error(`Handle sampler exited before readiness: ${exit}`);
      return existsSync(readyFile);
    }, "uninstall Handle sampler ready");
  } catch (error) {
    stop();
    try { await finish(); } finally { printUninstallHolders(log); }
    throw error;
  }
  return { stop, report: async () => { try { await finish(); } finally { printUninstallHolders(log); } } };
}

type UninstallHolder = {
  processName: string; pid: number; handlePath: string; firstSeen: string; lastSeen: string;
  process?: { ExecutablePath: string | null; CommandLine: string | null; ParentProcessId: number } | null;
};
function printUninstallHolders(log: string) {
  const holders = new Map<string, UninstallHolder>();
  try {
    const samples = existsSync(log) ? readFileSync(log, "utf8").replace(/^\uFEFF/u, "").trim().split(/\r?\n/u).filter(Boolean) : [];
    for (const sample of samples) {
      const { seenAt, lines } = JSON.parse(sample) as { seenAt: string; lines: string[] };
      for (const line of lines) {
        const match = /^(.*?)\s+pid:\s*(\d+)\s+type:\s+File\s+[\da-f]+:\s+(.+)$/iu.exec(line.trim());
        if (!match || !/(?:v8_context_snapshot\.bin|vk_swiftshader\.dll)$/iu.test(match[3])) continue;
        const [, processName, pid, handlePath] = match;
        const key = JSON.stringify([processName, Number(pid), handlePath]);
        const previous = holders.get(key);
        if (previous) previous.lastSeen = seenAt;
        else holders.set(key, { processName, pid: Number(pid), handlePath, firstSeen: seenAt, lastSeen: seenAt });
      }
    }
    const processes = new Map<number, UninstallHolder["process"]>();
    for (const holder of holders.values()) {
      if (!processes.has(holder.pid)) {
        processes.set(holder.pid, JSON.parse(powershell(`$process = Get-CimInstance Win32_Process -Filter "ProcessId = $env:BUTLER_HANDLE_PID"
          if ($process) { $process | Select-Object ExecutablePath, CommandLine, ParentProcessId | ConvertTo-Json -Compress }
          else { 'null' }`, { ...env, BUTLER_HANDLE_PID: String(holder.pid) })));
      }
      holder.process = processes.get(holder.pid);
    }
  } finally { console.log(JSON.stringify({ uninstallHolders: [...holders.values()] })); }
}

async function uninstall() {
  await stopInstalled();
  const sampler = await startUninstallSampler();
  try {
    try { runUninstall(); } finally { sampler?.stop(); }
    const uninstallReturnedAt = Date.now();
    await waitFor(() => !existsSync(stub), "uninstalled stub removed");
    assertShortcuts(shortcuts, false);
    for (const key of ["HKCU:\\Software\\Classes\\butler", "HKCU:\\Software\\Classes\\AppUserModelId\\com.squirrel.butler-app.Butler"]) {
      assert.equal(powershell("Test-Path -LiteralPath $env:BUTLER_SMOKE_KEY", { ...env, BUTLER_SMOKE_KEY: key }), "False", key);
    }
    assert.equal(powershell("[bool](Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -ErrorAction SilentlyContinue).'com.squirrel.butler-app.Butler'", env), "False");
    const files = existsSync(installed) ? readdirSync(installed, { recursive: true, withFileTypes: true })
      .filter(entry => !entry.isDirectory()).map(entry => relative(installed, join(entry.parentPath, entry.name)).toLowerCase()) : [];
    // Squirrel's FullUninstall recreates the root with .dead and leaves the running Update.exe and app-version squirrel.exe.
    const expected = [".dead", "Update.exe", join(`app-${toPackage}`, "squirrel.exe")].map(path => path.toLowerCase());
    const unexpected = files.filter(path => !expected.includes(path));
    const missing = expected.filter(path => !files.includes(path));
    if (unexpected.length || missing.length) {
      const sinceUninstallReturnedMs = Date.now() - uninstallReturnedAt;
      const remnants = unexpected.map(path => {
        const fullPath = join(installed, path);
        let size: number | null = null;
        let lastWriteTime: string | null = null;
        let statError: string | null = null;
        try {
          const stat = statSync(fullPath);
          size = stat.size;
          lastWriteTime = stat.mtime.toISOString();
        } catch (error) { statError = (error as NodeJS.ErrnoException).code ?? String(error); }
        let removal: string = "success";
        try { rmSync(fullPath); } catch (error) { removal = (error as NodeJS.ErrnoException).code ?? String(error); }
        return { path, size, lastWriteTime, statError, removal };
      });
      let defender = null;
      try {
        defender = JSON.parse(powershell(`Get-MpComputerStatus -ErrorAction Stop |
          Select-Object AMServiceEnabled, RealTimeProtectionEnabled, OnAccessProtectionEnabled |
          ConvertTo-Json -Compress`, env));
      } catch { /* Defender status is unavailable on this host. */ }
      console.error(JSON.stringify({ remnants, sinceUninstallReturnedMs, defender }));
      console.error("Uninstall process/module holders:", JSON.stringify(installedProcesses(), null, 2));
    }
    assert.deepEqual(files.sort(), expected.sort(), `Uninstall remnants: unexpected [${unexpected.join(", ")}]; missing [${missing.join(", ")}]`);
    assert.equal(readFileSync(join(data, "sentinel.txt"), "utf8"), "retained");
    uninstalled = true;
  } finally { await sampler?.report(); }
}

function runUninstall() {
  markProcessTrace("uninstall:begin");
  try { run(updater, ["--uninstall", "--silent"]); } finally { markProcessTrace("uninstall:end"); }
}

function run(command: string, args: string[]) {
  const child = spawnSync(command, args, { env, encoding: "utf8", timeout: 120_000 });
  if (child.stdout) writeFileSync(join(root, `${phase}-stdout.log`), child.stdout);
  if (child.stderr) writeFileSync(join(root, `${phase}-stderr.log`), child.stderr);
  assert.equal(child.status, 0, `${command}: ${child.error?.message ?? child.status}`);
}

function printLogs() {
  for (const path of [...readdirSync(root).filter(name => name.endsWith(".log")).map(name => join(root, name)), join(data, "updates/app-install.log")]) {
    if (existsSync(path)) console.error(`${path}:\n${readFileSync(path, "utf8")}`);
  }
}

function preserveLogs() {
  preserveInstallerLogs(root, installed, env, phase, "gpui");
  const evidence = process.env.BUTLER_WINDOWS_INSTALLER_EVIDENCE;
  if (!evidence) return;
  mkdirSync(evidence, { recursive: true });
  for (const name of readdirSync(root).filter(name => name.endsWith(".log"))) copyFileSync(join(root, name), join(evidence, name));
  const trace = join(root, "process-starts.jsonl");
  if (existsSync(trace)) copyFileSync(trace, join(evidence, "process-starts.jsonl"));
  for (const path of ["state/browser", "logs"]) {
    if (existsSync(join(data, path))) cpSync(join(data, path), join(evidence, "data", path), { recursive: true });
  }
}
