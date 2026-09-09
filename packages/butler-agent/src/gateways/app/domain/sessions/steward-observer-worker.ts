import type { WorkerActivitySummary } from "../../interface/protocol/app-protocol.ts";
import { formatInterfaceText, type InterfaceTextReference } from "../../../../../../butler-i18n/src/index.ts";
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
  const statusReference: InterfaceTextReference = { key: "workerStatus", parameters: { phase: awaitingApproval ? "approval" : phase } };
  return {
    worker_id: relation.child_session_id,
    activity_kind: "worker",
    worker_label: "Worker",
    worker_display_name: "Worker",
    worker_ordinal_label: ordinal,
    objective: presentation?.objective || relation.safe_title,
    phase,
    status_line: formatInterfaceText(statusReference, "en-US"),
    status_reference: statusReference,
    current_activity_reference: projected?.active_turn?.progress.summary_reference,
    ...(projected?.active_turn?.progress.summary ? { current_activity_title: projected.active_turn.progress.summary } : {}),
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

function workerActivityPhase(stage?: string): WorkerActivitySummary["phase"] {
  if (!stage || stage.startsWith("conception")) return "orienting";
  if (stage === "planning") return "planning";
  if (["review", "planning_review", "task_review", "validation", "contract_review"].includes(stage)) return "verifying";
  if (stage === "reporting") return "reporting";
  return "executing";
}
