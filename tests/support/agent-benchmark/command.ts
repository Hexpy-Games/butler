import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter } from "node:path";
import type { ChildProcess } from "node:child_process";
import { canSettleAfterExit, closeChildStdin, drainOutputStream, outputStreamIsComplete } from "./command-streams.ts";

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
  /** False when the process exited but stream completeness could not be proven. */
  outputComplete?: boolean;
  timedOut: boolean;
  cancelled: boolean;
}

export interface CommandExecutor {
  execute(request: CommandRequest): Promise<CommandResult>;
}

const MAX_CAPTURE_BYTES = 64 * 1024;
const TERMINATION_GRACE_MS = 1_000;
const POST_EXIT_STREAM_DRAIN_GRACE_MS = 1_500;
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
      outputComplete: false,
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
  let streamDrainTimer: ReturnType<typeof setTimeout> | null = null;
  const requestTermination = (reason: "timeout" | "cancelled"): void => {
    if (reason === "timeout") timedOut = true;
    else cancelled = true;
    terminateProcess(child);
    if (!graceTimer) graceTimer = setTimeout(() => forceTerminateProcess(child), TERMINATION_GRACE_MS);
  };
  const onAbort = (): void => requestTermination("cancelled");
  request.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => requestTermination("timeout"), request.timeoutMs);
  let settled = false;
  let exitObserved = false;
  let observedExitCode: number | null = null;
  let stdoutClosed = child.stdout === null;
  let stderrClosed = child.stderr === null;
  let outputComplete = false;
  const exitPromise = new Promise<number | null>((resolveExit) => {
    const settle = (code: number | null, complete: boolean): void => {
      if (settled) return;
      settled = true;
      outputComplete = complete;
      if (graceTimer) clearTimeout(graceTimer);
      if (streamDrainTimer) clearTimeout(streamDrainTimer);
      resolveExit(code);
    };
    const settleAfterExitAndStreams = (): void => {
      if (canSettleAfterExit(exitObserved, stdoutClosed, stderrClosed)) settle(observedExitCode, true);
    };
    const markStdoutClosed = (): void => {
      stdoutClosed = outputStreamIsComplete(child.stdout);
      settleAfterExitAndStreams();
      if (exitObserved) schedulePostExitDrain();
    };
    const markStderrClosed = (): void => {
      stderrClosed = outputStreamIsComplete(child.stderr);
      settleAfterExitAndStreams();
      if (exitObserved) schedulePostExitDrain();
    };
    const refreshOutputStreamState = (): void => {
      drainOutputStream(child.stdout, (chunk) => { stdout = append(stdout, chunk); });
      drainOutputStream(child.stderr, (chunk) => { stderr = append(stderr, chunk); });
      stdoutClosed ||= outputStreamIsComplete(child.stdout);
      stderrClosed ||= outputStreamIsComplete(child.stderr);
      settleAfterExitAndStreams();
    };
    const schedulePostExitDrain = (): void => {
      if (settled || streamDrainTimer) return;
      // A few products exit after destroying their stdio streams without
      // emitting end/close. Give one next-turn drain a chance to consume any
      // buffered bytes, then settle within a bounded grace period.
      setImmediate(() => {
        if (settled) return;
        refreshOutputStreamState();
        if (settled) return;
        streamDrainTimer = setTimeout(() => {
          if (settled) return;
          refreshOutputStreamState();
          settle(observedExitCode, stdoutClosed && stderrClosed);
        }, POST_EXIT_STREAM_DRAIN_GRACE_MS);
      });
    };
    child.once("error", () => settle(null, false));
    child.once("close", (code) => {
      exitObserved = true;
      observedExitCode = code;
      schedulePostExitDrain();
    });
    child.once("exit", (code) => {
      exitObserved = true;
      observedExitCode = code;
      settleAfterExitAndStreams();
      schedulePostExitDrain();
    });
    child.stdout?.once("end", markStdoutClosed);
    child.stdout?.once("close", markStdoutClosed);
    child.stderr?.once("end", markStderrClosed);
    child.stderr?.once("close", markStderrClosed);
    // A process may have exited before listener registration. ChildProcess
    // normally emits close on a later turn, but this check keeps settlement
    // immediate if exit state is already observable.
    if (child.exitCode !== null) {
      exitObserved = true;
      observedExitCode = child.exitCode;
    } else if (child.signalCode !== null) {
      exitObserved = true;
      observedExitCode = null;
    }
    stdoutClosed ||= outputStreamIsComplete(child.stdout);
    stderrClosed ||= outputStreamIsComplete(child.stderr);
    settleAfterExitAndStreams();
    if (exitObserved) schedulePostExitDrain();
  });
  if (request.signal.aborted) requestTermination("cancelled");
  // All output and terminal listeners are now installed before EOF delivery.
  closeChildStdin(child);
  const exitCode = await exitPromise;
  clearTimeout(timer);
  request.signal.removeEventListener("abort", onAbort);
  return {
    exitCode,
    stdout: boundedText(stdout),
    stderr: boundedText(stderr),
    startedAtMs,
    endedAtMs: Date.now(),
    firstOutputAtMs,
    outputComplete,
    timedOut,
    cancelled,
  };
}

export { canSettleAfterExit, outputStreamIsComplete } from "./command-streams.ts";

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
    .replace(/(?:\/Users\/|\/home\/|[A-Z]:\\)[^\s)"',]+/gu, "[PRIVATE_PATH]")
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
