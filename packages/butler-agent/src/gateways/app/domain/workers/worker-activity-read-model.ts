import type { TaskSummary } from "../../../../agent/work/task-store.ts";
import {
  type WorkOrchestrationRecord,
  type WorkOrchestrationStore,
} from "../../../../agent/work/work-orchestration.ts";
import type {
  WorkerActivityPhase,
  WorkerActivitySummary,
} from "../../interface/protocol/app-protocol.ts";
import {
  orchestrationActivityPhase,
  orchestrationStatusLine,
} from "./worker-activity-projection.ts";
export {
  orderWorkerActivities,
  relabelWorkerActivities,
} from "./worker-activity-ordering.ts";

export function appWorkStreamVisibleInActiveProjection(
  stream: {
    last_user_turn_id: string | null;
    linked_planned_task_ids: string[];
    linked_orchestration_ids: string[];
    linked_worker_task_ids: string[];
  },
  currentTurnId?: string,
): boolean {
  if (
    stream.linked_planned_task_ids.length > 0 ||
    stream.linked_orchestration_ids.length > 0 ||
    stream.linked_worker_task_ids.length > 0
  ) {
    return true;
  }
  if (!stream.last_user_turn_id) return true;
  return Boolean(currentTurnId && stream.last_user_turn_id === currentTurnId);
}

export function workerActivityFromTaskSummary(
  task: TaskSummary,
  orchestrationId?: string,
): WorkerActivitySummary {
  const workModePhase = workModeToPhase(task.work_mode);
  const phase = (
    workModePhase === "complete" ||
    workModePhase === "failed" ||
    workModePhase === "cancelled"
  )
    ? workModePhase
    : task.activity_phase ?? workModePhase;
  const terminal =
    taskStatusIsTerminalForWorkerActivity(task.status) ||
    ["complete", "failed", "cancelled"].includes(phase);
  return {
    worker_id: `worker-${task.task_id}`,
    activity_kind: task.task_type === "planned" ? "planned" : "worker",
    worker_label: task.task_type === "planned" ? "Plan" : "Worker",
    worker_display_name: task.task_type === "planned" ? "Plan" : "Worker",
    worker_ordinal_label: task.task_type === "planned" ? "Plan" : "Worker",
    objective: safeWorkerObjective(task),
    phase,
    status_line: task.activity_status_line ?? safeWorkerStatusLine(task, phase),
    current_activity_title: task.activity_current_title ?? undefined,
    work_blocks:
      task.activity_work_blocks.length > 0
        ? task.activity_work_blocks
        : undefined,
    session_id: task.origin_session_id ?? undefined,
    project_id: task.origin_project ?? task.project ?? undefined,
    task_id: task.task_id,
    orchestration_id: orchestrationId,
    terminal,
    updated_at:
      task.activity_updated_at ?? task.updated_at ?? new Date().toISOString(),
    supported_controls: task.can_resume
      ? ["resume"]
      : terminal
        ? []
        : ["cancel"],
  };
}

export function isActiveWorkerActivity(
  worker: WorkerActivitySummary,
): boolean {
  return !worker.terminal && !INACTIVE_WORKER_ACTIVITY_PHASES.has(worker.phase);
}

export function synthesizeOrchestrationParentActivities(input: {
  workers: WorkerActivitySummary[];
  orchestrationStore: WorkOrchestrationStore;
  sessionId?: string;
  includeHistory: boolean;
}): WorkerActivitySummary[] {
  const plannedKeys = new Set(
    input.workers
      .filter((worker) => worker.activity_kind === "planned")
      .map((worker) => worker.task_id ?? worker.orchestration_id)
      .filter((key): key is string => Boolean(key)),
  );
  const childrenByOrchestration = new Map<string, WorkerActivitySummary[]>();
  for (const worker of input.workers) {
    if (worker.activity_kind !== "worker" || !worker.orchestration_id) {
      continue;
    }
    const children = childrenByOrchestration.get(worker.orchestration_id) ?? [];
    children.push(worker);
    childrenByOrchestration.set(worker.orchestration_id, children);
  }
  if (childrenByOrchestration.size === 0) return input.workers;

  const syntheticParents: WorkerActivitySummary[] = [];
  for (const orchestration of input.orchestrationStore.records()) {
    if (plannedKeys.has(orchestration.id)) continue;
    const children = childrenByOrchestration.get(orchestration.id) ?? [];
    if (children.length === 0) continue;
    if (
      input.sessionId &&
      orchestration.origin_session_id &&
      orchestration.origin_session_id !== input.sessionId &&
      !children.some((child) => child.session_id === input.sessionId)
    ) {
      continue;
    }
    const parent = workerActivityFromOrchestration(orchestration, children);
    if (!input.includeHistory && parent.terminal) continue;
    syntheticParents.push(parent);
  }
  return syntheticParents.length > 0
    ? [...input.workers, ...syntheticParents]
    : input.workers;
}

