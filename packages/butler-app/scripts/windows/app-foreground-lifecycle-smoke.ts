import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("Windows App foreground lifecycle smoke requires Windows x64");
}

const mode = process.argv.find((argument) =>
  ["--owner", "--worker", "--descendant"].includes(argument),
);

if (mode === "--owner") {
  await runOwner();
} else if (mode === "--worker") {
  runWorker();
} else if (mode === "--descendant") {
  runDescendant();
} else {
  await runSmoke();
}

async function runSmoke(): Promise<void> {
  const processHost = requiredEnvironment("BUTLER_WINDOWS_PROCESS_HOST");
  const root = join(tmpdir(), "Butler App 전경 수명주기 smoke");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  try {
    const graceful = await runScenario({
      root,
      processHost,
      name: "normal-stop",
      ownerDeath: false,
    });
    const ownerDeath = await runScenario({
      root,
      processHost,
      name: "owner-death",
      ownerDeath: true,
    });
    const standardUser = isMediumIntegrityProcess();
    const result = {
      ok:
        standardUser &&
        graceful.processTreeDead &&
        graceful.portReleased &&
        ownerDeath.processTreeDead &&
        ownerDeath.portReleased,
      platform: `${process.platform}-${process.arch}`,
      standardUser,
      containment: "windows_job_object",
      normalStop: graceful,
      ownerDeath,
      unicodeAndSpaces: true,
      rawTextIncluded: false,
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 1;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function runScenario({
  root,
  processHost,
  name,
  ownerDeath,
}: {
  root: string;
  processHost: string;
  name: string;
  ownerDeath: boolean;
}): Promise<{
  ownerDeath: boolean;
  ownerPid: number;
  hostPid: number;
  workerPid: number;
  descendantPid: number;
  portClaimed: boolean;
  processTreeDead: boolean;
  portReleased: boolean;
  rawTextIncluded: false;
}> {
  const scenarioRoot = join(root, name);
  mkdirSync(scenarioRoot, { recursive: true });
  const port = await availablePort();
  const ownerState = join(scenarioRoot, "owner 상태.json");
  const workerState = join(scenarioRoot, "worker 상태.json");
  const descendantState = join(scenarioRoot, "descendant 상태.json");
  const stopFile = join(scenarioRoot, "stop.requested");
  const owner = spawn(
    process.execPath,
    [
      "run",
      import.meta.filename,
      "--owner",
      "--process-host",
      processHost,
      "--owner-state",
      ownerState,
      "--worker-state",
      workerState,
      "--descendant-state",
      descendantState,
      "--stop-file",
      stopFile,
      "--port",
      String(port),
    ],
    {
      cwd: scenarioRoot,
      env: process.env,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  if (!owner.pid) throw new Error("App foreground smoke owner did not expose a PID");

  let state: ScenarioState | null = null;
  try {
    state = await waitForScenarioState({
      ownerState,
      workerState,
      descendantState,
      timeoutMs: 15_000,
    });
    const portClaimed = await waitForPort(port, true, 5_000);
    if (ownerDeath) {
      owner.kill("SIGKILL");
    } else {
      writeFileSync(stopFile, "stop\n", "utf8");
    }
    await waitForExit(owner, 10_000);
    const processTreeDead = await waitForProcessesDead(
      [state.ownerPid, state.hostPid, state.workerPid, state.descendantPid],
      10_000,
    );
    const portReleased = await waitForPort(port, false, 10_000);
    return {
      ownerDeath,
      ...state,
      portClaimed,
      processTreeDead,
      portReleased,
      rawTextIncluded: false,
    };
  } finally {
    for (const pid of [
      state?.descendantPid,
      state?.workerPid,
      state?.hostPid,
      owner.pid,
    ]) {
      if (pid) killIfAlive(pid);
    }
  }
}

async function runOwner(): Promise<void> {
  const processHost = requiredArgument("--process-host");
  const ownerState = requiredArgument("--owner-state");
  const workerState = requiredArgument("--worker-state");
  const descendantState = requiredArgument("--descendant-state");
  const stopFile = requiredArgument("--stop-file");
  const port = requiredPort();
  const child = spawn(
    processHost,
    [
      "--owner-pid",
      String(process.pid),
      process.execPath,
      "run",
      import.meta.filename,
      "--worker",
      "--worker-state",
      workerState,
      "--descendant-state",
      descendantState,
      "--port",
      String(port),
    ],
    {
      env: process.env,
      shell: false,
      stdio: ["ignore", "inherit", "inherit"],
      windowsHide: true,
    },
  );
  if (!child.pid) throw new Error("Windows process host did not expose a PID");
  writeJson(ownerState, { ownerPid: process.pid, hostPid: child.pid });
  const stopTimer = setInterval(() => {
    if (existsSync(stopFile)) child.kill("SIGTERM");
  }, 25);
  child.once("exit", (code) => {
    clearInterval(stopTimer);
    process.exit(code === 0 || code === null ? 0 : code);
  });
}

function runWorker(): void {
  const workerState = requiredArgument("--worker-state");
  const descendantState = requiredArgument("--descendant-state");
  const port = requiredPort();
  const descendant = spawn(
    process.execPath,
    [
      "run",
      import.meta.filename,
      "--descendant",
      "--descendant-state",
      descendantState,
      "--port",
      String(port),
    ],
    {
      env: process.env,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  if (!descendant.pid) throw new Error("App foreground descendant did not expose a PID");
  writeJson(workerState, { workerPid: process.pid, descendantPid: descendant.pid });
  setInterval(() => undefined, 60 * 60 * 1_000);
}

function runDescendant(): void {
  const descendantState = requiredArgument("--descendant-state");
  const port = requiredPort();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: () => Response.json({ ok: true }),
  });
  writeJson(descendantState, {
    descendantPid: process.pid,
    port: server.port ?? port,
  });
}

interface ScenarioState {
  ownerPid: number;
  hostPid: number;
  workerPid: number;
  descendantPid: number;
}

async function waitForScenarioState({
  ownerState,
  workerState,
  descendantState,
  timeoutMs,
}: {
  ownerState: string;
  workerState: string;
  descendantState: string;
  timeoutMs: number;
}): Promise<ScenarioState> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const owner = readJson(ownerState);
    const worker = readJson(workerState);
    const descendant = readJson(descendantState);
    if (
      positiveInteger(owner?.ownerPid) &&
      positiveInteger(owner?.hostPid) &&
      positiveInteger(worker?.workerPid) &&
      positiveInteger(worker?.descendantPid) &&
      positiveInteger(descendant?.descendantPid)
    ) {
      return {
        ownerPid: owner.ownerPid,
        hostPid: owner.hostPid,
        workerPid: worker.workerPid,
        descendantPid: descendant.descendantPid,
      };
    }
    await delay(25);
  }
  throw new Error("Timed out waiting for App foreground process tree readiness");
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
    await delay(25);
  }
  return false;
}

async function canConnect(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

async function waitForProcessesDead(
  pids: number[],
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !processAlive(pid))) return true;
    await delay(25);
  }
  return false;
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for App foreground owner exit")),
      timeoutMs,
    );
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
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
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killIfAlive(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Cleanup is best effort after the assertion path has captured the failure.
  }
}

function readJson(path: string): Record<string, number> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, number>;
  } catch {
    return null;
  }
}

function writeJson(path: string, value: Record<string, number>): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredArgument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1]?.trim() : null;
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredPort(): number {
  const value = Number(requiredArgument("--port"));
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error("--port must be a valid port");
  }
  return value;
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
