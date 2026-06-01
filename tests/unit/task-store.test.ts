import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  appendTranscriptEvent,
  createTranscriptEvent,
} from "../../packages/butler-agent/src/test-support/harness/transcripts.ts";
import {
  summarizeWorkerLog,
  TaskStore,
} from "../../packages/butler-agent/src/agent/work/task-store.ts";

let tempDir = "";

beforeEach(() => {
  tempDir = join(tmpdir(), `butler-task-store-${Date.now()}-${Math.random()}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

test("task store reads durable task records from the shared task layout", () => {
  const taskDir = join(tempDir, "tasks", "task-1");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "status"), "DONE\n", "utf8");
  writeFileSync(join(taskDir, "project"), "butler\n", "utf8");
  writeFileSync(join(taskDir, "request.md"), "run checks\n", "utf8");
  writeFileSync(join(taskDir, "result.md"), "all green\n", "utf8");
  writeFileSync(join(taskDir, "log.txt"), "log\n", "utf8");

  const task = new TaskStore(tempDir).read("task-1");

  expect(task?.status).toBe("DONE");
  expect(task?.project).toBe("butler");
  expect(task?.request).toBe("run checks");
  expect(task?.result).toBe("all green");
  expect(task?.observedResult).toBe("all green");
  expect(task?.hasResult).toBe(true);
  expect(task?.origin).toBeNull();
});

test("task store marks result notification durably and keeps legacy marker readable", () => {
  const store = new TaskStore(tempDir);
  const taskDir = join(tempDir, "tasks", "task-2");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "status"), "FAILED\n", "utf8");

  expect(store.read("task-2")?.notifiedAt).toBeNull();

  const at = new Date("2026-04-24T00:00:00.000Z");
  store.markResultNotified("task-2", at);

  expect(store.read("task-2")?.notifiedAt).toBe("2026-04-24T00:00:00.000Z");
});

test("task store recovers stale notification locks and does not leave temp files", () => {
  const store = new TaskStore(tempDir);
  const taskDir = join(tempDir, "tasks", "task-stale-notify-lock");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "status"), "DONE\n", "utf8");
  mkdirSync(join(taskDir, ".worker-result-notified.lock"));
  const stale = new Date(Date.now() - 60_000);
  utimesSync(join(taskDir, ".worker-result-notified.lock"), stale, stale);

  store.markResultNotified("task-stale-notify-lock", new Date("2026-04-24T00:00:00.000Z"));

  expect(store.read("task-stale-notify-lock")?.notifiedAt).toBe("2026-04-24T00:00:00.000Z");
  expect(existsSync(join(taskDir, ".worker-result-notified.lock"))).toBe(false);
  expect(readdirSync(taskDir).filter((entry) => entry.includes(".tmp-"))).toEqual([]);
});

test("task store summaries are sorted newest-first and limited", () => {
  for (const [taskId, status] of [["task-a", "RUNNING"], ["task-c", "DONE"], ["task-b", "FAILED"]]) {
    const taskDir = join(tempDir, "tasks", taskId);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status"), `${status}\n`, "utf8");
  }

  expect(new TaskStore(tempDir).summaries(2).map((task) => task.task_id)).toEqual([
    "task-c",
    "task-b",
  ]);
});

test("task store integrates planned task metadata into summaries", () => {
  const taskDir = join(tempDir, "tasks", "task-planned");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "status"), "PLANNED\n", "utf8");
  writeFileSync(join(taskDir, "plan.json"), JSON.stringify({
    task_id: "task-planned",
    type: "planned",
    goal: "Implement reviewed dispatch",
    project: "fixtures/butler-project",
    created_at: "2026-04-25T00:00:00.000Z",
    decision_policy: "autonomous unless critical",
    acceptance_criteria: ["review passes"],
    verification_commands: ["bun run check"],
    review_policy: "review against criteria",
    repair_policy: {
      max_attempts: 2,
      allow_autonomous_repair: true,
    },
    public_report_policy: "report after review",
  }), "utf8");

  const task = new TaskStore(tempDir).read("task-planned");
  const summary = new TaskStore(tempDir).summaries(1)[0]!;

  expect(task?.planned?.plan.goal).toBe("Implement reviewed dispatch");
  expect(summary).toMatchObject({
    task_id: "task-planned",
    task_type: "planned",
    planned_status: "PLANNED",
    planned_goal: "Implement reviewed dispatch",
    review_verdict: null,
    public_report_ready: false,
    work_mode: "planning",
    safe_to_report: false,
    completion_claim_allowed: false,
  });
  expect(Date.parse(summary.updated_at ?? "")).toBeGreaterThan(0);
  expect(summary.guard_reason).toContain("execution has not started");
});

test("task summaries expose mode safety for direct workers", () => {
  for (const [taskId, status] of [["task-running", "RUNNING"], ["task-done", "DONE"], ["task-failed", "FAILED"]]) {
    const taskDir = join(tempDir, "tasks", taskId);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status"), `${status}\n`, "utf8");
  }

  const summaries = new TaskStore(tempDir).summaries(10);
  expect(summaries.find((task) => task.task_id === "task-running")).toMatchObject({
    work_mode: "executing",
    safe_to_report: false,
    completion_claim_allowed: false,
  });
  expect(summaries.find((task) => task.task_id === "task-done")).toMatchObject({
    work_mode: "complete",
    safe_to_report: true,
    completion_claim_allowed: true,
    guard_reason: null,
  });
  expect(summaries.find((task) => task.task_id === "task-failed")).toMatchObject({
    work_mode: "failed",
    safe_to_report: true,
    completion_claim_allowed: false,
  });
});

test("task store summarizes useful worker log when result file is empty", () => {
  const log = [
    "[worker-runner] [2026-04-24 13:50:11] run_shell (Run the project's declared aggregate validation script to determine current test status.): bun run check",
    "[worker-runner] [2026-04-24 13:50:15] run_shell result: exit=0 timed_out=false",
    "[worker-runner] [2026-04-24 13:50:15] stdout:",
    "PASS: managed bun runtime",
    "PASS: native purge gate",
    "[worker-runner] [2026-04-24 13:50:15] stderr:",
    " 33 pass",
    " 0 fail",
    "[worker-runner] [2026-04-24 13:50:24] run_shell (Run nested package's declared test script that is not included in the root check script.): (cd packages/butler-agent/src/integrations/telegram && bun run test)",
    "[worker-runner] [2026-04-24 13:50:25] run_shell result: exit=1 timed_out=false",
    "[worker-runner] [2026-04-24 13:50:25] stderr:",
    "The following filters did not match any test files:",
    " server.test.ts",
  ].join("\n");
  const taskDir = join(tempDir, "tasks", "task-log");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "status"), "FAILED\n", "utf8");
  writeFileSync(join(taskDir, "log.txt"), log, "utf8");

  const task = new TaskStore(tempDir).read("task-log");

  expect(summarizeWorkerLog(log)).toContain("Root validation: passed");
  expect(task?.observedResult).toContain("Root validation: passed");
  expect(task?.observedResult).toContain("server.test.ts");
});

test("task store prefers useful worker log summary over generic exit-code result file", () => {
  const taskDir = join(tempDir, "tasks", "task-exit-code");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "status"), "FAILED\n", "utf8");
  writeFileSync(join(taskDir, "result.md"), "EXIT_CODE: 1\n", "utf8");
  writeFileSync(join(taskDir, "log.txt"), [
    "[worker-runner] [2026-04-24 14:06:02] run_shell (Run documented non-destructive verification commands separately to determine current status.): bun run check",
    "[worker-runner] [2026-04-24 14:06:06] run_shell result: exit=1 timed_out=false",
    "[worker-runner] [2026-04-24 14:06:06] stdout:",
    "===== COMMAND: bun run typecheck =====",
    "===== EXIT: 0 =====",
    "===== COMMAND: bash tests/unit/native-purge-gate.sh =====",
    "===== EXIT: 1 =====",
  ].join("\n"), "utf8");

  const task = new TaskStore(tempDir).read("task-exit-code");

  expect(task?.result).toBe("EXIT_CODE: 1");
  expect(task?.observedResult).toContain("Non-zero subcommand");
  expect(task?.observedResult).toContain("native-purge-gate.sh");
  expect(task?.observedResult).toContain("Worker result file: EXIT_CODE: 1");
});

test("task store surfaces terminal worker errors from logs", () => {
  const taskDir = join(tempDir, "tasks", "task-terminal-error");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "status"), "FAILED\n", "utf8");
  writeFileSync(join(taskDir, "result.md"), "EXIT_CODE: 1\n", "utf8");
  writeFileSync(join(taskDir, "log.txt"), [
    "[worker-runner] [2026-04-24 14:06:02] run_shell (Run checks): bun run check",
    "[worker-runner] [2026-04-24 14:06:06] run_shell result: exit=0 timed_out=false",
    "[worker-runner] [2026-04-24 14:06:06] stdout:",
    "PASS: native purge gate",
    "[worker-runner] [2026-04-24 14:06:07] ERROR: Codex backend error (503): connection refused",
  ].join("\n"), "utf8");

  const task = new TaskStore(tempDir).read("task-terminal-error");

  expect(task?.observedResult).toContain("Worker terminal error");
  expect(task?.observedResult).toContain("Codex backend error");
  expect(task?.observedResult).toContain("Partial successful command");
  expect(task?.observedResult).toContain("PASS: native purge gate");
});

test("task store preserves partial command evidence before backend continuation failure", () => {
  const taskDir = join(tempDir, "tasks", "task-partial-backend-error");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "status"), "FAILED\n", "utf8");
  writeFileSync(join(taskDir, "result.md"), "EXIT_CODE: 1\n", "utf8");
  writeFileSync(join(taskDir, "log.txt"), [
    "[worker-runner] [2026-04-24 21:17:02] run_shell (Inspect project files): pwd && rg --files | sed -n '1,20p'",
    "[worker-runner] [2026-04-24 21:17:03] run_shell result: exit=0 timed_out=false",
    "[worker-runner] [2026-04-24 21:17:03] stdout:",
    "fixtures/butler-project",
    "packages/butler-agent/src/interfaces/transport/telegram/live-gateway.ts",
    "packages/butler-agent/src/integrations/providers/provider.ts",
    "[worker-runner] [2026-04-24 21:17:12] run_shell (Inspect transport code): rg -n \"telegram|poll\" src",
    "[worker-runner] [2026-04-24 21:17:13] run_shell result: exit=0 timed_out=false",
    "[worker-runner] [2026-04-24 21:17:13] stdout:",
    "packages/butler-agent/src/interfaces/transport/telegram/polling-runner.ts:1:import",
    "packages/butler-agent/src/interfaces/transport/telegram/live-gateway.ts:1:import",
    "[worker-runner] [2026-04-24 21:17:29] ERROR: Codex backend error: server_error request ID 64f9065c",
  ].join("\n"), "utf8");

  const task = new TaskStore(tempDir).read("task-partial-backend-error");

  expect(task?.observedResult).toContain("Partial successful command");
  expect(task?.observedResult).toContain("Inspect project files");
  expect(task?.observedResult).toContain("packages/butler-agent/src/interfaces/transport/telegram/live-gateway.ts");
  expect(task?.observedResult).toContain("server_error request ID 64f9065c");
  expect(task?.observedResult).not.toContain("결과 파일과 실행 로그 요약을 찾지 못했습니다");
});

test("task store persists and reads task origin context", () => {
  const store = new TaskStore(tempDir);
  const taskDir = join(tempDir, "tasks", "task-origin");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "status"), "RUNNING\n", "utf8");
  mkdirSync(join(taskDir, "origin.json.lock"));
  const stale = new Date(Date.now() - 60_000);
  utimesSync(join(taskDir, "origin.json.lock"), stale, stale);

  store.writeOrigin("task-origin", {
    version: 1,
    origin_session_id: "butler/main",
    origin_message_id: "42",
    origin_inbound_event_id: "mock:42",
    task_summary: "make the chart for topic A",
    created_at: "2026-04-25T00:00:00.000Z",
    project: "fixtures/butler-project",
    topic_summary: "Topic A chart work",
    transcript_ref: {
      session_id: "butler/main",
      path: "fixtures/butler-data/transcripts/butler_main.jsonl",
      origin_event_id: "mock:42",
      origin_message_id: "42",
      recent_event_ids: ["event-before", "mock:42"],
    },
    memory_refs: [],
  });

  const task = store.read("task-origin");

  expect(task?.origin?.task_summary).toBe("make the chart for topic A");
  expect(task?.origin?.transcript_ref.recent_event_ids).toEqual(["event-before", "mock:42"]);
  expect(store.summaries(1)[0]?.origin_summary).toBe("make the chart for topic A");
  expect(existsSync(join(taskDir, "origin.json.lock"))).toBe(false);
  expect(readdirSync(taskDir).filter((entry) => entry.includes(".tmp-"))).toEqual([]);
});

test("task store reconciles dead running workers into recoverable state when context exists", () => {
  const store = new TaskStore(tempDir);
  const taskDir = join(tempDir, "tasks", "task-dead-running");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "status"), "RUNNING\n", "utf8");
  writeFileSync(join(taskDir, "pid"), "424242\n", "utf8");
  writeFileSync(join(taskDir, "request.md"), "continue this interrupted investigation\n", "utf8");
  mkdirSync(join(taskDir, "status.lock"));
  const stale = new Date(Date.now() - 60_000);
  utimesSync(join(taskDir, "status.lock"), stale, stale);

  const reconciled = store.reconcileRecoverableTasks({
    isPidAlive: () => false,
  });

  expect(reconciled).toEqual([{
    task_id: "task-dead-running",
    from: "RUNNING",
    to: "RECOVERABLE",
    reason: "running worker process is missing; durable context is available",
  }]);
  expect(store.read("task-dead-running")?.status).toBe("RECOVERABLE");
  expect(existsSync(join(taskDir, "status.lock"))).toBe(false);
  expect(readdirSync(taskDir).filter((entry) => entry.includes(".tmp-"))).toEqual([]);
  expect(store.summaries(1)[0]).toMatchObject({
    task_id: "task-dead-running",
    can_resume: true,
    user_summary: "continue this interrupted investigation: worker was interrupted and can be resumed.",
  });

  expect(store.reconcileRecoverableTasks({
    isPidAlive: () => false,
  })).toEqual([]);
  expect(store.taskIds()).toEqual(["task-dead-running"]);
});

test("task store leaves live running workers alone and fails unrecoverable empty tasks", () => {
  const store = new TaskStore(tempDir);
  const liveDir = join(tempDir, "tasks", "task-live-running");
  mkdirSync(liveDir, { recursive: true });
  writeFileSync(join(liveDir, "status"), "RUNNING\n", "utf8");
  writeFileSync(join(liveDir, "pid"), "100\n", "utf8");
  writeFileSync(join(liveDir, "request.md"), "still active\n", "utf8");

  const emptyDir = join(tempDir, "tasks", "task-empty-running");
  mkdirSync(emptyDir, { recursive: true });
  writeFileSync(join(emptyDir, "status"), "RUNNING\n", "utf8");
  writeFileSync(join(emptyDir, "pid"), "200\n", "utf8");

  const reconciled = store.reconcileRecoverableTasks({
    isPidAlive: (pid) => pid === 100,
  });

  expect(reconciled).toEqual([{
    task_id: "task-empty-running",
    from: "RUNNING",
    to: "FAILED",
    reason: "running worker process is missing and no recoverable context was found",
  }]);
  expect(store.read("task-live-running")?.status).toBe("RUNNING");
  expect(store.read("task-empty-running")?.status).toBe("FAILED");
});

test("task store resolves task origin from transcript and hot memory references", () => {
  process.env.BUTLER_DATA = tempDir;
  appendTranscriptEvent(createTranscriptEvent({
    sessionId: "butler/main",
    eventId: "event-topic-a",
    kind: "inbound",
    payload: {
      eventId: "mock:a",
      message: { text: "Topic A chart request" },
    },
  }));
  const memoryHotDir = join(tempDir, "cognition", "memory", "hot");
  mkdirSync(memoryHotDir, { recursive: true });
  writeFileSync(join(memoryHotDir, "cache.md"), [
    "## memory",
    "butler/main",
    "Topic A chart generation should use the project data.",
  ].join("\n"), "utf8");

  const store = new TaskStore(tempDir);
  const taskDir = join(tempDir, "tasks", "task-resolve-origin");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "status"), "DONE\n", "utf8");
  store.writeOrigin("task-resolve-origin", {
    version: 1,
    origin_session_id: "butler/main",
    origin_message_id: "a",
    origin_inbound_event_id: "mock:a",
    task_summary: "Topic A chart generation",
    created_at: "2026-04-25T00:00:00.000Z",
    project: "fixtures/butler-project",
    topic_summary: "Topic A",
    transcript_ref: {
      session_id: "butler/main",
      path: join(tempDir, "transcripts", "butler_main.jsonl"),
      origin_event_id: "mock:a",
      origin_message_id: "a",
      recent_event_ids: ["event-topic-a"],
    },
    memory_refs: [],
  });

  const resolved = store.resolveOrigin("task-resolve-origin");

  expect(resolved?.transcript_events.map((event) => event.eventId)).toEqual(["event-topic-a"]);
  expect(resolved?.memory_snippets[0]?.text).toContain("Topic A chart generation");
});
