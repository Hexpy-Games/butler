import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { WorkOrchestrationStore, orchestrationWorkerPrompt } from "../../packages/butler-agent/src/agent/work/work-orchestration.ts";

function tempRoot(): string {
  const root = join(tmpdir(), `butler-work-orchestration-${Date.now()}-${Math.random()}`);
  mkdirSync(root, { recursive: true });
  return root;
}

test("work orchestrations persist role-aware streams under Butler data", () => {
  const butlerData = tempRoot();
  const store = new WorkOrchestrationStore(butlerData);

  try {
    const created = store.create({
      id: "orch-1",
      title: "Feature launch",
      goal: "Ship the feature safely",
      originSessionId: "butler/main",
      streams: [
        {
          id: "research",
          role: "researcher",
          objective: "Collect constraints.",
          acceptance_criteria: ["Constraints are documented"],
        },
        {
          id: "implementation",
          role: "builder",
          objective: "Implement the change.",
          acceptance_criteria: ["Implementation evidence exists"],
          depends_on: ["research"],
        },
      ],
      now: new Date("2026-04-27T00:00:00.000Z"),
    });

    expect(created).toMatchObject({
      id: "orch-1",
      status: "draft",
      stream_count: 2,
      safe_to_report: false,
      completion_claim_allowed: false,
    });
    expect(store.read("orch-1")?.streams.map((stream) => stream.role)).toEqual(["researcher", "builder"]);
    expect(store.readyStreams("orch-1").map((stream) => stream.id)).toEqual(["research"]);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("work orchestration dependency validation rejects unknown dependencies and cycles", () => {
  const butlerData = tempRoot();
  const store = new WorkOrchestrationStore(butlerData);

  try {
    expect(() => store.create({
      goal: "Bad dependency",
      streams: [{
        id: "a",
        role: "worker",
        objective: "Do A",
        acceptance_criteria: ["A done"],
        depends_on: ["missing"],
      }],
    })).toThrow("depends on unknown stream missing");

    expect(() => store.create({
      goal: "Cycle",
      streams: [
        { id: "a", role: "worker", objective: "Do A", acceptance_criteria: ["A done"], depends_on: ["b"] },
        { id: "b", role: "worker", objective: "Do B", acceptance_criteria: ["B done"], depends_on: ["a"] },
      ],
    })).toThrow("dependency cycle");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("ready-stream dispatch and sync follow durable worker task state", () => {
  const butlerData = tempRoot();
  const store = new WorkOrchestrationStore(butlerData);

  try {
    store.create({
      id: "orch-sync",
      goal: "Coordinate two streams",
      streams: [
        { id: "a", role: "researcher", objective: "Do A", acceptance_criteria: ["A done"] },
        { id: "b", role: "builder", objective: "Do B", acceptance_criteria: ["B done"], depends_on: ["a"] },
      ],
    });

    store.markDispatched("orch-sync", [{ stream_id: "a", worker_task_id: "worker-a" }]);
    expect(store.summary("orch-sync")).toMatchObject({
      status: "running",
      counts: { running: 1, pending: 1 },
    });

    const workerDir = join(butlerData, "tasks", "worker-a");
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, "request.md"), "Implement stream A.\n", "utf8");
    writeFileSync(join(workerDir, "status"), "DONE\n", "utf8");
    writeFileSync(join(workerDir, "result.md"), "A completed with evidence.\n", "utf8");
    writeFileSync(join(workerDir, "worker_activity_events.jsonl"), `${JSON.stringify({
      schema: "butler.worker-activity-event.v1",
      event_id: "ev-a",
      created_at: "2026-04-27T00:00:00.000Z",
      actor: "worker",
      event: "activity_updated",
      semantic_phase: "executing",
      action_kind: "write_file",
      status_line: "Executing: wrote stream A output.",
      evidence_refs: ["stream-a-output"],
    })}\n`, "utf8");

    expect(store.syncFromTasks("orch-sync")).toMatchObject({
      status: "running",
      counts: { done: 1, pending: 1 },
    });
    expect(store.readyStreams("orch-sync").map((stream) => stream.id)).toEqual(["b"]);

    const prompt = orchestrationWorkerPrompt({
      orchestration: store.read("orch-sync")!,
      stream: store.readyStreams("orch-sync")[0]!,
    });
    expect(prompt).toContain("Role: builder");
    expect(prompt).toContain("Turn Cognition Cycle");
    expect(prompt).toContain("구상, 계획, 실행, 검토, 취합 및 정리, 보고");
    expect(prompt).toContain("Do not report to the user directly");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("cancelled work orchestrations cannot dispatch, sync, or report later", () => {
  const butlerData = tempRoot();
  const store = new WorkOrchestrationStore(butlerData);

  try {
    store.create({
      id: "orch-cancel",
      goal: "Coordinate work that may be stopped",
      streams: [
        { id: "a", role: "researcher", objective: "Do A", acceptance_criteria: ["A done"] },
        { id: "b", role: "builder", objective: "Do B", acceptance_criteria: ["B done"], depends_on: ["a"] },
      ],
    });
    store.markDispatched("orch-cancel", [{ stream_id: "a", worker_task_id: "worker-a" }]);

    const cancelled = store.cancel("orch-cancel", new Date("2026-04-27T01:00:00.000Z"));
    expect(cancelled).toMatchObject({
      status: "cancelled",
      safe_to_report: false,
      completion_claim_allowed: false,
      counts: { cancelled: 2, pending: 0 },
    });
    expect(store.readyStreams("orch-cancel")).toEqual([]);

    const workerDir = join(butlerData, "tasks", "worker-a");
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, "status"), "DONE\n", "utf8");
    writeFileSync(join(workerDir, "result.md"), "A completed after cancel.\n", "utf8");

    expect(store.syncFromTasks("orch-cancel")).toMatchObject({
      status: "cancelled",
      counts: { cancelled: 2, pending: 0 },
    });
    expect(() => store.markDispatched("orch-cancel", [{ stream_id: "b", worker_task_id: "worker-b" }]))
      .toThrow("work orchestration orch-cancel is cancelled");
    expect(() => store.writeReport("orch-cancel", "All done."))
      .toThrow("cancelled work orchestration cannot be reported");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("work orchestration reports are blocked until streams are terminal", () => {
  const butlerData = tempRoot();
  const store = new WorkOrchestrationStore(butlerData);

  try {
    store.create({
      id: "orch-report",
      goal: "Prepare a report",
      streams: [{
        id: "report",
        role: "reviewer",
        objective: "Review the result.",
        acceptance_criteria: ["Review complete"],
      }],
    });
    expect(() => store.writeReport("orch-report", "All done."))
      .toThrow("requires all streams to be terminal");

    store.markDispatched("orch-report", [{ stream_id: "report", worker_task_id: "worker-report" }]);
    const workerDir = join(butlerData, "tasks", "worker-report");
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, "request.md"), "Review stream result.\n", "utf8");
    writeFileSync(join(workerDir, "status"), "DONE\n", "utf8");
    writeFileSync(join(workerDir, "result.md"), "Review complete.\n", "utf8");
    writeFileSync(join(workerDir, "worker_activity_events.jsonl"), `${JSON.stringify({
      schema: "butler.worker-activity-event.v1",
      event_id: "ev-review",
      created_at: "2026-04-27T00:00:00.000Z",
      actor: "worker",
      event: "activity_updated",
      semantic_phase: "reporting",
      action_kind: "report",
      status_line: "Reporting: review complete.",
      evidence_refs: ["review-summary"],
    })}\n`, "utf8");
    store.syncFromTasks("orch-report");

    expect(() => store.writeReport("orch-report", "   "))
      .toThrow("report must be non-empty");
    expect(store.writeReport("orch-report", "Reviewed outcome is ready.")).toMatchObject({
      status: "reported",
      safe_to_report: true,
      completion_claim_allowed: true,
    });
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("work orchestration does not mark planning-only implementation streams done", () => {
  const butlerData = tempRoot();
  const store = new WorkOrchestrationStore(butlerData);

  try {
    store.create({
      id: "orch-planning-only",
      goal: "Implement a stream",
      streams: [{
        id: "implementation",
        role: "builder",
        objective: "Implement the change.",
        acceptance_criteria: ["Implementation evidence exists"],
      }],
    });
    store.markDispatched("orch-planning-only", [{ stream_id: "implementation", worker_task_id: "worker-plan" }]);
    const workerDir = join(butlerData, "tasks", "worker-plan");
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, "request.md"), "Implement the change.\n", "utf8");
    writeFileSync(join(workerDir, "status"), "DONE\n", "utf8");
    writeFileSync(join(workerDir, "result.md"), "I inspected the repository and planned the change.\n", "utf8");
    writeFileSync(join(workerDir, "worker_activity_events.jsonl"), `${JSON.stringify({
      schema: "butler.worker-activity-event.v1",
      event_id: "ev-plan",
      created_at: "2026-04-27T00:00:00.000Z",
      actor: "worker",
      event: "activity_updated",
      semantic_phase: "planning",
      action_kind: "plan",
      status_line: "Planning: identified files to edit.",
    })}\n`, "utf8");

    expect(store.syncFromTasks("orch-planning-only")).toMatchObject({
      status: "failed",
      counts: { failed: 1 },
      safe_to_report: true,
      completion_claim_allowed: false,
    });
    expect(store.read("orch-planning-only")?.streams[0]).toMatchObject({
      status: "failed",
      result_summary: expect.stringContaining("no implementation evidence"),
    });
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});
