import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { TaskNotificationQueue } from "../../packages/butler-agent/src/agent/work/task-notifications.ts";
import {
  createWorkDashboard,
  performWorkControl,
  renderWorkDashboard,
} from "../../packages/butler-agent/src/agent/work/work-dashboard.ts";
import { onStatusCommand } from "../../packages/butler-agent/src/integrations/telegram/commands/handlers.ts";

let tempDir = "";
let originalButlerData: string | undefined;
let originalButlerHome: string | undefined;
let originalButlerBun: string | undefined;
const root = process.cwd();

beforeEach(() => {
  tempDir = join(tmpdir(), `butler-work-dashboard-${Date.now()}-${Math.random()}`);
  mkdirSync(tempDir, { recursive: true });
  originalButlerData = process.env.BUTLER_DATA;
  originalButlerHome = process.env.BUTLER_HOME;
  originalButlerBun = process.env.BUTLER_BUN;
  process.env.BUTLER_DATA = tempDir;
  process.env.BUTLER_HOME = root;
  process.env.BUTLER_BUN = originalButlerBun ?? "bun";
});

afterEach(() => {
  if (originalButlerData === undefined) delete process.env.BUTLER_DATA;
  else process.env.BUTLER_DATA = originalButlerData;
  if (originalButlerHome === undefined) delete process.env.BUTLER_HOME;
  else process.env.BUTLER_HOME = originalButlerHome;
  if (originalButlerBun === undefined) delete process.env.BUTLER_BUN;
  else process.env.BUTLER_BUN = originalButlerBun;
  rmSync(tempDir, { recursive: true, force: true });
});

function writeTask(taskId: string, input: {
  status: string;
  request?: string;
  result?: string;
  pid?: string;
}): void {
  const taskDir = join(tempDir, "tasks", taskId);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "status"), `${input.status}\n`, "utf8");
  writeFileSync(join(taskDir, "project"), "/tmp/project\n", "utf8");
  if (input.request) writeFileSync(join(taskDir, "request.md"), `${input.request}\n`, "utf8");
  if (input.result) writeFileSync(join(taskDir, "result.md"), `${input.result}\n`, "utf8");
  if (input.pid) writeFileSync(join(taskDir, "pid"), `${input.pid}\n`, "utf8");
}

test("work dashboard projects active, recoverable, failed, report-ready, and delivery state", () => {
  writeTask("task-running-1", {
    status: "RUNNING",
    request: "generate the quarterly chart",
    pid: "123",
  });
  writeTask("task-recoverable-1", {
    status: "RECOVERABLE",
    request: "continue interrupted project audit",
  });
  writeTask("task-failed-1", {
    status: "FAILED",
    request: "run validation",
    result: "EXIT_CODE: 1",
  });
  const queue = new TaskNotificationQueue(tempDir);
  queue.upsert({
    notificationId: "notification-failed-1",
    taskId: "task-failed-1",
    taskStatus: "FAILED",
    text: "failed report",
    status: "failed",
    createdAt: "2026-04-26T00:00:00.000Z",
    lastError: "network down",
    originSummary: "validation failure",
  });

  const dashboard = createWorkDashboard({ butlerData: tempDir, debug: false });

  expect(dashboard.counts).toMatchObject({
    active: 1,
    recoverable: 1,
    failed: 1,
    pendingDelivery: 0,
    failedDelivery: 1,
  });
  expect(dashboard.active[0]?.label).toBe("Work 1");
  expect(dashboard.active[0]).toMatchObject({
    work_mode: "executing",
    safe_to_report: false,
    completion_claim_allowed: false,
  });
  expect(dashboard.active[0]?.guard_reason).toContain("still running");
  expect(dashboard.active[0]?.raw_id).toBeUndefined();
  expect(dashboard.active[0]?.actions.find((action) => action.action === "cancel")?.task_id).toBeUndefined();
  expect(dashboard.recoverable[0]?.actions.find((action) => action.action === "resume")?.enabled).toBe(true);
  expect(dashboard.delivery[0]?.label).toBe("Delivery 1");
  expect(renderWorkDashboard(dashboard)).toContain("active=1 recoverable=1 failed=1");
  expect(renderWorkDashboard(dashboard)).toContain("mode: executing");
  expect(renderWorkDashboard(dashboard)).toContain("guard: Worker is still running");
  expect(renderWorkDashboard(dashboard)).not.toContain("task-running-1");
});

test("work dashboard debug mode exposes operator identifiers", () => {
  writeTask("task-running-debug", {
    status: "RUNNING",
    request: "debug running task",
  });
  const queue = new TaskNotificationQueue(tempDir);
  queue.upsert({
    notificationId: "notification-debug",
    taskId: "task-running-debug",
    taskStatus: "RUNNING",
    text: "pending report",
    status: "pending",
    createdAt: "2026-04-26T00:00:00.000Z",
  });

  const dashboard = createWorkDashboard({ butlerData: tempDir, debug: true });

  expect(dashboard.active[0]?.raw_id).toBe("task-running-debug");
  expect(dashboard.delivery[0]?.raw_id).toBe("notification-debug");
  expect(renderWorkDashboard(dashboard)).toContain("id: task-running-debug");
  expect(renderWorkDashboard(dashboard)).toContain("notification: notification-debug");
});

test("work controls validate state before returning transport-neutral intents", () => {
  writeTask("task-recoverable", {
    status: "RECOVERABLE",
    request: "resume me",
  });
  writeTask("task-done", {
    status: "DONE",
    request: "show result",
    result: "finished cleanly",
  });
  const queue = new TaskNotificationQueue(tempDir);
  queue.upsert({
    notificationId: "notification-failed",
    taskId: "task-done",
    taskStatus: "DONE",
    text: "report",
    status: "failed",
    createdAt: "2026-04-26T00:00:00.000Z",
    lastError: "temporary outage",
  });

  expect(performWorkControl({
    butlerData: tempDir,
    action: "resume",
    taskId: "task-recoverable",
  })).toMatchObject({
    ok: true,
    intent: {
      action: "resume",
      task_id: "task-recoverable",
    },
  });
  expect(performWorkControl({
    butlerData: tempDir,
    action: "resume",
    taskId: "task-done",
  })).toMatchObject({
    ok: false,
    message: "task is DONE; only RECOVERABLE tasks can be resumed",
  });
  expect(performWorkControl({
    butlerData: tempDir,
    action: "view_result",
    taskId: "task-done",
  })).toMatchObject({
    ok: true,
    result: "finished cleanly",
  });
  expect(performWorkControl({
    butlerData: tempDir,
    action: "retry_delivery",
    notificationId: "notification-failed",
  })).toMatchObject({
    ok: true,
    message: "delivery retry queued",
  });
  expect(queue.read("notification-failed")?.status).toBe("pending");
});

test("Telegram status command includes the canonical work dashboard projection", async () => {
  writeTask("task-status-command", {
    status: "RECOVERABLE",
    request: "recover through status command",
  });
  const sent: string[] = [];

  await onStatusCommand({
    sessions: {} as any,
    async sendMessage(_chatId, text) {
      sent.push(text);
    },
  }, {
    chatId: "chat-1",
    userId: "user-1",
  });

  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain("## Work Dashboard");
  expect(sent[0]).toContain("recoverable=1");
  expect(sent[0]).not.toContain("task-status-command");
});
