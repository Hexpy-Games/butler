import { expect, test } from "bun:test";
import {
  orchestrationActivityPhase,
  orchestrationStatusLine,
  shouldKeepInactiveLinkedReportingWorker,
} from "../../packages/butler-agent/src/gateways/app/worker-activity-projection.ts";
import type { WorkerActivitySummary } from "../../packages/butler-agent/src/gateways/app/protocol.ts";
import type { WorkOrchestrationRecord } from "../../packages/butler-agent/src/agent/work/work-orchestration.ts";

test("worker activity projection keeps terminal linked children only for reporting orchestrations", () => {
  const worker = workerSummary({
    task_id: "worker-report",
    orchestration_id: "orch-report",
    phase: "complete",
    terminal: true,
  });
  const linkedWorkerTaskIds = new Set(["worker-report"]);

  expect(shouldKeepInactiveLinkedReportingWorker({
    worker,
    sessionId: "general",
    linkedWorkerTaskIds,
    orchestration: orchestration({ status: "ready_for_report" }),
  })).toBe(true);

  expect(shouldKeepInactiveLinkedReportingWorker({
    worker,
    sessionId: "general",
    linkedWorkerTaskIds,
    orchestration: orchestration({ status: "running" }),
  })).toBe(false);
  expect(shouldKeepInactiveLinkedReportingWorker({
    worker,
    sessionId: "general",
    linkedWorkerTaskIds: new Set(),
    orchestration: orchestration({ status: "ready_for_report" }),
  })).toBe(false);
});

test("worker activity projection derives orchestration phase and status line", () => {
  const blocked = orchestration({
    status: "running",
    streams: [
      stream("setup", "failed"),
      stream("implementation", "pending"),
    ],
  });
  const reporting = orchestration({
    status: "ready_for_report",
    streams: [stream("implementation", "done")],
  });

  expect(orchestrationActivityPhase(blocked)).toBe("blocked");
  expect(orchestrationStatusLine(blocked, "blocked"))
    .toBe("Blocked: 1 of 2 worker streams failed; remaining streams are waiting.");
  expect(orchestrationActivityPhase(reporting)).toBe("reporting");
  expect(orchestrationStatusLine(reporting, "reporting"))
    .toBe("Reporting: worker streams are ready for review.");
});

function workerSummary(overrides: Partial<WorkerActivitySummary>): WorkerActivitySummary {
  return {
    worker_id: "worker-worker-report",
    activity_kind: "worker",
    worker_label: "Worker",
    worker_display_name: "Worker",
    worker_ordinal_label: "Worker",
    objective: "Implement",
    phase: "executing",
    status_line: "Executing",
    terminal: false,
    updated_at: "2026-06-23T00:00:00.000Z",
    supported_controls: ["cancel"],
    ...overrides,
  };
}

function orchestration(input: Partial<WorkOrchestrationRecord>): WorkOrchestrationRecord {
  return {
    version: 1,
    id: "orch-report",
    title: "Report orchestration",
    goal: "Complete worker streams",
    origin_session_id: "general",
    status: "running",
    streams: [stream("implementation", "running")],
    public_report: null,
    created_at: "2026-06-23T00:00:00.000Z",
    updated_at: "2026-06-23T00:00:00.000Z",
    ...input,
  };
}

function stream(
  id: string,
  status: WorkOrchestrationRecord["streams"][number]["status"],
): WorkOrchestrationRecord["streams"][number] {
  return {
    id,
    role: "builder",
    objective: "Build",
    acceptance_criteria: ["done"],
    depends_on: [],
    status,
    worker_task_id: `worker-${id}`,
    result_summary: null,
    updated_at: "2026-06-23T00:00:00.000Z",
  };
}
