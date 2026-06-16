import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pollWorkerResultsOnce } from "../../packages/butler-agent/src/interfaces/gateway/worker-result-monitor.ts";
import { buildTaskOriginContext } from "../../packages/butler-agent/src/agent/work/task-origin.ts";
import { routeCompletionNotifications } from "../../packages/butler-agent/src/agent/work/completion-router.ts";
import { TaskNotificationQueue } from "../../packages/butler-agent/src/agent/work/task-notifications.ts";
import { TaskStore } from "../../packages/butler-agent/src/agent/work/task-store.ts";
import { PlannedTaskStore } from "../../packages/butler-agent/src/agent/work/planned-task.ts";
import { SessionBindingStore } from "../../packages/butler-agent/src/test-support/harness/session-store.ts";
import { readTranscript } from "../../packages/butler-agent/src/test-support/harness/transcripts.ts";
import { DeliveryGuard } from "../../packages/butler-agent/src/interfaces/transport/delivery-guard.ts";
import { createAppTransportAdapter } from "../../packages/butler-agent/src/interfaces/transport/app/adapter.ts";

let tempDir = "";
let originalButlerData: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "butler-worker-monitor-"));
  originalButlerData = process.env.BUTLER_DATA;
  process.env.BUTLER_DATA = tempDir;
});

afterEach(() => {
  if (originalButlerData === undefined) delete process.env.BUTLER_DATA;
  else process.env.BUTLER_DATA = originalButlerData;
  rmSync(tempDir, { recursive: true, force: true });
});

test("worker result monitor delivers completed task results once", async () => {
  const taskDir = join(tempDir, "tasks", "task-1");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "status"), "DONE\n", "utf8");
  writeFileSync(join(taskDir, "request.md"), "run a quick test\n", "utf8");
  writeFileSync(join(taskDir, "result.md"), "test result ok\n", "utf8");
  writeFileSync(join(taskDir, "worker_activity_events.jsonl"), `${JSON.stringify({
    schema: "butler.worker-activity-event.v1",
    event_id: "ev-test",
    created_at: "2026-04-24T00:00:00.000Z",
    actor: "worker",
    event: "activity_updated",
    semantic_phase: "verifying",
    action_kind: "test",
    status_line: "Verifying: ran the quick test.",
    evidence_refs: ["test-result"],
  })}\n`, "utf8");

  const deliveries: Array<{ chatId: string; text: string }> = [];
  const first = await pollWorkerResultsOnce({
    butlerHome: "fixtures/butler-project",
    butlerData: tempDir,
    sessionId: "butler/main",
    chatId: "123",
    renderNotificationText: async () => "Worker report\nResult: test result ok",
    sendTelegram: async (delivery) => {
      deliveries.push(delivery);
      return { ok: true, transportMessageId: String(deliveries.length) };
    },
  });
  const second = await pollWorkerResultsOnce({
    butlerHome: "fixtures/butler-project",
    butlerData: tempDir,
    sessionId: "butler/main",
    chatId: "123",
    renderNotificationText: async () => "Worker report\nResult: test result ok",
    sendTelegram: async (delivery) => {
      deliveries.push(delivery);
      return { ok: true, transportMessageId: String(deliveries.length) };
    },
  });

  expect(first).toBe(1);
  expect(second).toBe(0);
  expect(deliveries).toHaveLength(1);
  expect(deliveries[0]!.text).toContain("Worker report");
  expect(deliveries[0]!.text).toContain("test result ok");
});

