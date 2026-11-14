/** Disposable hosted-runner proof of Electron -> gpui Squirrel activation. */
import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { freePort } from "../../../../tests/support/native-app-server.ts";
import { windowsPowerShellEnvironment } from "../../client/electron/windows-powershell-environment.mjs";
import { windowsPackageVersion } from "../../client/electron/scripts/windows-package-version.mjs";
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
  TEMP: join(root, "tmp"), TMP: join(root, "tmp"), SQUIRREL_TEMP: join(root, "squirrel"),
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
try {
  const local = powershell("[Environment]::GetFolderPath('LocalApplicationData', [Environment+SpecialFolderOption]::DoNotVerify)", env);
  assert.equal(resolve(local).toLowerCase(), resolve(env.LOCALAPPDATA).toLowerCase(), "Squirrel profile must be isolated");
  for (const path of [env.HOME, data, env.LOCALAPPDATA, env.APPDATA, env.TEMP, env.SQUIRREL_TEMP]) mkdirSync(path, { recursive: true });
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
    async () => { if (!uninstalled && existsSync(updater)) run(updater, ["--uninstall", "--silent"]); },
  ]) {
    try { await action(); } catch (error) { errors.push(error); }
  }
  try {
    await waitFor(() => helperClosed, "update helper streams closed");
  } catch (error) { errors.push(error); }
  try { preserveLogs(); } finally { removeProfile(root, env); }
  for (const error of errors) console.error(`Smoke cleanup failed: ${String(error)}`);
  if (errors.length && !failed) throw errors[0];
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
  const helperLog = openSync(join(root, "helper-stderr.log"), "a");
  helperClosed = false;
  const helper = spawn(join(dirname(oldApp), "resources/bundled-agent/bin/butler-agent.exe"),
    ["app-update-install", packagePath, oldApp, String(oldAppPid)], { env, stdio: ["pipe", "pipe", helperLog] });
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

type InstalledProcess = { pid: number; path: string };
function installedProcesses(): InstalledProcess[] {
  return JSON.parse(powershell(`$root = [IO.Path]::GetFullPath($env:BUTLER_SMOKE_INSTALL).TrimEnd('\\') + '\\'
    ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process |
      Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) } |
      ForEach-Object { @{ pid = $_.ProcessId; path = $_.ExecutablePath } })`, { ...env, BUTLER_SMOKE_INSTALL: installed }));
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
    return response?.ok === true && (await response.json()).ok === true;
  }, "updated gpui App and authenticated supervised Agent", 120_000);
  assert.equal(readFileSync(join(data, "sentinel.txt"), "utf8"), "retained");
  assert.ok(existsSync(join(data, "butler.config.json")), "User configuration missing");
}

async function stopInstalled() {
  const processes = installedProcesses();
  for (const { pid } of processes) {
    // A parent tree kill may already have ended another collected child.
    if (!installedProcesses().some(row => row.pid === pid)) continue;
    const killed = spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { env, encoding: "utf8" });
    if (killed.status !== 0) assert.ok(!installedProcesses().some(row => row.pid === pid), `Failed to stop owned PID ${pid}`);
  }
  await waitFor(() => installedProcesses().length === 0, "installed processes stopped");
}

async function uninstall() {
  await stopInstalled();
  run(updater, ["--uninstall", "--silent"]);
  await waitFor(() => !existsSync(stub), "uninstalled stub removed");
  assertShortcuts(shortcuts, false);
  for (const key of ["HKCU:\\Software\\Classes\\butler", "HKCU:\\Software\\Classes\\AppUserModelId\\com.squirrel.butler-app.Butler"]) {
    assert.equal(powershell("Test-Path -LiteralPath $env:BUTLER_SMOKE_KEY", { ...env, BUTLER_SMOKE_KEY: key }), "False", key);
  }
  assert.equal(powershell("[bool](Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -ErrorAction SilentlyContinue).'com.squirrel.butler-app.Butler'", env), "False");
  const files = existsSync(installed) ? readdirSync(installed, { recursive: true, withFileTypes: true })
    .filter(entry => !entry.isDirectory()).map(entry => join(entry.parentPath, entry.name)) : [];
  assert.deepEqual(files, [], `Uninstall left files: ${files.join(", ")}`);
  assert.equal(readFileSync(join(data, "sentinel.txt"), "utf8"), "retained");
  uninstalled = true;
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
}
