import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type {
  CommandExecutor,
  CommandRequest,
  CommandResult,
} from "./contracts.ts";

interface BackgroundCommandEntry {
  controller: AbortController;
  startedAt: number;
  monitor?: ReturnType<typeof setInterval>;
  heartbeatFile?: string;
}

export interface BackgroundCommandControlPaths {
  cancellationFile: string;
  heartbeatFile: string;
}

const activeCommands = new Map<string, BackgroundCommandEntry>();

export function startRegisteredBackgroundCommand(input: {
  id: string;
  executor: CommandExecutor;
  request: Omit<CommandRequest, "signal">;
  control?: BackgroundCommandControlPaths;
  onSettled?: (result: CommandResult) => void | Promise<void>;
}): void {
  if (activeCommands.has(input.id)) {
    throw new Error(`background command is already active: ${input.id}`);
  }
  const controller = new AbortController();
  const entry: BackgroundCommandEntry = {
    controller,
    startedAt: Date.now(),
    heartbeatFile: input.control?.heartbeatFile,
  };
  if (input.control) {
    prepareBackgroundCommandControl(input.control);
    let lastHeartbeatAt = 0;
    const monitor = () => {
      try {
        const now = Date.now();
        if (now - lastHeartbeatAt >= 1_000) {
          writeFileSync(input.control!.heartbeatFile, `${new Date(now).toISOString()}\n`, "utf8");
          lastHeartbeatAt = now;
        }
        if (existsSync(input.control!.cancellationFile)) controller.abort();
      } catch {
        // Durable control polling must not crash the execution owner.
      }
    };
    monitor();
    entry.monitor = setInterval(monitor, 100);
    entry.monitor.unref?.();
  }
  activeCommands.set(input.id, entry);
  void input.executor.execute({
    ...input.request,
    signal: controller.signal,
  }).catch((): CommandResult => ({
    stdout: "",
    stderr: "",
    exitCode: null,
    timedOut: false,
    cancelled: controller.signal.aborted,
    durationMs: Math.max(0, Date.now() - (activeCommands.get(input.id)?.startedAt ?? Date.now())),
    error: {
      code: "background_command_failed",
      message: "background command execution failed",
    },
  })).then(async (result) => {
    if (input.onSettled) await input.onSettled(result);
  }).finally(() => {
    const active = activeCommands.get(input.id);
    if (active?.monitor) clearInterval(active.monitor);
    if (active?.heartbeatFile) rmSync(active.heartbeatFile, { force: true });
    activeCommands.delete(input.id);
  }).catch(() => {
    // Background completion hooks are durable-state best effort.
  });
}

export function cancelRegisteredBackgroundCommand(id: string): boolean {
  const entry = activeCommands.get(id);
  if (!entry) return false;
  entry.controller.abort();
  return true;
}

export function isRegisteredBackgroundCommandActive(id: string): boolean {
  return activeCommands.has(id);
}

export function registeredBackgroundCommandCount(): number {
  return activeCommands.size;
}

export function backgroundCommandControlPaths(
  butlerData: string,
  id: string,
): BackgroundCommandControlPaths {
  if (!/^[a-z0-9][a-z0-9._-]{0,191}$/iu.test(id)) {
    throw new Error("invalid background command id");
  }
  const taskDir = join(butlerData, "tasks", id);
  return {
    cancellationFile: join(taskDir, "execution-cancel.requested"),
    heartbeatFile: join(taskDir, "execution-heartbeat"),
  };
}

export function requestBackgroundCommandCancellation(input: {
  butlerData: string;
  id: string;
}): boolean {
  const control = backgroundCommandControlPaths(input.butlerData, input.id);
  const active = cancelRegisteredBackgroundCommand(input.id);
  const taskDir = join(input.butlerData, "tasks", input.id);
  const status = readText(join(taskDir, "status"));
  if (!active && status !== "RUNNING" && status !== "PENDING") return false;
  mkdirSync(dirname(control.cancellationFile), { recursive: true });
  const temporary = `${control.cancellationFile}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${new Date().toISOString()}\n`, "utf8");
  renameSync(temporary, control.cancellationFile);
  return true;
}

export function hasFreshBackgroundCommandHeartbeat(
  butlerData: string,
  id: string,
  now = Date.now(),
): boolean {
  try {
    const heartbeat = backgroundCommandControlPaths(butlerData, id).heartbeatFile;
    return now - statSync(heartbeat).mtimeMs <= 5_000;
  } catch {
    return false;
  }
}

function prepareBackgroundCommandControl(control: BackgroundCommandControlPaths): void {
  mkdirSync(dirname(control.heartbeatFile), { recursive: true });
  rmSync(control.cancellationFile, { force: true });
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}