test("worker result monitor delivers app-origin results through app transport", async () => {
  const taskDir = join(tempDir, "tasks", "task-app-origin");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "status"), "DONE\n", "utf8");
  writeFileSync(join(taskDir, "request.md"), "run app-origin work\n", "utf8");
  writeFileSync(join(taskDir, "result.md"), "app result ready\n", "utf8");
  writeFileSync(join(taskDir, "worker_activity_events.jsonl"), `${JSON.stringify({
    schema: "butler.worker-activity-event.v1",
    event_id: "ev-app",
    created_at: "2026-04-24T00:00:00.000Z",
    actor: "worker",
    event: "activity_updated",
    semantic_phase: "executing",
    action_kind: "write_file",
    status_line: "Executing: wrote app-origin worker result.",
    evidence_refs: ["app-result"],
  })}\n`, "utf8");
  new TaskStore(tempDir).writeOrigin("task-app-origin", buildTaskOriginContext({
    sessionId: "butler/app-general",
    taskSummary: "App-origin worker result",
    project: null,
  }));

  const sessionStore = new SessionBindingStore(join(tempDir, "runtime", "session-store.sqlite"));
  sessionStore.upsert({
    sessionId: "butler/app-general",
    role: "butler",
    workspacePath: "/tmp/project",
    runtimeAdapterId: "native-tool-loop",
    modelProviderId: "local",
    modelRef: "local/test",
    lifecycleState: "active",
    transportBindings: [{
      transport: "app",
      accountId: "local",
      peerId: "general",
    }],
  });
  const guard = new DeliveryGuard({ adapters: [createAppTransportAdapter()] });
  const delivered = await pollWorkerResultsOnce({
    butlerHome: "fixtures/butler-project",
    butlerData: tempDir,
    sessionId: "butler/main",
    deliveryTarget: {
      transport: "app",
      accountId: "local",
      peerKind: "dm",
      peerId: "general",
    },
    sessionStore,
    deliverAction: async (sessionId, action, metadata) =>
      await guard.deliver(sessionId, action, metadata),
  });
  sessionStore.close();

  expect(delivered).toBe(1);
  expect(new TaskNotificationQueue(tempDir).pending().map((item) => item.taskId)).toEqual([]);
  const outbound = readTranscript("butler/app-general").find((event) =>
    event.kind === "outbound" &&
    event.transport === "app" &&
    event.payload.metadata &&
    typeof event.payload.metadata === "object" &&
    "kind" in event.payload.metadata &&
    event.payload.metadata.kind === "worker_result",
  );
  expect(outbound?.payload).toMatchObject({
    message: { text: expect.stringContaining("app result ready") },
  });
});

test("worker result monitor reviews app-origin planned work and delivers public report through app transport", async () => {
  const planned = new PlannedTaskStore(tempDir);
  planned.create({
    task_id: "planned-app-review",
    type: "planned",
    goal: "Inspect app project",
    project: tempDir,
    created_at: "2026-05-19T00:00:00.000Z",
    decision_policy: "autonomous",
    acceptance_criteria: ["review worker evidence before reporting"],
    verification_commands: [],
    review_policy: "review all criteria",
    repair_policy: { max_attempts: 1, allow_autonomous_repair: true },
    public_report_policy: "brief reviewed report",
  });
  planned.writeAttemptDispatch("planned-app-review", 1, {
    worker_task_id: "worker-app-review",
    prompt: "do planned work",
  });
  planned.transition("planned-app-review", "PLANNED_RUNNING");

  const workerDir = join(tempDir, "tasks", "worker-app-review");
  mkdirSync(workerDir, { recursive: true });
  writeFileSync(join(workerDir, "status"), "DONE\n", "utf8");
  writeFileSync(join(workerDir, "result.md"), "worker evidence ready\n", "utf8");
  new TaskStore(tempDir).writeOrigin("worker-app-review", buildTaskOriginContext({
    sessionId: "butler/app-general",
    taskSummary: "Safe app worker summary",
    project: null,
  }));

  const sessionStore = new SessionBindingStore(join(tempDir, "runtime", "session-store.sqlite"));
  sessionStore.upsert({
    sessionId: "butler/app-general",
    role: "butler",
    workspacePath: tempDir,
    runtimeAdapterId: "native-tool-loop",
    modelProviderId: "local",
    modelRef: "local/test",
    lifecycleState: "active",
    transportBindings: [{
      transport: "app",
      accountId: "local",
      peerId: "general",
    }],
  });
  const guard = new DeliveryGuard({ adapters: [createAppTransportAdapter()] });
  const delivered = await pollWorkerResultsOnce({
    butlerHome: "fixtures/butler-project",
    butlerData: tempDir,
    sessionId: "butler/main",
    deliveryTarget: {
      transport: "app",
      accountId: "local",
      peerKind: "dm",
      peerId: "general",
    },
    sessionStore,
    handlePlannedTaskReadyForReview: (promotion) => {
      expect(promotion.originSessionId).toBe("butler/app-general");
      planned.transition(promotion.plannedTaskId, "REVIEWING");
      planned.writeReview({
        task_id: promotion.plannedTaskId,
        attempt: promotion.attempt,
        verdict: "PASS",
        reviewed_at: "2026-05-19T00:00:00.000Z",
        criteria: [{
          criterion: "review worker evidence before reporting",
          verdict: "PASS",
          evidence: "worker evidence ready",
        }],
        missing_evidence: [],
        repair_recommendation: null,
      });
      planned.transition(promotion.plannedTaskId, "REVIEW_PASSED");
      planned.writePublicReport(
        promotion.plannedTaskId,
        "검토된 공개 보고입니다.",
      );
      planned.transition(promotion.plannedTaskId, "PUBLIC_REPORT_READY");
    },
    deliverAction: async (sessionId, action, metadata) =>
      await guard.deliver(sessionId, action, metadata),
  });
  sessionStore.close();

  expect(delivered).toBe(1);
  expect(planned.read("planned-app-review")?.status).toBe("REPORTED");
  const outbound = readTranscript("butler/app-general").find((event) =>
    event.kind === "outbound" &&
    event.transport === "app" &&
    JSON.stringify(event.payload).includes("검토된 공개 보고입니다."),
  );
  expect(outbound?.payload).toMatchObject({
    message: { text: "검토된 공개 보고입니다." },
  });
});

