import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

export function ownedProcesses(data: string, owned: Set<number>) {
  const instance = readJson(join(data, "app/runtime/foreground/instance.json"));
  const helperPath = join(data, "updates/app-install.pid");
  if (existsSync(helperPath)) {
    const helper = Number(readFileSync(helperPath, "utf8"));
    if (Number.isInteger(helper) && helper > 0) owned.add(helper);
  }
  for (const pid of [instance?.app_pid, instance?.agent_host_pid]) {
    if (Number.isInteger(pid) && pid > 0) owned.add(pid);
  }
  for (const pid of [...owned]) {
    const tree = powershell(`$all = @(Get-CimInstance Win32_Process); $ids = @(${pid}); do {
      $next = @($all | Where-Object { $_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids } | ForEach-Object { $_.ProcessId })
      $ids += $next
    } while ($next.Count); ConvertTo-Json -Compress -InputObject @($ids)`);
    for (const child of JSON.parse(tree)) owned.add(child);
  }
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
