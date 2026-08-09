import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter } from "node:path";
import type { ChildProcess } from "node:child_process";

export interface CommandRequest {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  startedAtMs: number;
  endedAtMs: number;
  firstOutputAtMs: number | null;
  timedOut: boolean;
  cancelled: boolean;
}

export interface CommandExecutor {
  execute(request: CommandRequest): Promise<CommandResult>;
}

const MAX_CAPTURE_BYTES = 64 * 1024;
const TERMINATION_GRACE_MS = 1_000;
const SAFE_ENVIRONMENT_KEYS = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "BUTLER_CODEX_BASE_URL",
  "BUTLER_DATA",
]);
const SAFE_BENCHMARK_ENVIRONMENT_KEYS = new Set([
  "HERMES_WRITE_SAFE_ROOT",
  "OPENCODE_MODEL",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_DISABLE_CLAUDE_CODE",
]);

/** Spawns a process with an argument vector and no shell interpolation. */
export function createProcessExecutor(): CommandExecutor {
  return { execute: executeCommand };
}

export async function executeCommand(request: CommandRequest): Promise<CommandResult> {
  const startedAtMs = Date.now();
  let child: ChildProcess;
  try {
    child = spawn(request.executable, [...request.args], {
      cwd: request.cwd,
      env: request.env,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    return {
      exitCode: null,
      stdout: "",
      stderr: boundedText(error instanceof Error ? error.message : String(error)),
      startedAtMs,
      endedAtMs: Date.now(),
      firstOutputAtMs: null,
      timedOut: false,
      cancelled: false,
    };
  }
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let cancelled = false;
  let firstOutputAtMs: number | null = null;
  const append = (current: string, chunk: Buffer | string): string => {
    const next = current + String(chunk);
    return next.length > MAX_CAPTURE_BYTES
      ? next.slice(next.length - MAX_CAPTURE_BYTES)
      : next;
  };
  child.stdout?.on("data", (chunk: Buffer) => {
    firstOutputAtMs ??= Date.now();
    stdout = append(stdout, chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = append(stderr, chunk);
  });
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  const requestTermination = (reason: "timeout" | "cancelled"): void => {
    if (reason === "timeout") timedOut = true;
    else cancelled = true;
    terminateProcess(child);
    if (!graceTimer) graceTimer = setTimeout(() => forceTerminateProcess(child), TERMINATION_GRACE_MS);
  };
  const onAbort = (): void => requestTermination("cancelled");
  request.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => requestTermination("timeout"), request.timeoutMs);
  child.once("close", () => {
    if (graceTimer) clearTimeout(graceTimer);
  });
  const exitCode = await new Promise<number | null>((resolveExit) => {
    child.once("error", () => resolveExit(null));
    child.once("close", (code) => resolveExit(code));
    if (request.signal.aborted) requestTermination("cancelled");
  });
  clearTimeout(timer);
  request.signal.removeEventListener("abort", onAbort);
  return {
    exitCode,
    stdout: boundedText(stdout),
    stderr: boundedText(stderr),
    startedAtMs,
    endedAtMs: Date.now(),
    firstOutputAtMs,
    timedOut,
    cancelled,
  };
}

export function resolveExecutable(
  name: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  if (name.includes("/")) return isExecutable(name) ? name : null;
  const pathValue = environment.PATH ?? "";
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    const candidate = `${directory}/${name}`;
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

export function safeEnvironment(
  extra: NodeJS.ProcessEnv = {},
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    if (source[key] !== undefined) environment[key] = source[key];
  }
  for (const [key, value] of Object.entries(extra)) {
    if (!isSafeEnvironmentKey(key)) continue;
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

export function boundedText(value: string): string {
  const redacted = value
    .replace(/((?:api[_-]?key|token|password|secret))\s*[:=]\s*[^\s,;]+/giu, "$1=[REDACTED]")
    .replace(/(?:\/Users\/|\/home\/|[A-Z]:\\)[^\s)]+/gu, "[PRIVATE_PATH]")
    .replace(/\$1/gu, "[REDACTED]");
  return redacted.length > MAX_CAPTURE_BYTES
    ? redacted.slice(redacted.length - MAX_CAPTURE_BYTES)
    : redacted;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isSafeEnvironmentKey(key: string): boolean {
  return SAFE_ENVIRONMENT_KEYS.has(key) || SAFE_BENCHMARK_ENVIRONMENT_KEYS.has(key);
}

function terminateProcess(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    if (process.platform !== "win32") process.kill(-pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process may have exited between the two attempts.
    }
  }
}

function forceTerminateProcess(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    if (process.platform !== "win32") process.kill(-pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch { /* already exited */ }
  }
}