test("worker result monitor promotes planned worker completion instead of delivering raw result", async () => {
  const planned = new PlannedTaskStore(tempDir);
  planned.create({
    task_id: "planned-1",
    type: "planned",
    goal: "Review before reporting",
    project: "/tmp/project",
    created_at: "2026-04-25T00:00:00.000Z",
    decision_policy: "autonomous",
    acceptance_criteria: ["review happens before report"],
    verification_commands: [],
    review_policy: "review all criteria",
    repair_policy: { max_attempts: 1, allow_autonomous_repair: true },
    public_report_policy: "brief",
  });
  planned.writeAttemptDispatch("planned-1", 1, {
    worker_task_id: "worker-linked",
    prompt: "execute planned work",
  });
  planned.transition("planned-1", "PLANNED_RUNNING");

  const workerDir = join(tempDir, "tasks", "worker-linked");
  mkdirSync(workerDir, { recursive: true });
  writeFileSync(join(workerDir, "status"), "DONE\n", "utf8");
  writeFileSync(join(workerDir, "result.md"), "raw planned worker result\n", "utf8");

  const deliveries: string[] = [];
  const promotions: string[] = [];
  const delivered = await pollWorkerResultsOnce({
    butlerHome: "fixtures/butler-project",
    butlerData: tempDir,
    sessionId: "butler/main",
    chatId: "123",
    sendTelegram: async (delivery) => {
      deliveries.push(delivery.text);
      return { ok: true, transportMessageId: "1" };
    },
    handlePlannedTaskReadyForReview: async (promotion) => {
      promotions.push(`${promotion.plannedTaskId}:${promotion.workerTaskId}:${promotion.status}`);
    },
  });

  const record = planned.read("planned-1");
  expect(delivered).toBe(0);
  expect(deliveries).toEqual([]);
  expect(promotions).toEqual(["planned-1:worker-linked:WORKER_DONE"]);
  expect(record?.status).toBe("WORKER_DONE");
  expect(record?.latestResult).toBe("raw planned worker result");
});

test("worker result monitor does not promote planned implementation work from planning-only evidence", async () => {
  const planned = new PlannedTaskStore(tempDir);
  planned.create({
    task_id: "planned-planning-only",
    type: "planned",
    goal: "Implement before reporting",
    project: "/tmp/project",
    created_at: "2026-04-25T00:00:00.000Z",
    decision_policy: "autonomous",
    acceptance_criteria: ["implementation evidence exists"],
    verification_commands: [],
    review_policy: "review all criteria",
    repair_policy: { max_attempts: 1, allow_autonomous_repair: true },
    public_report_policy: "brief",
  });
  planned.writeAttemptDispatch("planned-planning-only", 1, {
    worker_task_id: "worker-planning-only",
    prompt: "execute planned work",
  });
  planned.transition("planned-planning-only", "PLANNED_RUNNING");

  const workerDir = join(tempDir, "tasks", "worker-planning-only");
  mkdirSync(workerDir, { recursive: true });
  writeFileSync(join(workerDir, "request.md"), "Implement the planned change.\n", "utf8");
  writeFileSync(join(workerDir, "status"), "DONE\n", "utf8");
  writeFileSync(join(workerDir, "result.md"), "I inspected the repository and prepared the implementation plan.\n", "utf8");
  writeFileSync(join(workerDir, "worker_activity_events.jsonl"), `${JSON.stringify({
    schema: "butler.worker-activity-event.v1",
    event_id: "ev-plan",
    created_at: "2026-04-25T00:00:00.000Z",
    actor: "worker",
    event: "activity_updated",
    semantic_phase: "planning",
    action_kind: "plan",
    status_line: "Planning: identified files to edit.",
  })}\n`, "utf8");

  const promotions: string[] = [];
  const delivered = await pollWorkerResultsOnce({
    butlerHome: "fixtures/butler-project",
    butlerData: tempDir,
    sessionId: "butler/main",
    chatId: "123",
    handlePlannedTaskReadyForReview: async (promotion) => {
      promotions.push(`${promotion.plannedTaskId}:${promotion.workerTaskId}:${promotion.status}`);
    },
  });

  expect(delivered).toBe(0);
  expect(promotions).toEqual([]);
  expect(planned.read("planned-planning-only")?.status).toBe("PLANNED_RUNNING");
  expect(new TaskStore(tempDir).reportableTasks().map((task) => task.taskId)).not.toContain("worker-planning-only");
});

