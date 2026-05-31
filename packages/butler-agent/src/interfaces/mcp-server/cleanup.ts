import { readdirSync, readFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { BUTLER_DIR } from "./constants.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_AGE_DAYS = 30;
const MAX_TASKS = 100;

const DELETABLE_STATUSES = new Set(["DONE", "FAILED"]);

interface TaskEntry {
  id: string;
  epochMs: number;
  status: string;
  dir: string;
}

function readStatus(taskDir: string): string {
  try {
    return readFileSync(join(taskDir, "status"), "utf8").trim();
  } catch {
    return "UNKNOWN";
  }
}

export async function cleanupOldTasks(
  tasksDir: string = BUTLER_DIR.TASKS,
): Promise<{ deletedCount: number }> {
  if (!existsSync(tasksDir)) return { deletedCount: 0 };

  const entries = readdirSync(tasksDir, { withFileTypes: true });
  const tasks: TaskEntry[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const epochMs = Number(entry.name);
    if (isNaN(epochMs)) continue;

    const dir = join(tasksDir, entry.name);
    const status = readStatus(dir);
    tasks.push({ id: entry.name, epochMs, status, dir });
  }

  let deletedCount = 0;
  const now = Date.now();
  const cutoff = now - MAX_AGE_DAYS * DAY_MS;

  // Phase 1: Delete DONE/FAILED tasks older than 30 days
  const remaining: TaskEntry[] = [];
  for (const task of tasks) {
    if (DELETABLE_STATUSES.has(task.status) && task.epochMs < cutoff) {
      rmSync(task.dir, { recursive: true, force: true });
      deletedCount++;
    } else {
      remaining.push(task);
    }
  }

  // Phase 2: If still over 100, delete oldest DONE/FAILED
  if (remaining.length > MAX_TASKS) {
    const deletable = remaining
      .filter((t) => DELETABLE_STATUSES.has(t.status))
      .sort((a, b) => a.epochMs - b.epochMs); // oldest first

    const toDelete = remaining.length - MAX_TASKS;
    for (let i = 0; i < Math.min(toDelete, deletable.length); i++) {
      rmSync(deletable[i]!.dir, { recursive: true, force: true });
      deletedCount++;
    }
  }

  if (deletedCount > 0) {
    console.log(`cleanup: deleted ${deletedCount} old tasks`);
  }

  return { deletedCount };
}
