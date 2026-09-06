import type { WorkerActivitySummary } from "../../interface/protocol/app-protocol.ts";
import { projectStewardSession } from "./steward-observer.ts";
import type {
  StewardObserverDelegationPresentation,
  StewardObserverRelation,
  StewardObserverSnapshot,
} from "./steward-observer.ts";

export function projectStewardWorkerActivity(
  relation: StewardObserverRelation,
  snapshot: StewardObserverSnapshot | null,
  presentation: StewardObserverDelegationPresentation | null,
): WorkerActivitySummary {
  const ordinal = `W${relation.ordinal}`;
  const result = snapshot?.result;
  const projected = snapshot ? projectStewardSession(relation, snapshot) : null;
  const activity = projected?.activity_rows.findLast((row) => row.activity_stage);
  const awaitingApproval = projected?.active_turn?.state === "waiting_for_form";
  const phase = result?.status === "success"
    ? "complete"
    : result?.status === "blocked"
      ? "blocked"
      : result?.status === "failed"
        ? "failed"
        : result?.status === "cancelled"
          ? "cancelled"
          : snapshot?.turns.at(-1)?.recovery?.state === "recoverable"
            ? "recoverable"
            : awaitingApproval ? "blocked" : workerActivityPhase(activity?.activity_stage);
  return {
    worker_id: relation.child_session_id,
    activity_kind: "worker",
    worker_label: "Worker",
    worker_display_name: "Worker",
    worker_ordinal_label: ordinal,
    objective: presentation?.objective || relation.safe_title,
    phase,
    status_line: awaitingApproval ? "허용 대기 중" : workerStatusLine(phase),
    ...(activity?.work_decision_title ? { current_activity_title: activity.work_decision_title } : {}),
    ...(projected?.approved_plan_total !== undefined ? {
      approved_plan_total: projected.approved_plan_total,
      approved_plan_completed: projected.approved_plan_completed,
    } : {}),
    session_id: relation.child_session_id,
    parent_turn_id: relation.parent_turn_id,
    ...(presentation?.source_tool_call_id ? { source_tool_call_id: presentation.source_tool_call_id } : {}),
    ...(presentation?.task_id ? { task_id: presentation.task_id } : {}),
    terminal: Boolean(result),
    created_at: relation.created_at,
    updated_at: snapshot?.updated_at ?? relation.created_at,
    supported_controls: [],
  };
}

function workerStatusLine(phase: WorkerActivitySummary["phase"]): string {
  if (phase === "orienting") return "구상 중";
  if (phase === "planning") return "계획 중";
  if (phase === "verifying") return "검토 중";
  if (phase === "reporting") return "보고 중";
  if (phase === "complete") return "완료";
  if (phase === "blocked") return "진행이 막힘";
  if (phase === "failed") return "실패";
  if (phase === "cancelled") return "취소됨";
  if (phase === "recoverable") return "이어서 진행 가능";
  return "작업 중";
}

function workerActivityPhase(stage?: string): WorkerActivitySummary["phase"] {
  if (!stage || stage.startsWith("conception")) return "orienting";
  if (stage === "planning") return "planning";
  if (["review", "planning_review", "task_review", "validation", "contract_review"].includes(stage)) return "verifying";
  if (stage === "reporting") return "reporting";
  return "executing";
}