test("native worker result monitor leaves app-origin planned reviews for the app server", async () => {
  const planned = new PlannedTaskStore(tempDir);
  planned.create({
    task_id: "planned-app-origin-review",
    type: "planned",
    goal: "Review app-origin planned work",
    project: "/tmp/project",
    created_at: "2026-05-16T00:00:00.000Z",
    decision_policy: "autonomous",
    acceptance_criteria: ["app server owns review"],
    verification_commands: [],
    review_policy: "review all criteria",
    repair_policy: { max_attempts: 1, allow_autonomous_repair: true },
    public_report_policy: "brief",
  });
  planned.writeAttemptDispatch("planned-app-origin-review", 1, {
    worker_task_id: "worker-app-origin-review",
    prompt: "execute planned work",
  });
  planned.transition("planned-app-origin-review", "PLANNED_RUNNING");

  const workerDir = join(tempDir, "tasks", "worker-app-origin-review");
  mkdirSync(workerDir, { recursive: true });
  writeFileSync(join(workerDir, "status"), "DONE\n", "utf8");
  writeFileSync(join(workerDir, "result.md"), "app-origin planned evidence\n", "utf8");
  new TaskStore(tempDir).writeOrigin("worker-app-origin-review", buildTaskOriginContext({
    sessionId: "butler/app-project-live",
    taskSummary: "App-origin planned worker",
    project: "project-live",
  }));

  const promotions: string[] = [];
  const delivered = await pollWorkerResultsOnce({
    butlerHome: "fixtures/butler-project",
    butlerData: tempDir,
    sessionId: "butler/main",
    chatId: "123",
    sendTelegram: async () => ({ ok: true, transportMessageId: "1" }),
    handlePlannedTaskReadyForReview: async (promotion) => {
      promotions.push(`${promotion.plannedTaskId}:${promotion.workerTaskId}`);
    },
  });

  const record = planned.read("planned-app-origin-review");
  expect(delivered).toBe(0);
  expect(promotions).toEqual([]);
  expect(record?.status).toBe("PLANNED_RUNNING");
  expect(record?.latestResult).toBeNull();
});

test("worker result monitor times out stalled planned review callbacks", async () => {
  const planned = new PlannedTaskStore(tempDir);
  planned.create({
    task_id: "planned-timeout",
    type: "planned",
    goal: "Timeout review callback",
    project: "/tmp/project",
    created_at: "2026-04-25T00:00:00.000Z",
    decision_policy: "autonomous",
    acceptance_criteria: ["callback timeout is bounded"],
    verification_commands: [],
    review_policy: "review all criteria",
    repair_policy: { max_attempts: 1, allow_autonomous_repair: true },
    public_report_policy: "brief",
  });
  planned.writeAttemptDispatch("planned-timeout", 1, {
    worker_task_id: "worker-timeout",
    prompt: "execute planned work",
  });
  planned.transition("planned-timeout", "PLANNED_RUNNING");

  const workerDir = join(tempDir, "tasks", "worker-timeout");
  mkdirSync(workerDir, { recursive: true });
  writeFileSync(join(workerDir, "status"), "DONE\n", "utf8");
  writeFileSync(join(workerDir, "result.md"), "done\n", "utf8");

  await expect(pollWorkerResultsOnce({
    butlerHome: "fixtures/butler-project",
    butlerData: tempDir,
    sessionId: "butler/main",
    chatId: "123",
    plannedReviewCallbackTimeoutMs: 1,
    handlePlannedTaskReadyForReview: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
  })).rejects.toThrow("planned review callback timed out");
});

