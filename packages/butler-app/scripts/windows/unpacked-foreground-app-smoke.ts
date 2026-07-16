import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appLocalAuthPath } from "../../client/electron/app-agent-supervisor.mjs";
import {
  appForegroundInstancePath,
  appForegroundLastExitPath,
  appForegroundStartupFailurePath,
  appForegroundStartupProgressPath,
} from "../../client/electron/app-foreground-lifecycle.mjs";
import { prepareBundledAgentResource } from "../release/package-app-release.ts";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("unpacked foreground App smoke requires Windows x64");
}

const repoRoot = process.cwd();
const smokeRoot = join(tmpdir(), "Butler unpacked App 한글 smoke");
const dataRoot = join(smokeRoot, "사용자 data");
const profileRoot = join(smokeRoot, "Electron profile");
const resourceWork = join(smokeRoot, "번들 resource");
const electronRoot = join(repoRoot, "packages", "butler-app", "client", "electron");
const electronExecutable = join(
  electronRoot,
  "node_modules",
  "electron",
  "dist",
  "electron.exe",
);
const renderer = join(
  repoRoot,
  "packages",
  "butler-app",
  "client",
  "ui",
  "dist",
  "index.html",
);

if (!existsSync(electronExecutable)) {
  throw new Error("Electron executable is missing from the Windows workspace");
}
if (!existsSync(renderer)) {
  throw new Error("built App renderer is missing from the Windows workspace");
}

rmSync(smokeRoot, { recursive: true, force: true });
mkdirSync(smokeRoot, { recursive: true });
const port = await availablePort();
let electron: ElectronLaunch | null = null;
let output = "";

try {
  const resource = prepareBundledAgentResource(
    repoRoot,
    resourceWork,
    "win32-x64",
  );
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    BUTLER_APP_BUNDLED_AGENT_DIR: resource.resourceDir,
    BUTLER_APP_ELECTRON_USER_DATA_DIR: profileRoot,
    BUTLER_APP_SERVER_PORT: String(port),
    BUTLER_DATA: dataRoot,
  };
  delete environment.BUTLER_APP_SERVER_URL;
  delete environment.BUTLER_APP_UI_URL;
  delete environment.BUTLER_APP_DEV_ORIGIN;
  delete environment.BUTLER_APP_SERVER_BRIDGE;

  electron = await launchElectron(environment, "primary");
  const initial = await waitForReadyInstance({
    dataRoot,
    port,
    electron,
    // Archive activation is intentionally bounded, but hosted Windows runners
    // can spend more than one minute scanning the freshly extracted payload.
    timeoutMs: 150_000,
  });
  const startup = await waitForDesktopStartup(dataRoot, 15_000);
  const authToken = readAuthToken(dataRoot);
  const unauthenticatedRejected = await unauthenticatedHealthRejected(port);
  const authenticatedHealth = await authenticatedHealthReady(port, authToken);

  const second = await launchElectron(environment, "second-instance");
  const secondExit = await waitForExit(second.launcher, 15_000);
  const singleInstance =
    secondExit.exited &&
    processAlive(electron.pid) &&
    (await authenticatedHealthReady(port, authToken));

  if (!initial.agent_host_pid) {
    throw new Error("ready foreground lifecycle did not record the Agent host PID");
  }
  process.kill(initial.agent_host_pid, "SIGKILL");
  const recovered = await waitForReadyInstance({
    dataRoot,
    port,
    electron,
    timeoutMs: 30_000,
    previousGeneration: initial.generation,
    previousAgentHostPid: initial.agent_host_pid,
  });
  const boundedRecovery =
    recovered.generation !== initial.generation &&
    recovered.agent_host_pid !== initial.agent_host_pid &&
    recovered.state === "ready";

  const quitter = await launchElectron(environment, "quit-signal", true);
  await waitForExit(quitter.launcher, 15_000);
  const appExit = await waitForExit(electron.launcher, 20_000);
  const lastExit = await waitForLastExit(dataRoot, 15_000);
  const portReleased = await waitForPort(port, false, 15_000);
  const agentHostStopped = await waitForProcessDeath(
    recovered.agent_host_pid ?? 0,
    15_000,
  );
  const runtimeStopped =
    agentHostStopped &&
    lastExit.process_tree_dead === true &&
    lastExit.port_released === true &&
    portReleased;
  const standardUser = isMediumIntegrityProcess();
  const result = {
    ok:
      standardUser &&
      initial.state === "ready" &&
      initial.containment_kind === "windows_job_object" &&
      initial.containment_verified === true &&
      initial.owner_death_guaranteed === true &&
      initial.process_group_id === null &&
      startup.tray_ready === true &&
      startup.window_ready === true &&
      unauthenticatedRejected &&
      authenticatedHealth &&
      singleInstance &&
      boundedRecovery &&
      appExit.exited &&
      runtimeStopped,
    platform: `${process.platform}-${process.arch}`,
    standardUser,
    unpackedAppReady: initial.state === "ready",
    containment: initial.containment_kind,
    containmentVerified: initial.containment_verified === true,
    ownerDeathGuaranteed: initial.owner_death_guaranteed === true,
    posixProcessGroupRecorded: initial.process_group_id !== null,
    trayReady: startup.tray_ready === true,
    windowReady: startup.window_ready === true,
    localAuthRequired: unauthenticatedRejected,
    authenticatedHealth,
    singleInstance,
    boundedRecovery,
    gracefulQuit: appExit.exited && lastExit.graceful === true,
    processTreeDead: runtimeStopped,
    agentHostStopped,
    recordedProcessTreeDead: lastExit.process_tree_dead === true,
    recordedPortReleased: lastExit.port_released === true,
    portReleased,
    unicodeAndSpaces: true,
    rawTextIncluded: false,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const safeOutput = output
    .replaceAll(repoRoot, "<repo>")
    .replaceAll(smokeRoot, "<smoke>")
    .slice(-262_144);
  const diagnostics = startupFailureDiagnostics(dataRoot);
  throw new Error(
    [message, JSON.stringify(diagnostics), safeOutput].filter(Boolean).join("\n"),
    {
      cause: error,
    },
  );
} finally {
  if (electron?.pid && processAlive(electron.pid)) {
    process.kill(electron.pid, "SIGKILL");
    await waitForExit(electron.launcher, 5_000);
  }
  await waitForPort(port, false, 5_000);
  await removeTreeWhenUnlocked(smokeRoot);
}

