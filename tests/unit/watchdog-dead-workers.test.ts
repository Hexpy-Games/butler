import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { checkDeadWorkers, type WatchdogDeps } from "../../packages/butler-agent/src/interfaces/mcp-server/watchdog.ts";

let tempDir = "";

beforeEach(() => {
  tempDir = join(tmpdir(), `butler-watchdog-${Date.now()}-${Math.random()}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function deps(input: {
  alivePids?: Set<number>;
  alivePgids?: Set<number>;
  logs?: string[];
} = {}): WatchdogDeps {
  return {
    listDir: (dir) => Array.from(new Set(["task-1"])).filter(() => dir === tempDir),
    fileExists: (path) => {
      try {
        readFileSync(path, "utf8");
        return true;
      } catch {
        return false;
      }
    },
    readFile: (path) => {
      try {
        return readFileSync(path, "utf8").trim();
      } catch {
        return null;
      }
    },
    writeFile: (path, content) => writeFileSync(path, content, "utf8"),
    isPidAlive: (pid) => input.alivePids?.has(pid) ?? false,
    isProcessGroupAlive: (pgid) => input.alivePgids?.has(pgid) ?? false,
    log: (line) => input.logs?.push(line),
  };
}

function writeRunningTask(input: { pid?: number; pgid?: number }): string {
  const taskDir = join(tempDir, "task-1");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "status"), "RUNNING\n", "utf8");
  if (input.pid !== undefined) {
    writeFileSync(join(taskDir, "pid"), `${input.pid}\n`, "utf8");
  }
  if (input.pgid !== undefined) {
    writeFileSync(join(taskDir, "pgid"), `${input.pgid}\n`, "utf8");
  }
  return taskDir;
}

test("watchdog does not mark task failed while dispatch supervisor process group is alive", async () => {
  const taskDir = writeRunningTask({ pid: 111, pgid: 222 });
  const logs: string[] = [];

  const actions = await checkDeadWorkers(tempDir, deps({
    alivePids: new Set(),
    alivePgids: new Set([222]),
    logs,
  }));

  expect(actions).toBe(0);
  expect(readFileSync(join(taskDir, "status"), "utf8").trim()).toBe("RUNNING");
  expect(logs).toEqual([]);
});

test("watchdog marks task recoverable when worker pid and dispatch process group are both dead", async () => {
  const taskDir = writeRunningTask({ pid: 111, pgid: 222 });
  const logs: string[] = [];

  const actions = await checkDeadWorkers(tempDir, deps({
    alivePids: new Set(),
    alivePgids: new Set(),
    logs,
  }));

  expect(actions).toBe(1);
  expect(readFileSync(join(taskDir, "status"), "utf8").trim()).toBe("RECOVERABLE");
  expect(logs[0]).toContain("marked RECOVERABLE");
});

test("watchdog marks task recoverable when dispatch dies before worker pid is recorded", async () => {
  const taskDir = writeRunningTask({ pgid: 222 });
  const logs: string[] = [];

  const actions = await checkDeadWorkers(tempDir, deps({
    alivePgids: new Set(),
    logs,
  }));

  expect(actions).toBe(1);
  expect(readFileSync(join(taskDir, "status"), "utf8").trim()).toBe("RECOVERABLE");
  expect(logs[0]).toContain("before worker PID recorded");
});
