import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const APP_FOREGROUND_EXECUTOR_READINESS_SCHEMA =
  "butler.app-foreground-executor-readiness.v1";

interface AppForegroundExecutorReadinessRecord {
  schema: typeof APP_FOREGROUND_EXECUTOR_READINESS_SCHEMA;
  pid: number;
  readyAt: string;
  rawTextIncluded: false;
}

export interface AppForegroundExecutorReadiness {
  ready: boolean;
  pid: number | null;
  readyAt: string | null;
}

export function appForegroundExecutorReadinessPath(butlerData: string): string {
  return join(butlerData, "state", "app-foreground", "executor-ready.json");
}

export function publishAppForegroundExecutorReadiness(
  butlerData: string,
  input: { pid?: number; now?: () => Date } = {},
): void {
  const pid = input.pid ?? process.pid;
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error("App foreground executor PID is invalid");
  }
  const path = appForegroundExecutorReadinessPath(butlerData);
  const record: AppForegroundExecutorReadinessRecord = {
    schema: APP_FOREGROUND_EXECUTOR_READINESS_SCHEMA,
    pid,
    readyAt: (input.now ?? (() => new Date()))().toISOString(),
    rawTextIncluded: false,
  };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function clearAppForegroundExecutorReadiness(
  butlerData: string,
  pid = process.pid,
): void {
  const record = readRecord(appForegroundExecutorReadinessPath(butlerData));
  if (record?.pid === pid) {
    rmSync(appForegroundExecutorReadinessPath(butlerData), { force: true });
  }
}

export function readAppForegroundExecutorReadiness(
  butlerData: string,
  isPidRunning: (pid: number) => boolean = defaultIsPidRunning,
): AppForegroundExecutorReadiness {
  const record = readRecord(appForegroundExecutorReadinessPath(butlerData));
  if (!record || !isPidRunning(record.pid)) {
    return { ready: false, pid: null, readyAt: null };
  }
  return { ready: true, pid: record.pid, readyAt: record.readyAt };
}

function readRecord(path: string): AppForegroundExecutorReadinessRecord | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<AppForegroundExecutorReadinessRecord>;
    if (
      value.schema !== APP_FOREGROUND_EXECUTOR_READINESS_SCHEMA ||
      !Number.isInteger(value.pid) ||
      Number(value.pid) <= 0 ||
      typeof value.readyAt !== "string" ||
      value.rawTextIncluded !== false
    ) {
      return null;
    }
    return value as AppForegroundExecutorReadinessRecord;
  } catch {
    return null;
  }
}

function defaultIsPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
