import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronPage } from "../../../../tests/support/electron-page-cdp.ts";
import { windowsPowerShellEnvironment } from "../../client/electron/windows-powershell-environment.mjs";

export function powershell(script: string, env = process.env): string {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: windowsPowerShellEnvironment(env), encoding: "utf8", windowsHide: true,
  });
  assert.equal(result.status, 0, `PowerShell failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** Keep one CIM sampler ready before the action starts; flush each process identity once. */
export async function sampleInstallProcesses(installed: string, log: string, env: NodeJS.ProcessEnv, action: () => Promise<void>) {
  const output = openSync(log, "w");
  const sampler = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
    $ErrorActionPreference = 'Stop'
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $install = [IO.Path]::GetFullPath($env:BUTLER_SMOKE_INSTALL).TrimEnd('\\')
    $root = $install + '\\'
    $seen = @{}
    [Console]::Error.WriteLine('ready')
    while ($true) {
      Get-CimInstance Win32_Process | Where-Object {
        ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) -or
        ($_.CommandLine -and $_.CommandLine.IndexOf($install, [StringComparison]::OrdinalIgnoreCase) -ge 0)
      } | ForEach-Object {
        $key = '{0}:{1}' -f $_.ProcessId, $_.CreationDate.Ticks
        if (-not $seen.ContainsKey($key)) {
          $seen[$key] = $true
          [Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject @{
            pid = $_.ProcessId; parentPid = $_.ParentProcessId; path = $_.ExecutablePath
            commandLine = $_.CommandLine; created = $_.CreationDate.ToString('o')
          }))
          [Console]::Out.Flush()
        }
      }
      Start-Sleep -Milliseconds 250
    }`], { env: windowsPowerShellEnvironment({ ...env, BUTLER_SMOKE_INSTALL: installed }),
    windowsHide: true, stdio: ["ignore", output, "pipe"] });
  closeSync(output);
  let errors = "";
  let ended = false;
  let spawnError: Error | undefined;
  const closed = new Promise<void>(resolve => sampler.on("close", () => { ended = true; resolve(); }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Process sampler readiness timed out")), 120_000);
      sampler.on("error", error => { spawnError = error; reject(error); });
      sampler.on("close", code => reject(new Error(`Process sampler exited: ${code}; ${errors}`)));
      sampler.stderr!.on("data", chunk => {
        errors += chunk.toString();
        if (errors.split(/\r?\n/u).includes("ready")) resolve();
      });
    });
    clearTimeout(timer);
    await action();
    assert.ok(!ended && !spawnError, `Process sampler stopped during uninstall: ${spawnError ?? errors}`);
  } finally {
    clearTimeout(timer);
    if (!ended) sampler.kill();
    await closed;
  }
}

/** Query Restart Manager for processes holding any of the supplied files. */
export function fileHolders(paths: string[], env: NodeJS.ProcessEnv): { pid: number; name: string }[] {
  if (!paths.length) return [];
  // A file, not an environment variable: the install tree's path list exceeds the 32,767-character variable limit.
  const list = join(env.TEMP ?? tmpdir(), `butler-smoke-holders-${process.pid}.json`);
  writeFileSync(list, JSON.stringify(paths));
  return JSON.parse(powershell(`$ErrorActionPreference = 'Stop'
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class FileHolders {
  [StructLayout(LayoutKind.Sequential)]
  public struct UniqueProcess {
    public uint pid;
    public System.Runtime.InteropServices.ComTypes.FILETIME started;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct ProcessInfo {
    public UniqueProcess process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string name;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string service;
    public uint type, status, session;
    [MarshalAs(UnmanagedType.Bool)] public bool restartable;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  static extern uint RmStartSession(out uint session, uint flags, System.Text.StringBuilder key);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  static extern uint RmRegisterResources(uint session, uint count, string[] files,
    uint appCount, UniqueProcess[] apps, uint serviceCount, string[] services);
  [DllImport("rstrtmgr.dll")]
  static extern uint RmGetList(uint session, out uint needed, ref uint count,
    [In, Out] ProcessInfo[] processes, ref uint reasons);
  [DllImport("rstrtmgr.dll")]
  static extern uint RmEndSession(uint session);
  static void Check(uint result) {
    if (result != 0) throw new Win32Exception((int)result);
  }
  public static ProcessInfo[] Query(string[] files) {
    uint session;
    Check(RmStartSession(out session, 0, new System.Text.StringBuilder(33)));
    try {
      Check(RmRegisterResources(session, (uint)files.Length, files, 0, null, 0, null));
      uint needed, count = 0, reasons = 0;
      ProcessInfo[] processes = new ProcessInfo[0];
      while (true) {
        uint result = RmGetList(session, out needed, ref count, processes, ref reasons);
        if (result == 234) {
          processes = new ProcessInfo[needed];
          count = needed;
          continue;
        }
        Check(result);
        Array.Resize(ref processes, (int)count);
        return processes;
      }
    } finally { Check(RmEndSession(session)); }
  }
}
'@
    $files = [string[]](Get-Content -Raw -LiteralPath $env:BUTLER_SMOKE_FILES | ConvertFrom-Json)
    ConvertTo-Json -Compress -InputObject @([FileHolders]::Query($files) |
      ForEach-Object { @{ pid = $_.process.pid; name = $_.name } })`,
  { ...env, BUTLER_SMOKE_FILES: list }));
}

