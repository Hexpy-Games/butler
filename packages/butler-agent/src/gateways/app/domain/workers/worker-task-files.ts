import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PlannedTaskRecord } from "../../../../agent/work/planned-task.ts";
import type { WorkerActivityPhase } from "../../interface/protocol/app-protocol.ts";

export function readTextFile(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

export function writeWorkerActivityProjection(
  taskDir: string,
  phase: WorkerActivityPhase,
  statusLine: string,
): void {
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(
    join(taskDir, "worker_activity.json"),
    `${JSON.stringify({
      phase,
      status_line: statusLine,
      updated_at: new Date().toISOString(),
    })}\n`,
    "utf8",
  );
}

export function parsePositiveInteger(value: string): number | null {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function isNoSuchProcessError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ESRCH",
  );
}

export function workerTaskIdsForPlannedTask(
  record: PlannedTaskRecord,
): string[] {
  return record.attempts
    .map((attempt) =>
      readTextFile(join(record.taskDir, "attempts", attempt, "worker-task-id")),
    )
    .filter(Boolean);
}
