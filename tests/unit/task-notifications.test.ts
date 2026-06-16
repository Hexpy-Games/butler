import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { routeCompletionNotifications } from "../../packages/butler-agent/src/agent/work/completion-router.ts";
import { PlannedTaskStore } from "../../packages/butler-agent/src/agent/work/planned-task.ts";
import { buildTaskOriginContext } from "../../packages/butler-agent/src/agent/work/task-origin.ts";
import {
  TaskNotificationQueue,
  taskNotificationToOutboundAction,
} from "../../packages/butler-agent/src/agent/work/task-notifications.ts";
import { TaskStore } from "../../packages/butler-agent/src/agent/work/task-store.ts";
import { WorkOrchestrationStore } from "../../packages/butler-agent/src/agent/work/work-orchestration.ts";

let tempDir = "";

function writeWorkerCompletionEvidence(taskDir: string): void {
  writeFileSync(join(taskDir, "worker_activity_events.jsonl"), [
    JSON.stringify({
      semantic_phase: "executing",
      action_kind: "edit_file",
      status_line: "Worker wrote the requested deliverable.",
      evidence_refs: ["result.md"],
    }),
    JSON.stringify({
      semantic_phase: "verifying",
      action_kind: "test",
      status_line: "Worker verified the requested deliverable.",
      evidence_refs: ["result.md"],
    }),
  ].join("\n") + "\n", "utf8");
}

