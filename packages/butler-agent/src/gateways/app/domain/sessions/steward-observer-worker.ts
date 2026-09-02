import type { WorkerActivitySummary } from "../../interface/protocol/app-protocol.ts";
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
            : "executing";
  return {
    worker_id: relation.child_session_id,
    activity_kind: "worker",
    worker_label: "Worker",
    worker_display_name: "Worker",
    worker_ordinal_label: ordinal,
    objective: presentation?.objective || relation.safe_title,
    phase,
    status_line: workerStatusLine(phase),
    session_id: relation.child_session_id,
    parent_turn_id: relation.parent_turn_id,
    ...(presentation?.task_id ? { task_id: presentation.task_id } : {}),
    terminal: Boolean(result),
    created_at: relation.created_at,
    updated_at: snapshot?.updated_at ?? relation.created_at,
    supported_controls: [],
  };
}

function workerStatusLine(phase: WorkerActivitySummary["phase"]): string {
  if (phase === "complete") return "완료";
  if (phase === "blocked") return "진행이 막힘";
  if (phase === "failed") return "실패";
  if (phase === "cancelled") return "취소됨";
  if (phase === "recoverable") return "이어서 진행 가능";
  return "작업 중";
}
