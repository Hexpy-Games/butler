import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
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

export function readJson(path: string): Record<string, any> | null {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

export async function waitFor(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 60_000;
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

function recordFileRoots(path: string, owned: OwnedProcesses, pids: (value: string) => number[]) {
  if (!existsSync(path)) return;
  const notAfter = statSync(path).mtimeMs;
  for (const pid of pids(readFileSync(path, "utf8"))) {
    if (Number.isInteger(pid) && pid > 0 && !owned.has(pid)) owned.set(pid, { notAfter });
  }
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