interface ForegroundInstance {
  generation: string;
  state: string;
  agent_host_pid: number | null;
  process_group_id: number | null;
  containment_kind: string | null;
  containment_verified: boolean;
  owner_death_guaranteed: boolean;
}

interface ForegroundLastExit {
  graceful: boolean;
  process_tree_dead: boolean;
  port_released: boolean;
}

interface ElectronLaunch {
  launcher: ChildProcess;
  pid: number;
}

interface StartupProgress {
  stage: string;
  tray_ready: boolean;
  window_ready: boolean;
}

async function launchElectron(
  environment: NodeJS.ProcessEnv,
  label: string,
  quitMain = false,
): Promise<ElectronLaunch> {
  const launcherScript = join(
    repoRoot,
    "packages",
    "butler-app",
    "scripts",
    "windows",
    "launch-electron-smoke.ps1",
  );
  const pidFile = join(smokeRoot, `${label}.pid`);
  const exitFile = join(smokeRoot, `${label}.exit`);
  const child = spawn(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      launcherScript,
      "-Electron",
      electronExecutable,
      "-AppRoot",
      electronRoot,
      "-Profile",
      profileRoot,
      "-PidFile",
      pidFile,
      "-ExitFile",
      exitFile,
      ...(quitMain ? ["-QuitMain"] : []),
    ],
    {
      cwd: repoRoot,
      env: environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  captureOutput(child);
  const pid = await waitForPidFile(pidFile, child, 10_000);
  return { launcher: child, pid };
}

function captureOutput(child: ChildProcess): void {
  child.stdout?.on("data", (chunk) => {
    output = `${output}${String(chunk)}`.slice(-262_144);
  });
  child.stderr?.on("data", (chunk) => {
    output = `${output}${String(chunk)}`.slice(-262_144);
  });
}

function startupFailureDiagnostics(dataRoot: string): Record<string, unknown> {
  const failureRoot = join(dataRoot, "app", "runtime", "agent", "failures");
  const failures = existsSync(failureRoot)
    ? readdirSync(failureRoot)
      .filter((name) => name.endsWith(".json"))
      .map((name) => readJson<Record<string, unknown>>(join(failureRoot, name)))
      .filter(Boolean)
    : [];
  return {
    instance: readJson<ForegroundInstance>(appForegroundInstancePath(dataRoot)),
    startupFailure: readJson<Record<string, unknown>>(
      appForegroundStartupFailurePath(dataRoot),
    ),
    startupProgress: readJson<Record<string, unknown>>(
      appForegroundStartupProgressPath(dataRoot),
    ),
    failures,
    rawTextIncluded: false,
  };
}

async function waitForReadyInstance({
  dataRoot,
  port,
  electron: appProcess,
  timeoutMs,
  previousGeneration = null,
  previousAgentHostPid = null,
}: {
  dataRoot: string;
  port: number;
  electron: ElectronLaunch;
  timeoutMs: number;
  previousGeneration?: string | null;
  previousAgentHostPid?: number | null;
}): Promise<ForegroundInstance> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (appProcess.launcher.exitCode !== null) {
      throw new Error(
        `Electron exited before foreground readiness: ${appProcess.launcher.exitCode}`,
      );
    }
    const instance = readJson<ForegroundInstance>(
      appForegroundInstancePath(dataRoot),
    );
    const generationChanged =
      previousGeneration === null || instance?.generation !== previousGeneration;
    const hostChanged =
      previousAgentHostPid === null ||
      instance?.agent_host_pid !== previousAgentHostPid;
    if (
      instance?.state === "ready" &&
      generationChanged &&
      hostChanged &&
      (await waitForPort(port, true, 250))
    ) {
      return instance;
    }
    await delay(50);
  }
  throw new Error("Timed out waiting for unpacked App foreground readiness");
}

