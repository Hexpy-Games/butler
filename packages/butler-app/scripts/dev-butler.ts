import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

export const DEFAULT_ISOLATED_DEV_SERVER_PORT = 28_765;
export const DEFAULT_ISOLATED_DEV_UI_PORT = 25_173;

const DEFAULT_DATA_DIR = "development";
const READINESS_TIMEOUT_MS = 15_000;
const READINESS_POLL_INTERVAL_MS = 150;
const HEALTH_REQUEST_TIMEOUT_MS = 500;
const SHUTDOWN_GRACE_PERIOD_MS = 1_500;

type ChildExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
};

type ManagedChild = {
  child: ChildProcess;
  exit: Promise<ChildExit>;
};

type Dependencies = {
  platform: NodeJS.Platform;
  spawnProcess: (
    command: string,
    args: string[],
    options: SpawnOptions,
  ) => ChildProcess;
  healthCheck: (url: string, signal?: AbortSignal) => Promise<boolean>;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => number;
  killProcessGroup: (pid: number, signal: NodeJS.Signals) => void;
};

type RunnerOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  dependencies?: Partial<Dependencies>;
};

const defaultDependencies: Dependencies = {
  platform: process.platform,
  spawnProcess: spawn,
  healthCheck: checkHealth,
  sleep: (milliseconds) =>
    new Promise<void>((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
  now: () => Date.now(),
  killProcessGroup: (pid, signal) => process.kill(-pid, signal),
};

export function resolveIsolatedDevConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
) {
  const root = resolve(cwd);
  const dataRoot = resolve(
    env.BUTLER_DATA?.trim() || join(homedir(), ".butler"),
    env.BUTLER_DEV_DATA?.trim() || join(DEFAULT_DATA_DIR, createHash("sha256").update(root).digest("hex").slice(0, 12)),
  );
  const serverPort = parsePort(
    env.BUTLER_DEV_SERVER_PORT,
    DEFAULT_ISOLATED_DEV_SERVER_PORT,
    "Butler development server port",
  );
  const uiPort = parsePort(
    env.BUTLER_DEV_UI_PORT,
    DEFAULT_ISOLATED_DEV_UI_PORT,
    "Butler development UI port",
  );
  const serverUrl = `http://127.0.0.1:${serverPort}/`;
  const uiUrl = `http://127.0.0.1:${uiPort}/`;
  return {
    root,
    dataRoot,
    electronUserDataDir: resolve(
      root,
      join(dataRoot, "app", "electron-user-data"),
    ),
    runtime: env.BUTLER_BUN?.trim() || "bun",
    serverPort,
    uiPort,
    serverUrl,
    uiUrl,
    healthUrl: new URL("/health", serverUrl).toString(),
  };
}

export function isolatedDevEnvironment(
  config: ReturnType<typeof resolveIsolatedDevConfig>,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...baseEnv,
    BUTLER_HOME: config.root,
    BUTLER_APP_BUTLER_HOME: config.root,
    BUTLER_DATA: config.dataRoot,
    BUTLER_BUN: config.runtime,
    BUTLER_APP_SERVER_HOST: "127.0.0.1",
    BUTLER_APP_SERVER_PORT: String(config.serverPort),
    BUTLER_APP_SERVER_URL: config.serverUrl,
    BUTLER_APP_SERVER_DB: join(
      config.dataRoot,
      "app-server",
      "butler-client.sqlite",
    ),
    BUTLER_APP_UI_PORT: String(config.uiPort),
    BUTLER_APP_UI_URL: config.uiUrl,
    BUTLER_APP_DEV_ORIGIN: new URL(config.uiUrl).origin,
    BUTLER_APP_BUNDLED_SUPERVISOR: "1",
    BUTLER_APP_ELECTRON_USER_DATA_DIR: config.electronUserDataDir,
  };
  delete environment.BUTLER_APP_LOCAL_AUTH_FILE;
  delete environment.BUTLER_APP_LOCAL_AUTH_REQUIRED;
  return environment;
}

export async function runIsolatedDev(options: RunnerOptions = {}): Promise<number> {
  const config = resolveIsolatedDevConfig(options.env, options.cwd);
  const dependencies: Dependencies = {
    ...defaultDependencies,
    ...options.dependencies,
  };
  const environment = isolatedDevEnvironment(config, options.env);
  const children: ManagedChild[] = [];

  mkdirSync(config.dataRoot, { recursive: true, mode: 0o700 });
  console.log(`Butler isolated development data: ${config.dataRoot}`);
  console.log(`Butler app gateway: ${config.serverUrl}`);
  console.log(`Butler app UI: ${config.uiUrl}`);

  try {
    throwIfAborted(options.signal);
    const gateway = spawnManaged(
      { command: config.runtime, args: ["run", "app:server"] },
      config.root,
      environment,
      dependencies,
      "Agent gateway startup",
    );
    children.push(gateway);
    await waitForGateway(config.healthUrl, gateway, options.signal, dependencies);

    throwIfAborted(options.signal);
    const client = spawnManaged(
      { command: config.runtime, args: ["run", "app:client:dev"] },
      config.root,
      environment,
      dependencies,
      "Electron/Vite client startup",
    );
    children.push(client);

    const outcome = await Promise.race([
      client.exit.then((exit) => ({ owner: "client" as const, exit })),
      gateway.exit.then((exit) => ({ owner: "gateway" as const, exit })),
      whenAborted(options.signal).then(() => ({ owner: "signal" as const })),
    ]);
    if (outcome.owner === "signal") return 0;
    if (outcome.owner === "gateway") {
      throw runnerError(
        "Agent gateway runtime",
        describeExit(outcome.exit, "exited while the client was running"),
      );
    }
    if (outcome.exit.error) {
      throw runnerError(
        "Electron/Vite client startup",
        outcome.exit.error.message,
      );
    }
    return childExitCode(outcome.exit);
  } finally {
    await stopChildren(children, dependencies);
  }
}