test("worker result monitor does not re-promote the same planned review after callback timeout", async () => {
  const planned = new PlannedTaskStore(tempDir);
  planned.create({
    task_id: "planned-timeout-once",
    type: "planned",
    goal: "Timeout review callback once",
    project: "/tmp/project",
    created_at: "2026-05-24T00:00:00.000Z",
    decision_policy: "autonomous",
    acceptance_criteria: ["review callback is not duplicated"],
    verification_commands: [],
    review_policy: "review all criteria",
    repair_policy: { max_attempts: 1, allow_autonomous_repair: true },
    public_report_policy: "brief",
  });
  planned.writeAttemptDispatch("planned-timeout-once", 1, {
    worker_task_id: "worker-timeout-once",
    prompt: "execute planned work",
  });
  planned.transition("planned-timeout-once", "PLANNED_RUNNING");

  const workerDir = join(tempDir, "tasks", "worker-timeout-once");
  mkdirSync(workerDir, { recursive: true });
  writeFileSync(join(workerDir, "status"), "DONE\n", "utf8");
  writeFileSync(join(workerDir, "result.md"), "done\n", "utf8");

  const promotions: string[] = [];
  await expect(pollWorkerResultsOnce({
    butlerHome: "fixtures/butler-project",
    butlerData: tempDir,
    sessionId: "butler/main",
    chatId: "123",
    plannedReviewCallbackTimeoutMs: 1,
    handlePlannedTaskReadyForReview: async (promotion) => {
      promotions.push(`${promotion.plannedTaskId}:${promotion.workerTaskId}:${promotion.attempt}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
  })).rejects.toThrow("planned review callback timed out");

  const second = await pollWorkerResultsOnce({
    butlerHome: "fixtures/butler-project",
    butlerData: tempDir,
    sessionId: "butler/main",
    chatId: "123",
    plannedReviewCallbackTimeoutMs: 1,
    handlePlannedTaskReadyForReview: async (promotion) => {
      promotions.push(`${promotion.plannedTaskId}:${promotion.workerTaskId}:${promotion.attempt}`);
    },
  });

  expect(second).toBe(0);
  expect(promotions).toEqual(["planned-timeout-once:worker-timeout-once:1"]);
  expect(planned.read("planned-timeout-once")?.status).toBe("WORKER_DONE");
});

test("worker result monitor delivers planned public reports without raw worker rendering", async () => {
  const planned = new PlannedTaskStore(tempDir);
  planned.create({
    task_id: "planned-report",
    type: "planned",
    goal: "Deliver final report",
    project: "/tmp/project",
    created_at: "2026-04-25T00:00:00.000Z",
    decision_policy: "autonomous",
    acceptance_criteria: ["report is reviewed"],
    verification_commands: [],
    review_policy: "review all criteria",
    repair_policy: { max_attempts: 1, allow_autonomous_repair: true },
    public_report_policy: "brief",
  });
  planned.transition("planned-report", "PLANNED_RUNNING");
  planned.writeAttemptResult("planned-report", 1, "raw worker result");
  planned.transition("planned-report", "WORKER_DONE");
  planned.transition("planned-report", "REVIEWING");
  planned.writeReview({
    task_id: "planned-report",
    attempt: 1,
    verdict: "PASS",
    reviewed_at: "2026-04-25T00:00:00.000Z",
    criteria: [{ criterion: "report is reviewed", verdict: "PASS", evidence: "reviewed" }],
    missing_evidence: [],
    repair_recommendation: null,
  });
  planned.transition("planned-report", "REVIEW_PASSED");
  planned.writePublicReport("planned-report", "Final reviewed report");
  planned.transition("planned-report", "PUBLIC_REPORT_READY");

  const deliveries: string[] = [];
  const delivered = await pollWorkerResultsOnce({
    butlerHome: "fixtures/butler-project",
    butlerData: tempDir,
    sessionId: "butler/main",
    chatId: "123",
    renderNotificationText: async () => {
      throw new Error("planned public reports must not be rendered from raw worker completion");
    },
    sendTelegram: async (delivery) => {
      deliveries.push(delivery.text);
      return { ok: true, transportMessageId: "1" };
    },
  });

  expect(delivered).toBe(1);
  expect(deliveries).toEqual(["Final reviewed report"]);
  expect(planned.read("planned-report")?.status).toBe("REPORTED");
});

test("planned app reports recover delivered notifications that lacked app origin", () => {
  const planned = new PlannedTaskStore(tempDir);
  planned.create({
    task_id: "planned-app-report-recover",
    type: "planned",
    goal: "Recover app report",
    project: "/tmp/project",
    created_at: "2026-05-15T00:00:00.000Z",
    decision_policy: "autonomous",
    acceptance_criteria: ["report is reviewed"],
    verification_commands: [],
    review_policy: "review all criteria",
    repair_policy: { max_attempts: 1, allow_autonomous_repair: true },
    public_report_policy: "brief",
  });
  planned.writeAttemptDispatch("planned-app-report-recover", 1, {
    worker_task_id: "worker-app-report-recover",
    prompt: "run worker",
  });
  planned.transition("planned-app-report-recover", "PLANNED_RUNNING");
  planned.writeAttemptResult("planned-app-report-recover", 1, "worker evidence");
  planned.transition("planned-app-report-recover", "WORKER_DONE");
  planned.transition("planned-app-report-recover", "REVIEWING");
  planned.writeReview({
    task_id: "planned-app-report-recover",
    attempt: 1,
    verdict: "PASS",
    reviewed_at: "2026-05-15T00:00:00.000Z",
    criteria: [{ criterion: "report is reviewed", verdict: "PASS", evidence: "reviewed" }],
    missing_evidence: [],
    repair_recommendation: null,
  });
  planned.transition("planned-app-report-recover", "REVIEW_PASSED");
  planned.writePublicReport("planned-app-report-recover", "Reviewed app report");
  planned.transition("planned-app-report-recover", "PUBLIC_REPORT_READY");

  const workerDir = join(tempDir, "tasks", "worker-app-report-recover");
  mkdirSync(workerDir, { recursive: true });
  writeFileSync(join(workerDir, "status"), "DONE\n", "utf8");
  new TaskStore(tempDir).writeOrigin("worker-app-report-recover", buildTaskOriginContext({
    sessionId: "butler/app-project-app-report",
    taskSummary: "Recover app report",
    project: "project-app-report",
  }));

  const queue = new TaskNotificationQueue(tempDir);
  queue.upsert({
    notificationId: "planned-report-planned-app-report-recover",
    taskId: "planned-app-report-recover",
    taskStatus: "REVIEWED",
    text: "Reviewed app report",
    status: "delivered",
    createdAt: "2026-05-15T00:00:00.000Z",
    deliveredAt: "2026-05-15T00:00:01.000Z",
  });
  new TaskStore(tempDir).markResultNotified("planned-app-report-recover", new Date("2026-05-15T00:00:01.000Z"));

  expect(routeCompletionNotifications({ butlerData: tempDir, consumer: "app" }).enqueued).toBe(1);
  expect(queue.read("planned-report-planned-app-report-recover")).toMatchObject({
    status: "pending",
    originSessionId: "butler/app-project-app-report",
  });
});

test("worker result monitor records delivery failure and retries the same planned report", async () => {
  const planned = new PlannedTaskStore(tempDir);
  planned.create({
    task_id: "planned-retry-report",
    type: "planned",
    goal: "Retry final report",
    project: "/tmp/project",
    created_at: "2026-04-25T00:00:00.000Z",
    decision_policy: "autonomous",
    acceptance_criteria: ["delivery can be retried"],
    verification_commands: [],
    review_policy: "review all criteria",
    repair_policy: { max_attempts: 1, allow_autonomous_repair: true },
    public_report_policy: "brief",
  });
  planned.transition("planned-retry-report", "PLANNED_RUNNING");
  planned.writeAttemptResult("planned-retry-report", 1, "raw result");
  planned.transition("planned-retry-report", "WORKER_DONE");
  planned.transition("planned-retry-report", "REVIEWING");
  planned.writeReview({
    task_id: "planned-retry-report",
    attempt: 1,
    verdict: "PASS",
    reviewed_at: "2026-04-25T00:00:00.000Z",
    criteria: [{ criterion: "delivery can be retried", verdict: "PASS", evidence: "reviewed" }],
    missing_evidence: [],
    repair_recommendation: null,
  });
  planned.transition("planned-retry-report", "REVIEW_PASSED");
  planned.writePublicReport("planned-retry-report", "Reviewed report that must survive a failed delivery");
  planned.transition("planned-retry-report", "PUBLIC_REPORT_READY");

  let attempts = 0;
  const first = await pollWorkerResultsOnce({
    butlerHome: "fixtures/butler-project",
    butlerData: tempDir,
    sessionId: "butler/main",
    deliveryTarget: { transport: "mock", accountId: "default", peerKind: "dm", peerId: "user" },
    deliverAction: async () => {
      attempts += 1;
      return { ok: false, error: "Telegram Bad Request: message is too long" };
    },
  });

  const queue = new TaskNotificationQueue(tempDir);
  const failed = queue.read("planned-report-planned-retry-report");
  expect(first).toBe(0);
  expect(attempts).toBe(1);
  expect(failed?.status).toBe("failed");
  expect(failed?.lastError).toContain("message is too long");

  const deliveries: string[] = [];
  const second = await pollWorkerResultsOnce({
    butlerHome: "fixtures/butler-project",
    butlerData: tempDir,
    sessionId: "butler/main",
    deliveryTarget: { transport: "mock", accountId: "default", peerKind: "dm", peerId: "user" },
    deliverAction: async (_sessionId, action) => {
      attempts += 1;
      deliveries.push(action.message.text ?? "");
      return { ok: true, transportMessageId: "retry-1" };
    },
  });
  const third = await pollWorkerResultsOnce({
    butlerHome: "fixtures/butler-project",
    butlerData: tempDir,
    sessionId: "butler/main",
    deliveryTarget: { transport: "mock", accountId: "default", peerKind: "dm", peerId: "user" },
    deliverAction: async () => {
      throw new Error("delivered notifications must not be retried");
    },
  });

  const delivered = queue.read("planned-report-planned-retry-report");
  expect(second).toBe(1);
  expect(third).toBe(0);
  expect(attempts).toBe(2);
  expect(deliveries).toEqual(["Reviewed report that must survive a failed delivery"]);
  expect(delivered?.status).toBe("delivered");
  expect(delivered?.lastError).toBeUndefined();
});

test("worker result monitor finds planned public reports beyond the first 25 task ids", async () => {
  for (let index = 0; index < 30; index += 1) {
    const taskDir = join(tempDir, "tasks", `task-z-${String(index).padStart(2, "0")}`);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status"), "RUNNING\n", "utf8");
  }

  const planned = new PlannedTaskStore(tempDir);
  planned.create({
    task_id: "task-a-planned-report",
    type: "planned",
    goal: "Deliver old report",
    project: "/tmp/project",
    created_at: "2026-04-25T00:00:00.000Z",
    decision_policy: "autonomous",
    acceptance_criteria: ["old report is still delivered"],
    verification_commands: [],
    review_policy: "review all criteria",
    repair_policy: { max_attempts: 1, allow_autonomous_repair: true },
    public_report_policy: "brief",
  });
  planned.transition("task-a-planned-report", "PLANNED_RUNNING");
  planned.writeAttemptResult("task-a-planned-report", 1, "done");
  planned.transition("task-a-planned-report", "WORKER_DONE");
  planned.transition("task-a-planned-report", "REVIEWING");
  planned.writeReview({
    task_id: "task-a-planned-report",
    attempt: 1,
    verdict: "PASS",
    reviewed_at: "2026-04-25T00:00:00.000Z",
    criteria: [{ criterion: "old report is still delivered", verdict: "PASS", evidence: "reviewed" }],
    missing_evidence: [],
    repair_recommendation: null,
  });
  planned.transition("task-a-planned-report", "REVIEW_PASSED");
  planned.writePublicReport("task-a-planned-report", "Old planned report");
  planned.transition("task-a-planned-report", "PUBLIC_REPORT_READY");

  const deliveries: string[] = [];
  const delivered = await pollWorkerResultsOnce({
    butlerHome: "fixtures/butler-project",
    butlerData: tempDir,
    sessionId: "butler/main",
    chatId: "123",
    sendTelegram: async (delivery) => {
      deliveries.push(delivery.text);
      return { ok: true, transportMessageId: String(deliveries.length) };
    },
  });

  expect(delivered).toBe(1);
  expect(deliveries).toEqual(["Old planned report"]);
});