function workModeToPhase(mode: string): WorkerActivityPhase {
  if (mode === "planning") return "planning";
  if (mode === "reviewing") return "verifying";
  if (mode === "reporting") return "reporting";
  if (mode === "repairing") return "recoverable";
  if (mode === "blocked") return "blocked";
  if (mode === "complete") return "complete";
  if (mode === "cancelled") return "cancelled";
  if (mode === "failed") return "failed";
  return "executing";
}

function taskStatusIsTerminalForWorkerActivity(
  status: TaskSummary["status"],
): boolean {
  return (
    status === "DONE" ||
    status === "REVIEWED" ||
    status === "FAILED" ||
    status === "KILLED"
  );
}

const INACTIVE_WORKER_ACTIVITY_PHASES = new Set<WorkerActivityPhase>([
  "blocked",
  "complete",
  "failed",
  "cancelled",
  "recoverable",
]);

function workerActivityFromOrchestration(
  orchestration: WorkOrchestrationRecord,
  children: WorkerActivitySummary[],
): WorkerActivitySummary {
  const phase = orchestrationActivityPhase(orchestration);
  const terminal = ["complete", "failed", "cancelled"].includes(phase);
  const latestChild = children
    .slice()
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at))[0];
  return {
    worker_id: `planned-${orchestration.id}`,
    activity_kind: "planned",
    worker_label: "Plan",
    worker_display_name: "Plan",
    worker_ordinal_label: "Plan",
    objective: sanitizeWorkerDisplayText(orchestration.goal) ||
      sanitizeWorkerDisplayText(orchestration.title) ||
      "Coordinated worker plan",
    phase,
    status_line: orchestrationStatusLine(orchestration, phase),
    current_activity_title:
      sanitizeWorkerDisplayText(orchestration.title) ?? undefined,
    session_id: orchestration.origin_session_id ?? latestChild?.session_id,
    project_id: latestChild?.project_id,
    task_id: orchestration.id,
    orchestration_id: orchestration.id,
    terminal,
    updated_at:
      orchestration.updated_at || latestChild?.updated_at ||
      new Date().toISOString(),
    supported_controls: terminal ? [] : ["cancel"],
  };
}

function safeWorkerObjective(task: TaskSummary): string {
  return (
    sanitizeWorkerDisplayText(task.planned_goal ?? task.origin_summary) ??
      "Background worker task"
  );
}

function safeWorkerStatusLine(
  task: TaskSummary,
  phase: WorkerActivityPhase,
): string {
  const subject = safeWorkerObjective(task);
  if (subject !== "Background worker task") {
    return `${phaseLabel(phase)}: ${subject}`;
  }
  if (phase === "executing") return "Worker is still running.";
  if (phase === "consolidating") return "Worker is consolidating evidence.";
  if (phase === "reporting") return "Worker is preparing a report.";
  if (phase === "recoverable") return "Worker can be resumed.";
  if (phase === "complete") return "Worker completed.";
  if (phase === "failed") {
    return "Worker failed; details are available in worker history.";
  }
  if (phase === "cancelled") return "Worker was stopped.";
  return "Worker status is available.";
}

function phaseLabel(phase: WorkerActivityPhase): string {
  if (phase === "orienting") return "Orienting";
  if (phase === "planning") return "Planning";
  if (phase === "executing") return "Executing";
  if (phase === "verifying") return "Verifying";
  if (phase === "consolidating") return "Consolidating";
  if (phase === "reporting") return "Reporting";
  if (phase === "complete") return "Complete";
  if (phase === "recoverable") return "Recoverable";
  if (phase === "blocked") return "Blocked";
  if (phase === "failed") return "Failed";
  if (phase === "cancelled") return "Cancelled";
  return "Working";
}

function sanitizeWorkerDisplayText(value?: string | null): string | null {
  const text = value
    ?.replace(/\/Users\/[^\s)]+/gu, "local path")
    .replace(/\b[A-Za-z]:\\[^\s)]+/gu, "local path")
    .replace(/\s+/gu, " ")
    .trim();
  if (!text) return null;
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}