export function readJson(path: string): Record<string, any> | null {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

export async function waitFor(check: () => boolean | Promise<boolean>, label: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(100);
  }
  throw new Error(`Timed out: ${label}`);
}

export type OwnedProcesses = Map<number, { created?: number; notAfter: number }>;
export type ProcessSnapshot = {
  pid: number; parentPid: number; created: number;
  name: string | null; path: string | null; commandLine: string | null;
};

/** Resolve identities and descendants without mutating the input registry or snapshot. */
export function resolveOwnedProcesses(owned: ReadonlyMap<number, { created?: number; notAfter: number }>, rows: readonly ProcessSnapshot[]): OwnedProcesses {
  const live = new Map(rows.map(row => [row.pid, row]));
  const children = new Map<number, ProcessSnapshot[]>();
  for (const row of rows) {
    const siblings = children.get(row.parentPid) ?? [];
    siblings.push(row);
    children.set(row.parentPid, siblings);
  }
  const matched: OwnedProcesses = new Map();
  const queue: ProcessSnapshot[] = [];
  for (const [pid, identity] of owned) {
    const row = live.get(pid);
    if (!row || !(identity.created === undefined ? row.created <= identity.notAfter : row.created === identity.created)) continue;
    matched.set(pid, { ...identity, created: row.created });
    queue.push(row);
  }
  for (let i = 0; i < queue.length; i++) {
    const parent = queue[i];
    for (const child of children.get(parent.pid) ?? []) {
      if (matched.has(child.pid) || child.created < parent.created) continue;
      matched.set(child.pid, { created: child.created, notAfter: child.created });
      queue.push(child);
    }
  }
  return matched;
}

function processSnapshot(filter?: string): ProcessSnapshot[] {
  return JSON.parse(powershell(`ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process ${filter ? `-Filter '${filter}'` : ""} |
    ForEach-Object { @{ pid = $_.ProcessId; parentPid = $_.ParentProcessId;
      created = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds();
      name = $_.Name; path = $_.ExecutablePath; commandLine = $_.CommandLine } })`));
}

function applySnapshot(owned: OwnedProcesses, rows: ProcessSnapshot[]): ProcessSnapshot[] {
  const matched = resolveOwnedProcesses(owned, rows);
  owned.clear();
  for (const [pid, identity] of matched) owned.set(pid, identity);
  return rows.filter(row => matched.has(row.pid));
}

/**
 * A file's mtime bounds only the write that first named a PID; later rewrites naming the same PID
 * (e.g. a "stopped" state) must not move that bound past an exit and admit a reused PID.
 */
export function fileRootBounds(previous: ReadonlyMap<number, number> | undefined, pids: readonly unknown[], mtimeMs: number) {
  const bounds = new Map<number, number>();
  for (const pid of pids) {
    if (Number.isInteger(pid) && (pid as number) > 0) bounds.set(pid as number, previous?.get(pid as number) ?? mtimeMs);
  }
  return bounds;
}

const fileRoots = new WeakMap<OwnedProcesses, Map<string, Map<number, number>>>();

function recordFileRoots(path: string, owned: OwnedProcesses, pids: (value: string) => unknown[]) {
  const seen = fileRoots.get(owned) ?? new Map<string, Map<number, number>>();
  fileRoots.set(owned, seen);
  if (!existsSync(path)) { seen.delete(path); return; }
  const bounds = fileRootBounds(seen.get(path), pids(readFileSync(path, "utf8")), statSync(path).mtimeMs);
  seen.set(path, bounds);
  for (const [pid, notAfter] of bounds) if (!owned.has(pid)) owned.set(pid, { notAfter });
}

export function ownedProcesses(data: string, owned: OwnedProcesses) {
  recordFileRoots(join(data, "updates/app-install.pid"), owned, value => [Number(value)]);
  recordFileRoots(join(data, "app/runtime/foreground/instance.json"), owned, value => {
    try {
      const instance = JSON.parse(value);
      return [instance?.app_pid, instance?.agent_host_pid];
    } catch { return []; }
  });
  applySnapshot(owned, processSnapshot());
}

/** Avoid CIM entirely once all tracked PIDs stop responding; otherwise verify identity. */
export function ownedSurvivors(owned: OwnedProcesses): ProcessSnapshot[] {
  for (const pid of owned.keys()) if (!alive(pid)) owned.delete(pid);
  if (!owned.size) return [];
  const filter = [...owned.keys()].map(pid => `ProcessId = ${pid}`).join(" OR ");
  return applySnapshot(owned, processSnapshot(filter));
}