function parsePort(value: string | undefined, fallback: number, label: string) {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw runnerError("configuration", `${label} must be an integer between 1 and 65535.`);
  }
  return parsed;
}

async function checkHealth(url: string, signal?: AbortSignal): Promise<boolean> {
  const timeout = AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const response = await fetch(url, { signal: requestSignal });
    const body = (await response.json().catch(() => null)) as {
      protocol_version?: string;
      data?: { ok?: boolean };
    } | null;
    return (
      response.ok &&
      body?.protocol_version === "butler.app.v1" &&
      body?.data?.ok === true
    );
  } catch {
    return false;
  }
}

function spawnManaged(
  invocation: { command: string; args: string[] },
  cwd: string,
  env: NodeJS.ProcessEnv,
  dependencies: Dependencies,
  phase: string,
): ManagedChild {
  try {
    const child = dependencies.spawnProcess(invocation.command, invocation.args, {
      cwd,
      env,
      shell: false,
      detached: dependencies.platform !== "win32",
      windowsHide: true,
      stdio: "inherit",
    });
    return { child, exit: observeExit(child) };
  } catch (error) {
    throw runnerError(
      phase,
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function waitForGateway(
  healthUrl: string,
  gateway: ManagedChild,
  signal: AbortSignal | undefined,
  dependencies: Dependencies,
): Promise<void> {
  const deadline = dependencies.now() + READINESS_TIMEOUT_MS;
  const aborted = whenAborted(signal);
  while (dependencies.now() < deadline) {
    throwIfAborted(signal);
    const result = await Promise.race([
      dependencies.healthCheck(healthUrl, signal).then((healthy) => ({
        kind: "health" as const,
        healthy,
      })),
      gateway.exit.then((exit) => ({ kind: "exit" as const, exit })),
      aborted.then(() => ({ kind: "abort" as const })),
    ]);
    if (result.kind === "abort") throw new RunAbortedError();
    if (result.kind === "exit") {
      const phase = result.exit.error
        ? "Agent gateway startup"
        : "Agent gateway readiness";
      throw runnerError(
        phase,
        describeExit(result.exit, "exited before /health became ready"),
      );
    }
    if (result.healthy) return;
    await dependencies.sleep(READINESS_POLL_INTERVAL_MS);
  }
  throw runnerError(
    "Agent gateway readiness",
    `timed out waiting for ${healthUrl}`,
  );
}

function observeExit(child: ChildProcess): Promise<ChildExit> {
  return new Promise((resolveExit) => {
    let settled = false;
    const settle = (exit: ChildExit) => {
      if (settled) return;
      settled = true;
      resolveExit(exit);
    };
    if (child.exitCode !== null) {
      settle({ code: child.exitCode, signal: null });
      return;
    }
    child.once("error", (error) =>
      settle({ code: null, signal: null, error: new Error(String(error)) }),
    );
    child.once("exit", (code, signal) => settle({ code, signal }));
  });
}

async function stopChildren(
  children: ManagedChild[],
  dependencies: Dependencies,
): Promise<void> {
  for (const { child } of children.filter(({ child }) => isRunning(child))) {
    signalChild(child, "SIGTERM", dependencies);
  }
  await Promise.race([
    Promise.all(children.map(({ exit }) => exit)),
    dependencies.sleep(SHUTDOWN_GRACE_PERIOD_MS),
  ]);
  for (const { child } of children.filter(({ child }) => isRunning(child))) {
    signalChild(child, "SIGKILL", dependencies);
  }
}

function isRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode == null;
}

function signalChild(
  child: ChildProcess,
  signal: NodeJS.Signals,
  dependencies: Dependencies,
): void {
  try {
    if (dependencies.platform !== "win32" && child.pid) {
      dependencies.killProcessGroup(child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The child exited between the status check and signal delivery.
    }
  }
}

function describeExit(exit: ChildExit, fallback: string): string {
  if (exit.error) return exit.error.message;
  const status = exit.code !== null ? `exit code ${exit.code}` : exit.signal;
  return `${fallback} with ${status ?? "unknown status"}`;
}

function childExitCode(exit: ChildExit): number {
  if (exit.code !== null) return exit.code;
  return exit.signal === "SIGINT" || exit.signal === "SIGTERM" ? 0 : 1;
}

function runnerError(phase: string, message: string): Error {
  return new Error(`${phase} failed: ${message}`);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RunAbortedError();
}

class RunAbortedError extends Error {}

function whenAborted(signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise(() => undefined);
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolveAbort) =>
    signal.addEventListener("abort", () => resolveAbort(), { once: true }),
  );
}

async function main(): Promise<void> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    process.exitCode = await runIsolatedDev({ signal: controller.signal });
  } catch (error) {
    if (!(error instanceof RunAbortedError)) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

if (import.meta.main) void main();
