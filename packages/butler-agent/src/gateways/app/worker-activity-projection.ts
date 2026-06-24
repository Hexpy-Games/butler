import type {
  WorkerActivityPhase,
  WorkerActivitySummary,
} from "./protocol.ts";
import type { WorkOrchestrationRecord } from "../../agent/work/work-orchestration.ts";

export function shouldKeepInactiveLinkedReportingWorker(input: {
  worker: WorkerActivitySummary;
  sessionId?: string;
  linkedWorkerTaskIds: Set<string>;
  orchestration: WorkOrchestrationRecord | null;
}): boolean {
  if (
    !input.sessionId ||
    !input.worker.task_id ||
    !input.worker.orchestration_id ||
    !input.linkedWorkerTaskIds.has(input.worker.task_id) ||
    !input.orchestration
  ) {
    return false;
  }
  return orchestrationActivityPhase(input.orchestration) === "reporting";
}

export function orchestrationActivityPhase(
  orchestration: WorkOrchestrationRecord,
): WorkerActivityPhase {
  if (orchestration.status === "cancelled") return "cancelled";
  if (orchestration.status === "failed") return "failed";
  if (orchestration.status === "reported") return "complete";
  if (orchestration.status === "ready_for_report") return "reporting";
  if (orchestration.streams.some((stream) => stream.status === "running")) return "executing";
  if (orchestration.streams.some((stream) => stream.status === "failed")) return "blocked";
  if (orchestration.streams.some((stream) => stream.status !== "pending")) return "executing";
  return "planning";
}

export function orchestrationStatusLine(
  orchestration: WorkOrchestrationRecord,
  phase: WorkerActivityPhase,
): string {
  const running = orchestration.streams.filter((stream) => stream.status === "running").length;
  const failed = orchestration.streams.filter((stream) => stream.status === "failed").length;
  const done = orchestration.streams.filter((stream) =>
    stream.status === "done" || stream.status === "skipped",
  ).length;
  const total = orchestration.streams.length;
  if (phase === "cancelled") return "Cancelled: coordinated worker plan stopped.";
  if (phase === "failed") return "Failed: one or more worker streams need review.";
  if (phase === "blocked") {
    return `Blocked: ${failed} of ${total} worker streams failed; remaining streams are waiting.`;
  }
  if (phase === "complete") return "Complete: coordinated worker plan reported.";
  if (phase === "reporting") return "Reporting: worker streams are ready for review.";
  if (running > 0) return `Executing: ${running} of ${total} worker streams running.`;
  if (done > 0) return `Executing: ${done} of ${total} worker streams complete.`;
  return "Planning: coordinated worker streams are queued.";
}