async function waitForDesktopStartup(
  dataRoot: string,
  timeoutMs: number,
): Promise<StartupProgress> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const progress = readJson<StartupProgress>(
      appForegroundStartupProgressPath(dataRoot),
    );
    if (progress?.tray_ready === true && progress.window_ready === true) {
      return progress;
    }
    await delay(50);
  }
  throw new Error("Timed out waiting for Windows tray and window readiness");
}

async function waitForPidFile(
  path: string,
  launcher: ChildProcess,
  timeoutMs: number,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (launcher.exitCode !== null) {
      throw new Error(
        `Electron launcher exited before publishing a PID: ${launcher.exitCode}`,
      );
    }
    if (existsSync(path)) {
      const pid = Number(readFileSync(path, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
    await delay(25);
  }
  throw new Error("Timed out waiting for Electron launcher PID");
}

async function waitForLastExit(
  dataRoot: string,
  timeoutMs: number,
): Promise<ForegroundLastExit> {
  const path = appForegroundLastExitPath(dataRoot);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const record = readJson<ForegroundLastExit>(path);
    if (record) return record;
    await delay(50);
  }
  throw new Error("Timed out waiting for App foreground last-exit record");
}

function readAuthToken(dataRoot: string): string {
  const auth = readJson<{ token?: string }>(appLocalAuthPath(dataRoot));
  if (!auth?.token || auth.token.length < 32) {
    throw new Error("App local auth token was not created");
  }
  return auth.token;
}

async function unauthenticatedHealthRejected(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    return response.status === 401 || response.status === 403;
  } catch {
    return false;
  }
}

async function authenticatedHealthReady(
  port: number,
  token: string,
): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = await response.json().catch(() => null);
    return response.ok && body?.protocol_version === "butler.app.v1" &&
      body?.data?.ok === true;
  } catch {
    return false;
  }
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function waitForPort(
  port: number,
  expected: boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await canConnect(port)) === expected) return true;
    await delay(50);
  }
  return false;
}

async function canConnect(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

async function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ exited: boolean; code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { exited: true, code: child.exitCode, signal: child.signalCode };
  }
  return await new Promise((resolve) => {
    const timer = setTimeout(
      () => resolve({ exited: false, code: null, signal: null }),
      timeoutMs,
    );
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ exited: true, code, signal });
    });
  });
}

function isMediumIntegrityProcess(): boolean {
  const result = spawnSync("whoami.exe", ["/groups", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    windowsHide: true,
  });
  return result.status === 0 && result.stdout.includes("S-1-16-8192");
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessDeath(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true;
    await delay(50);
  }
  return !processAlive(pid);
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function removeTreeWhenUnlocked(path: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch {
      if (attempt === 19) return;
      await delay(100);
    }
  }
}