export function ownedDiagnostics(owned: OwnedProcesses) {
  return ownedSurvivors(owned).map(row => ({
    pid: row.pid, parentPid: row.parentPid, created: new Date(row.created).toISOString(),
    name: row.name, path: row.path,
    type: row.commandLine?.match(/(?:^|\s)--type=([a-zA-Z0-9_-]+)(?=\s|$)/u)?.[1] ?? null,
  }));
}

export async function waitForOwnedExit(owned: OwnedProcesses, label: string, discover?: () => void) {
  try {
    await waitFor(() => {
      discover?.();
      return ownedSurvivors(owned).length === 0;
    }, label);
  } catch (error) {
    console.error(JSON.stringify({ label, owned: ownedDiagnostics(owned) }));
    throw error;
  }
}

/** Processes started from one installed Squirrel version folder; `app` marks a top-level App (no Chromium child type). */
export function versionProcesses(folder: string, env: NodeJS.ProcessEnv): Array<{ pid: number; app: boolean }> {
  return JSON.parse(powershell(`$root = [IO.Path]::GetFullPath($env:BUTLER_VERSION_FOLDER).TrimEnd('\\') + '\\'
    $exe = Join-Path $root 'Butler.exe'
    ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process |
      Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) } |
      ForEach-Object { @{ pid = $_.ProcessId; app = ($_.ExecutablePath -ieq $exe) -and -not ($_.CommandLine -match '--type=|--butler-browser-host=') } })`,
  { ...env, BUTLER_VERSION_FOLDER: folder }));
}

export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function bridge(page: ElectronPage, method: string, input?: unknown): Promise<any> {
  return await page.expression(`window.butlerApp[${JSON.stringify(method)}](${input === undefined ? "" : JSON.stringify(input)})`);
}

export async function click(page: ElectronPage, name: string) {
  const button = `Array.from(document.querySelectorAll('button, [role="button"]')).find(e => (e.getAttribute('aria-label') || e.textContent).trim() === ${JSON.stringify(name)})`;
  await waitFor(async () => Boolean(await page.expression(`Boolean(${button})`)), name);
  await page.expression(`(${button}).click()`);
}

export function shortcutPaths(env = process.env): string[] {
  return JSON.parse(powershell(`ConvertTo-Json -Compress -InputObject @(
    (Join-Path ([Environment]::GetFolderPath('Programs', [Environment+SpecialFolderOption]::DoNotVerify)) 'Butler.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Desktop', [Environment+SpecialFolderOption]::DoNotVerify)) 'Butler.lnk'))`, env));
}

export function assertShortcuts(paths: string[], present: boolean) {
  for (const path of paths) assert.equal(existsSync(path), present, `Shortcut ${path}`);
}

/** Node removes Windows profile reparse points without traversing their targets. */
export function removeProfile(root: string, env: NodeJS.ProcessEnv) {
  const result = spawnSync("node", ["-e",
    "require('node:fs').rmSync(process.argv[1], {recursive:true,force:true,maxRetries:0})", root],
  { env, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, `Temporary profile cleanup failed: ${result.stderr}`);
  assert.equal(existsSync(root), false, "Temporary profile remains after cleanup");
}

/** Preserve only this disposable install's diagnostics before profile removal. */
export function preserveInstallerLogs(root: string, installed: string, env: NodeJS.ProcessEnv, phase: string, snapshot = "failure") {
  const evidence = process.env.BUTLER_WINDOWS_INSTALLER_EVIDENCE;
  if (!evidence) return;
  const output = join(evidence, snapshot);
  mkdirSync(output, { recursive: true });
  const sources: [string, string][] = [
    ["setup.log", join(env.LOCALAPPDATA!, "SquirrelTemp/SquirrelSetup.log")],
    ["update.log", join(installed, "SquirrelSetup.log")],
    ["uninstall.log", join(env.LOCALAPPDATA!, "SquirrelSetup.log")],
    ["electron.log", join(root, "electron.log")],
    ["app-install.log", join(env.BUTLER_DATA!, "updates/app-install.log")],
  ];
  // Current Squirrel uses action-specific and rotated logs, including TEMP on uninstall.
  for (const [label, directory] of [
    ["setup", join(env.SQUIRREL_TEMP!, "SquirrelTemp")], ["installed", installed],
    ["local", env.LOCALAPPDATA!], ["temp", env.TEMP!],
  ]) {
    if (!existsSync(directory)) continue;
    for (const file of readdirSync(directory, { withFileTypes: true })) {
      if (file.isFile() && /^Squirrel.*\.log$/iu.test(file.name)) sources.push([`${label}-${file.name}`, join(directory, file.name)]);
    }
  }
  const captured: string[] = [];
  for (const [name, path] of sources) {
    if (!existsSync(path)) continue;
    copyFileSync(path, join(output, name));
    captured.push(name);
  }
  writeFileSync(join(output, "diagnostics.json"), JSON.stringify({ phase, captured,
    installed, localAppData: env.LOCALAPPDATA, squirrelTemp: env.SQUIRREL_TEMP }));
}
