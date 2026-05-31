import { writeFile, unlink } from "fs/promises";
import { existsSync, writeFileSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawn } from "child_process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { cleanupOldTasks } from "./cleanup.ts";
import { BUTLER_DIR } from "./constants.js";
import { butlerAgentSourcePath } from "../../runtime/paths.ts";

const DEFAULT_LOCK_FILE = "/tmp/butler-watcher.lock";

export function acquireLock(lockFile: string = DEFAULT_LOCK_FILE): boolean {
  if (existsSync(lockFile)) {
    try {
      const pid = parseInt(readFileSync(lockFile, "utf8").trim(), 10);
      if (!isNaN(pid)) {
        try {
          process.kill(pid, 0);
          console.log(`watcher: already running (PID ${pid}), skipping`);
          return false;
        } catch {
          console.log(`watcher: stale lock for PID ${pid}, taking over`);
        }
      }
    } catch {}
  }
  writeFileSync(lockFile, String(process.pid), "utf8");
  return true;
}

export function releaseLock(lockFile: string = DEFAULT_LOCK_FILE): void {
  try { unlinkSync(lockFile); } catch {}
}

export async function saveMemory(taskId: string, project: string, summary: string): Promise<void> {
  const sessionId = taskId;

  const saveHot = spawn(process.execPath, [
    "run",
    butlerAgentSourcePath(BUTLER_DIR.HOME, "agent", "cognition", "memory", "scripts", "save_hot.ts"),
    "--project", project,
    "--session-id", sessionId,
  ]);
  saveHot.stdin.write(summary);
  saveHot.stdin.end();
  saveHot.on("error", (err) => console.error("save_hot error:", err));
  saveHot.stderr.on("data", (data) => console.error("save_hot stderr:", data.toString()));

  const tmpMd = join(tmpdir(), `butler_index_${taskId}.md`);
  await writeFile(tmpMd, summary, "utf8");
  const indexer = spawn(process.execPath, [
    "run",
    butlerAgentSourcePath(BUTLER_DIR.HOME, "agent", "cognition", "memory", "scripts", "index.ts"),
    "--file", tmpMd,
    "--project", project,
    "--session-id", sessionId,
    "--type", "summary",
  ]);
  indexer.on("error", (err) => console.error("index.ts error:", err));
  indexer.on("close", () => unlink(tmpMd).catch(() => {}));
}

export type TaskEvent = {
  type: "task/done" | "task/failed";
  taskId: string;
  project: string;
  status: string;
};

type EventCallback = (event: TaskEvent) => void;

export function startWatcher(_server: McpServer, _onEvent: EventCallback): () => void {
  if (!acquireLock()) {
    console.log("watcher: singleton lock held by another process, not starting");
    return () => {};
  }

  process.on("exit", () => releaseLock());
  process.on("SIGINT", () => { releaseLock(); process.exit(0); });
  process.on("SIGTERM", () => { releaseLock(); process.exit(0); });

  // Cleanup old completed tasks on startup
  cleanupOldTasks().catch(err => {
    console.error("cleanup: failed:", err);
  });

  return () => {};
}
