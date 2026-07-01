import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAppServer } from "../../packages/butler-agent/src/gateways/app/interface/server/create-app-server.ts";
import { WorkStreamStore } from "../../packages/butler-agent/src/agent/work/work-stream.ts";

let tempDir = "";

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "butler-app-worker-cancel-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  expect(response.status).toBeGreaterThanOrEqual(200);
  expect(response.status).toBeLessThan(300);
  return json as T;
}

function runningTask(taskId: string): void {
  const taskDir = join(tempDir, "tasks", taskId);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "status"), "RUNNING\n", "utf8");
  writeFileSync(join(taskDir, "request.md"), `Run ${taskId}\n`, "utf8");
}

test("worker cancel closes linked work stream and sibling worker tasks", async () => {
  runningTask("main-cancel");
  runningTask("sibling-cancel");
  const workStreams = new WorkStreamStore(tempDir);
  const stream = workStreams.updateFromTodoList({
    ownerSessionId: "session-a",
    listId: "cancel-flow",
    items: [
      {
        id: "execute",
        content: "Execute linked workers",
        active_form: "Executing linked workers",
        status: "in_progress",
        phase: "execution",
        priority: "normal",
        blocked_by: [],
        note: null,
        created_at: "2026-06-05T00:00:00.000Z",
        updated_at: "2026-06-05T00:00:00.000Z",
        completed_at: null,
      },
    ],
  });
  workStreams.link({
    id: stream.id,
    workerTaskIds: ["main-cancel", "sibling-cancel"],
  });

  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
  });
  try {
    const control = await postJson<{
      data: {
        worker: {
          worker_id: string;
          phase: string;
          terminal: boolean;
          supported_controls: string[];
        };
      };
    }>(
      `${server.url}worker-activity/worker-main-cancel/control`,
      { action: "cancel" },
    );

    expect(control.data.worker).toMatchObject({
      worker_id: "worker-main-cancel",
      phase: "cancelled",
      terminal: true,
      supported_controls: [],
    });
    expect(readFileSync(join(tempDir, "tasks", "main-cancel", "status"), "utf8").trim())
      .toBe("KILLED");
    expect(readFileSync(join(tempDir, "tasks", "sibling-cancel", "status"), "utf8").trim())
      .toBe("KILLED");
    expect(workStreams.read(stream.id)).toMatchObject({
      state: "cancelled",
      linked_worker_task_ids: ["main-cancel", "sibling-cancel"],
    });
    expect(workStreams.list({ sessionId: "session-a" })).toEqual([]);
  } finally {
    server.stop();
  }
});