beforeEach(() => {
  tempDir = join(tmpdir(), `butler-task-notifications-${Date.now()}-${Math.random()}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

test("task notification queue enqueues one durable result notification", () => {
  const taskDir = join(tempDir, "tasks", "task-1");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "status"), "DONE\n", "utf8");
  writeFileSync(join(taskDir, "request.md"), "run checks\n", "utf8");
  writeFileSync(join(taskDir, "result.md"), "all green\n", "utf8");

  expect(routeCompletionNotifications({ butlerData: tempDir, consumer: "native" }).enqueued).toBe(1);
  expect(routeCompletionNotifications({ butlerData: tempDir, consumer: "native" }).enqueued).toBe(0);

  const queue = new TaskNotificationQueue(tempDir);
  const pending = queue.pending();
  expect(pending).toHaveLength(1);
  expect(pending[0]!.text).toContain("Worker task completed.");
  expect(pending[0]!.text).toContain("all green");
  expect(pending[0]!.text).not.toContain("Task ID:");
  expect(pending[0]!.text).not.toContain("Status:");
  expect(pending[0]!.text).not.toContain("task-1");
  expect(existsSync(queue.path("worker-result-task-1"))).toBe(true);
});

test("completion router claims planned worker results only for the owning consumer", () => {
  const planned = new PlannedTaskStore(tempDir);
  planned.create({
    task_id: "planned-owned-by-app",
    type: "planned",
    goal: "App-owned planned work",
    project: "/tmp/project",
    created_at: "2026-05-16T00:00:00.000Z",
    origin_session_id: "butler/app-owned-session",
    decision_policy: "autonomous",
    acceptance_criteria: ["route by explicit completion owner"],
    verification_commands: [],
    review_policy: "review all criteria",
    repair_policy: { max_attempts: 1, allow_autonomous_repair: true },
    public_report_policy: "brief",
  });
  planned.writeAttemptDispatch("planned-owned-by-app", 1, {
    worker_task_id: "worker-owned-by-app",
    prompt: "do work",
  });
  planned.transition("planned-owned-by-app", "PLANNED_RUNNING");
  for (let index = 0; index < 30; index += 1) {
    planned.create({
      task_id: `zz-noise-${String(index).padStart(2, "0")}`,
      type: "planned",
      goal: "Unrelated planned work",
      project: "/tmp/project",
      created_at: "2026-05-15T00:00:00.000Z",
      origin_session_id: "butler/app-other-session",
      decision_policy: "autonomous",
      acceptance_criteria: ["unrelated"],
      verification_commands: [],
      review_policy: "review all criteria",
      repair_policy: { max_attempts: 0, allow_autonomous_repair: false },
      public_report_policy: "none",
    });
  }

  const workerDir = join(tempDir, "tasks", "worker-owned-by-app");
  mkdirSync(workerDir, { recursive: true });
  writeFileSync(join(workerDir, "status"), "DONE\n", "utf8");
  writeFileSync(join(workerDir, "result.md"), "app evidence\n", "utf8");
  new TaskStore(tempDir).writeOrigin("worker-owned-by-app", buildTaskOriginContext({
    sessionId: "butler/app-owned-session",
    taskSummary: "App-owned worker",
    project: "/tmp/project",
  }));

  expect(routeCompletionNotifications({ butlerData: tempDir, consumer: "native" }).promotions).toEqual([]);
  expect(planned.read("planned-owned-by-app")?.status).toBe("PLANNED_RUNNING");

  const appRoute = routeCompletionNotifications({ butlerData: tempDir, consumer: "app" });
  expect(appRoute.promotions).toEqual([{
    plannedTaskId: "planned-owned-by-app",
    workerTaskId: "worker-owned-by-app",
    attempt: 1,
    reviewEventId: "review-planned-owned-by-app-worker-owned-by-app-attempt-1",
    originSessionId: "butler/app-owned-session",
    status: "WORKER_DONE",
  }]);
  expect(planned.read("planned-owned-by-app")?.status).toBe("WORKER_DONE");
  expect(planned.read("planned-owned-by-app")?.latestResult).toBe("app evidence");
});

test("completion router uses planned task ownership when a repair worker lost origin context", () => {
  const planned = new PlannedTaskStore(tempDir);
  planned.create({
    task_id: "planned-repair-owned-by-app",
    type: "planned",
    goal: "App-owned repair work",
    project: "/tmp/project",
    created_at: "2026-05-18T00:00:00.000Z",
    origin_session_id: "butler/app-project-session",
    decision_policy: "autonomous",
    acceptance_criteria: ["route repair by planned task owner"],
    verification_commands: [],
    review_policy: "review all criteria",
    repair_policy: { max_attempts: 2, allow_autonomous_repair: true },
    public_report_policy: "brief",
  });
  planned.writeAttemptDispatch("planned-repair-owned-by-app", 1, {
    worker_task_id: "worker-repair-lost-origin",
    prompt: "repair work",
  });
  planned.transition("planned-repair-owned-by-app", "PLANNED_RUNNING");

  const workerDir = join(tempDir, "tasks", "worker-repair-lost-origin");
  mkdirSync(workerDir, { recursive: true });
  writeFileSync(join(workerDir, "status"), "DONE\n", "utf8");
  writeFileSync(join(workerDir, "result.md"), "repair evidence from app-owned plan\n", "utf8");

  expect(routeCompletionNotifications({ butlerData: tempDir, consumer: "native" }).promotions).toEqual([]);

  const appRoute = routeCompletionNotifications({ butlerData: tempDir, consumer: "app" });
  expect(appRoute.promotions).toEqual([{
    plannedTaskId: "planned-repair-owned-by-app",
    workerTaskId: "worker-repair-lost-origin",
    attempt: 1,
    reviewEventId: "review-planned-repair-owned-by-app-worker-repair-lost-origin-attempt-1",
    originSessionId: "butler/app-project-session",
    status: "WORKER_DONE",
  }]);
  expect(planned.read("planned-repair-owned-by-app")?.status).toBe("WORKER_DONE");
  expect(planned.read("planned-repair-owned-by-app")?.latestResult).toBe("repair evidence from app-owned plan");
});

test("completion router can correct a stale planned-review claim to the planned task owner", () => {
  const planned = new PlannedTaskStore(tempDir);
  planned.create({
    task_id: "planned-stale-native-claim",
    type: "planned",
    goal: "Recover app-owned plan from stale native claim",
    project: "/tmp/project",
    created_at: "2026-05-18T00:00:00.000Z",
    origin_session_id: "butler/app-project-session",
    decision_policy: "autonomous",
    acceptance_criteria: ["stale native claim does not block app review"],
    verification_commands: [],
    review_policy: "review all criteria",
    repair_policy: { max_attempts: 2, allow_autonomous_repair: true },
    public_report_policy: "brief",
  });
  planned.writeAttemptDispatch("planned-stale-native-claim", 2, {
    worker_task_id: "worker-stale-native-claim",
    prompt: "repair work",
  });
  planned.transition("planned-stale-native-claim", "PLANNED_RUNNING");

  const workerDir = join(tempDir, "tasks", "worker-stale-native-claim");
  mkdirSync(workerDir, { recursive: true });
  writeFileSync(join(workerDir, "status"), "DONE\n", "utf8");
  writeFileSync(join(workerDir, "result.md"), "recovered evidence\n", "utf8");

  const claimDir = join(tempDir, "runtime", "completion-router", "planned-review-claims");
  mkdirSync(claimDir, { recursive: true });
  writeFileSync(join(claimDir, "planned-stale-native-claim-attempt-2.json"), `${JSON.stringify({
    version: 1,
    kind: "planned-review",
    owner: "native",
    planned_task_id: "planned-stale-native-claim",
    worker_task_id: "worker-stale-native-claim",
    attempt: 2,
    claimed_at: "2026-05-18T00:00:00.000Z",
  }, null, 2)}\n`, "utf8");

  const appRoute = routeCompletionNotifications({ butlerData: tempDir, consumer: "app" });
  expect(appRoute.promotions).toEqual([{
    plannedTaskId: "planned-stale-native-claim",
    workerTaskId: "worker-stale-native-claim",
    attempt: 2,
    reviewEventId: "review-planned-stale-native-claim-worker-stale-native-claim-attempt-2",
    originSessionId: "butler/app-project-session",
    status: "WORKER_DONE",
  }]);
  expect(planned.read("planned-stale-native-claim")?.status).toBe("WORKER_DONE");
  expect(planned.read("planned-stale-native-claim")?.latestResult).toBe("recovered evidence");
});

test("completion router does not re-promote a stale repair attempt", () => {
  const planned = new PlannedTaskStore(tempDir);
  planned.create({
    task_id: "planned-repair",
    type: "planned",
    goal: "Repair planned work",
    project: "/tmp/project",
    created_at: "2026-05-16T00:00:00.000Z",
    origin_session_id: "butler/app-owned-session",
    decision_policy: "autonomous",
    acceptance_criteria: ["latest attempt owns completion"],
    verification_commands: [],
    review_policy: "review all criteria",
    repair_policy: { max_attempts: 1, allow_autonomous_repair: true },
    public_report_policy: "brief",
  });
  planned.writeAttemptDispatch("planned-repair", 1, {
    worker_task_id: "worker-attempt-1",
    prompt: "do work",
  });
  planned.transition("planned-repair", "PLANNED_RUNNING");

  const worker1Dir = join(tempDir, "tasks", "worker-attempt-1");
  mkdirSync(worker1Dir, { recursive: true });
  writeFileSync(join(worker1Dir, "status"), "DONE\n", "utf8");
  writeFileSync(join(worker1Dir, "result.md"), "first evidence\n", "utf8");
  new TaskStore(tempDir).writeOrigin("worker-attempt-1", buildTaskOriginContext({
    sessionId: "butler/app-owned-session",
    taskSummary: "First attempt",
    project: "/tmp/project",
  }));

  expect(routeCompletionNotifications({ butlerData: tempDir, consumer: "app" }).promotions).toEqual([{
    plannedTaskId: "planned-repair",
    workerTaskId: "worker-attempt-1",
    attempt: 1,
    reviewEventId: "review-planned-repair-worker-attempt-1-attempt-1",
    originSessionId: "butler/app-owned-session",
    status: "WORKER_DONE",
  }]);
  planned.transition("planned-repair", "REVIEWING");
  planned.transition("planned-repair", "REVIEW_INCONCLUSIVE");
  planned.transition("planned-repair", "REPAIRING");
  planned.writeAttemptDispatch("planned-repair", 2, {
    worker_task_id: "worker-attempt-2",
    prompt: "repair work",
  });
  planned.transition("planned-repair", "PLANNED_RUNNING");

  expect(routeCompletionNotifications({ butlerData: tempDir, consumer: "app" }).promotions).toEqual([]);
  expect(planned.read("planned-repair")?.status).toBe("PLANNED_RUNNING");
  expect(planned.read("planned-repair")?.latestResult).toBeNull();

  const worker2Dir = join(tempDir, "tasks", "worker-attempt-2");
  mkdirSync(worker2Dir, { recursive: true });
  writeFileSync(join(worker2Dir, "status"), "DONE\n", "utf8");
  writeFileSync(join(worker2Dir, "result.md"), "repaired evidence\n", "utf8");
  new TaskStore(tempDir).writeOrigin("worker-attempt-2", buildTaskOriginContext({
    sessionId: "butler/app-owned-session",
    taskSummary: "Repair attempt",
    project: "/tmp/project",
  }));

  expect(routeCompletionNotifications({ butlerData: tempDir, consumer: "app" }).promotions).toEqual([{
    plannedTaskId: "planned-repair",
    workerTaskId: "worker-attempt-2",
    attempt: 2,
    reviewEventId: "review-planned-repair-worker-attempt-2-attempt-2",
    originSessionId: "butler/app-owned-session",
    status: "WORKER_DONE",
  }]);
  expect(planned.read("planned-repair")?.status).toBe("WORKER_DONE");
  expect(planned.read("planned-repair")?.latestResult).toBe("repaired evidence");
});

test("task notification fallback includes origin summary when available", () => {
  const taskDir = join(tempDir, "tasks", "task-origin-done");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "status"), "DONE\n", "utf8");
  writeFileSync(join(taskDir, "request.md"), "make chart\n", "utf8");
  writeFileSync(join(taskDir, "result.md"), "chart ready\n", "utf8");
  writeWorkerCompletionEvidence(taskDir);
  writeFileSync(join(taskDir, "origin.json"), `${JSON.stringify({
    version: 1,
    origin_session_id: "butler/main",
    origin_message_id: "77",
    origin_inbound_event_id: "mock:77",
    task_summary: "topic A chart generation",
    created_at: "2026-04-25T00:00:00.000Z",
    project: "fixtures/butler-project",
    topic_summary: "Topic A",
    transcript_ref: {
      session_id: "butler/main",
      path: "fixtures/butler-data/transcripts/butler_main.jsonl",
      origin_event_id: "mock:77",
      origin_message_id: "77",
      recent_event_ids: ["mock:77"],
    },
    memory_refs: [],
  }, null, 2)}\n`, "utf8");

  expect(routeCompletionNotifications({ butlerData: tempDir, consumer: "native" }).enqueued).toBe(1);
  const notification = new TaskNotificationQueue(tempDir).pending()[0];

  expect(notification?.text).toContain("topic A chart generation");
  expect(notification?.text).toContain("chart ready");
  expect(notification?.text).not.toContain("origin_session");
  expect(notification).toMatchObject({
    originSummary: "topic A chart generation",
    originSessionId: "butler/main",
    originEventId: "mock:77",
  });
});

test("completion router recovers app ownership from linked work orchestration origin", () => {
  const taskDir = join(tempDir, "tasks", "worker-orchestration-originless");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "status"), "DONE\n", "utf8");
  writeFileSync(join(taskDir, "request.md"), "implement stream\n", "utf8");
  writeFileSync(join(taskDir, "result.md"), "stream result ready\n", "utf8");
  writeWorkerCompletionEvidence(taskDir);

  const orchestration = new WorkOrchestrationStore(tempDir);
  orchestration.create({
    id: "orch-app-origin",
    goal: "Coordinate app-origin work",
    originSessionId: "butler/app-project-origin",
    streams: [{
      id: "implementation",
      role: "builder",
      objective: "Implement the app-origin stream",
      acceptance_criteria: ["stream result exists"],
    }],
    now: new Date("2026-06-16T00:00:00.000Z"),
  });
  orchestration.markDispatched("orch-app-origin", [{
    stream_id: "implementation",
    worker_task_id: "worker-orchestration-originless",
  }]);

  expect(routeCompletionNotifications({ butlerData: tempDir, consumer: "native" }).enqueued).toBe(0);
  expect(routeCompletionNotifications({ butlerData: tempDir, consumer: "app" }).enqueued).toBe(1);

  const notification = new TaskNotificationQueue(tempDir).pending()[0];
  expect(notification).toMatchObject({
    taskId: "worker-orchestration-originless",
    originSummary: "Implement the app-origin stream",
    originSessionId: "butler/app-project-origin",
  });
});

test("task notification falls back to user-facing report from worker logs", () => {
  const taskDir = join(tempDir, "tasks", "task-log");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "status"), "FAILED\n", "utf8");
  writeFileSync(join(taskDir, "request.md"), "check tests\n", "utf8");
  writeFileSync(join(taskDir, "log.txt"), [
    "[worker-runner] [2026-04-24 13:50:11] run_shell (Run the project's declared aggregate validation script to determine current test status.): bun run check",
    "[worker-runner] [2026-04-24 13:50:15] run_shell result: exit=0 timed_out=false",
    "[worker-runner] [2026-04-24 13:50:15] stdout:",
    "PASS: native purge gate",
  ].join("\n"), "utf8");

  expect(routeCompletionNotifications({ butlerData: tempDir, consumer: "native" }).enqueued).toBe(1);
  const notification = new TaskNotificationQueue(tempDir).pending()[0];

  expect(notification?.text).toContain("Worker task failed.");
  expect(notification?.text).toContain("Root validation: passed");
  expect(notification?.text).not.toContain("origin_session");
});

test("task notification includes partial worker evidence before backend failure", () => {
  const taskDir = join(tempDir, "tasks", "task-backend-failure");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "status"), "FAILED\n", "utf8");
  writeFileSync(join(taskDir, "request.md"), "inspect Telegram intake\n", "utf8");
  writeFileSync(join(taskDir, "result.md"), "EXIT_CODE: 1\n", "utf8");
  writeFileSync(join(taskDir, "log.txt"), [
    "[worker-runner] [2026-04-24 21:17:02] run_shell (Inspect transport files): rg --files packages/butler-agent/src/interfaces/transport",
    "[worker-runner] [2026-04-24 21:17:03] run_shell result: exit=0 timed_out=false",
    "[worker-runner] [2026-04-24 21:17:03] stdout:",
    "packages/butler-agent/src/interfaces/transport/telegram/live-gateway.ts",
    "packages/butler-agent/src/interfaces/transport/telegram/polling-runner.ts",
    "[worker-runner] [2026-04-24 21:17:29] ERROR: Codex backend error: server_error request ID 64f9065c",
  ].join("\n"), "utf8");

  expect(routeCompletionNotifications({ butlerData: tempDir, consumer: "native" }).enqueued).toBe(1);
  const notification = new TaskNotificationQueue(tempDir).pending()[0];

  expect(notification?.text).toContain("Worker task failed.");
  expect(notification?.text).toContain("Partial successful command");
  expect(notification?.text).toContain("packages/butler-agent/src/interfaces/transport/telegram/live-gateway.ts");
  expect(notification?.text).toContain("server_error request ID 64f9065c");
  expect(notification?.text).not.toContain("No result file or execution log summary was available");
});

test("task notification converts to transport-agnostic outbound action", () => {
  const queue = new TaskNotificationQueue(tempDir);
  const notification = queue.upsert({
    notificationId: "worker-result-task-2",
    taskId: "task-2",
    taskStatus: "FAILED",
    text: "failed",
    status: "pending",
    createdAt: "2026-04-24T00:00:00.000Z",
    originSummary: "Topic A chart",
    originSessionId: "butler/main",
    originEventId: "mock:a",
  });

  expect(taskNotificationToOutboundAction({
    notification,
    transport: "telegram",
    accountId: "default",
    peerKind: "group",
    peerId: "123",
  })).toMatchObject({
    actionId: "task-notification:worker-result-task-2",
    transport: "telegram",
    peer: { kind: "group", id: "123" },
    message: { text: "failed" },
    metadata: {
      originSummary: "Topic A chart",
      originSessionId: "butler/main",
      originEventId: "mock:a",
    },
  });
});

test("task notification queue keeps failed notifications retryable", () => {
  const queue = new TaskNotificationQueue(tempDir);
  queue.upsert({
    notificationId: "worker-result-task-3",
    taskId: "task-3",
    taskStatus: "DONE",
    text: "done",
    status: "pending",
    createdAt: "2026-04-24T00:00:00.000Z",
  });

  queue.markFailed("worker-result-task-3", "temporary");
  expect(queue.pending()).toHaveLength(1);
  expect(queue.pending()[0]!.lastError).toBe("temporary");

  queue.markDelivered("worker-result-task-3", new Date("2026-04-24T00:01:00.000Z"));
  expect(queue.pending()).toHaveLength(0);
  expect(queue.read("worker-result-task-3")?.deliveredAt).toBe("2026-04-24T00:01:00.000Z");
});
