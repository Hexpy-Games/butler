import type {
  ProgressSummaryRow,
  SessionRelationView,
  SessionViewTurn,
  StewardResultView,
  StewardSessionSummaryView,
} from "../../interface/protocol/app-protocol.ts";
import { progressRowFromSharedTurnEvent } from "../../../../../../butler-progress-projection/src/index.ts";
import { normalizeProgressSummaryRow } from "../progress-summary/progress-row-normalizer.ts";

export interface StewardObserverRelation extends SessionRelationView {}

export interface StewardObserverTurn {
  id: string;
  state: string;
  created_at: string;
  updated_at: string;
}

export interface StewardObserverMessage {
  id: string;
  session_id: string;
  turn_id: string;
  role: "user" | "assistant";
  text: string;
  created_at: string;
  updated_at: string;
}

export interface StewardObserverProgressEvent {
  id: string;
  session_id: string;
  turn_id: string;
  session_sequence: number;
  turn_sequence: number;
  kind: string;
  visibility: "public" | "internal";
  payload: Record<string, unknown>;
  created_at: string;
}

export interface StewardObserverPlan {
  plan_revision_id: string;
  revision: number;
  actions: Array<{
    action_key: string;
    description: string;
  }>;
  action_progress: Array<{
    action_key: string;
    status: "pending" | "active" | "done" | "blocked" | "skipped";
  }>;
  approved: boolean;
}

export interface StewardObserverSnapshot {
  session_id: string;
  title: string;
  turns: StewardObserverTurn[];
  messages: StewardObserverMessage[];
  progress_events: StewardObserverProgressEvent[];
  plan: StewardObserverPlan | null;
  result: StewardResultView | null;
  updated_at: string;
}

export interface StewardObserverOperationOutputChunk {
  request_id: string;
  result_id: string;
  result_sha256: string;
  chunk_index: number;
  chunk_count: number;
  byte_start: number;
  byte_end: number;
  byte_length: number;
  content_base64: string;
  content_sha256: string;
}

export interface StewardObserverReader {
  relationForParent(sessionId: string): StewardObserverRelation | null;
  relationForChild(sessionId: string): StewardObserverRelation | null;
  snapshot(sessionId: string): StewardObserverSnapshot | null;
  readOperationOutputChunks(input: {
    turnId: string;
    requestId: string;
    resultId: string;
  }): StewardObserverOperationOutputChunk[];
}

export interface ProjectedStewardSession {
  relation: StewardObserverRelation;
  session_id: string;
  title: string;
  status: "idle" | "active" | "delivered" | "failed" | "cancelled";
  active_turn: SessionViewTurn | null;
  latest_turn: SessionViewTurn | null;
  activity_rows: ProgressSummaryRow[];
  approved_plan_revision?: number;
  approved_plan_total?: number;
  approved_plan_completed?: number;
  artifacts: StewardSessionSummaryView["artifacts"];
  result: StewardResultView | null;
  updated_at: string;
  terminal: boolean;
}

function projectStewardActivityRows(
  snapshot: StewardObserverSnapshot,
  turnId?: string,
): ProgressSummaryRow[] {
  const rows = snapshot.progress_events
    .filter((event) => event.visibility === "public")
    .filter((event) => !turnId || event.turn_id === turnId)
    .flatMap((event) => {
      const row = progressRowFromSharedTurnEvent({
        id: event.id,
        turnSequence: event.turn_sequence,
        createdAt: event.created_at,
        kind: event.kind,
        visibility: event.visibility,
        payload: event.payload,
      });
      return row ? [normalizeProgressSummaryRow(row)] : [];
  });
  const planRows = approvedPlanRows(snapshot.plan, rows);
  const publicNonPlanRows = rows.filter((row) => row.kind !== "todo");
  if (planRows.length > 0 || publicNonPlanRows.length > 0) {
    return [...publicNonPlanRows, ...planRows];
  }
  if (rows.length > 0) return rows;
  const latestTurn = snapshot.turns.at(-1);
  if (!latestTurn) return [];
  return [normalizeProgressSummaryRow({
    id: `steward-turn:${latestTurn.id}`,
    kind: "message",
    safe_label: stewardStateLabel(latestTurn.state),
    state: stewardProgressState(latestTurn.state),
    created_at: latestTurn.updated_at,
    semantic_block_id: `steward-turn:${latestTurn.id}`,
  })];
}

function projectStewardTurn(
  turn: StewardObserverTurn | undefined,
  activityRows: ProgressSummaryRow[],
): SessionViewTurn | null {
  if (!turn) return null;
  const state = observerTurnState(turn.state);
  const terminal = ["delivered", "failed", "cancelled"].includes(state);
  const progressState = terminal ? state : state === "accepted" ? "accepted" : "thinking";
  return {
    id: turn.id,
    state,
    delivery_state: observerDeliveryState(state),
    limitations: [],
    limitation_codes: [],
    cancellable: !terminal,
    retryable: state === "failed",
    progress: {
      summary: activityRows.at(-1)?.safe_label ?? stewardStateLabel(turn.state),
      updated_at: turn.updated_at,
      turn_id: turn.id,
      state: progressState,
      safe_progress_rows: activityRows,
    },
    created_at: turn.created_at,
    updated_at: turn.updated_at,
  };
}

export function projectStewardSession(
  relation: StewardObserverRelation,
  snapshot: StewardObserverSnapshot,
): ProjectedStewardSession {
  const latestTurn = snapshot.turns.at(-1);
  const activityRows = projectStewardActivityRows(snapshot, latestTurn?.id);
  const approvedPlan = snapshot.plan?.approved ? snapshot.plan : null;
  const planProgress = approvedPlan
    ? approvedPlan.actions.map((action) =>
      approvedPlan.action_progress.find((item) => item.action_key === action.action_key)?.status ?? "pending",
    )
    : [];
  const activeTurn = latestTurn && !snapshot.result && !isTerminalObserverState(latestTurn.state)
    ? projectStewardTurn(latestTurn, activityRows)
    : null;
  const latestTurnView = projectStewardTurn(latestTurn, activityRows);
  const status = snapshot.result
    ? observerResultStatus(snapshot.result.status)
    : observerSessionStatus(latestTurn?.state);
  return {
    relation,
    session_id: snapshot.session_id,
    title: snapshot.title,
    status,
    active_turn: activeTurn,
    latest_turn: latestTurnView,
    activity_rows: activityRows,
    ...(approvedPlan
      ? {
          approved_plan_revision: approvedPlan.revision,
          approved_plan_total: approvedPlan.actions.length,
          approved_plan_completed: planProgress.filter((state) =>
            state === "done" || state === "skipped",
          ).length,
        }
      : {}),
    artifacts: snapshot.result
      ? snapshot.result.changed_artifacts.map((path, index) => ({
          id: `${snapshot.result?.result_id}:artifact:${index}`,
          session_id: snapshot.session_id,
          message_id: snapshot.result?.result_id,
          turn_id: snapshot.result?.child_turn_id,
          title: path,
          kind: "file",
          safe_path_label: path,
          created_at: snapshot.result?.created_at ?? snapshot.updated_at,
          open_action: "unsupported" as const,
        }))
      : [],
    result: snapshot.result,
    updated_at: snapshot.updated_at,
    terminal: !activeTurn,
  };
}

export function emptyStewardProjection(
  relation: StewardObserverRelation,
): ProjectedStewardSession {
  return {
    relation,
    session_id: relation.child_session_id,
    title: relation.safe_title,
    status: "idle",
    active_turn: null,
    latest_turn: null,
    activity_rows: [],
    artifacts: [],
    result: null,
    updated_at: relation.created_at,
    terminal: true,
  };
}

function observerTurnState(state: string): SessionViewTurn["state"] {
  if (state === "delivered") return "delivered";
  if (state === "cancelled") return "cancelled";
  if (state === "failed") return "failed";
  if (state === "delivery_committed") return "streaming";
  if (state === "admitted") return "accepted";
  return "thinking";
}

function observerSessionStatus(
  state: string | undefined,
): ProjectedStewardSession["status"] {
  if (state === "delivered") return "delivered";
  if (state === "cancelled") return "cancelled";
  if (state === "failed") return "failed";
  if (state) return "active";
  return "idle";
}

function observerResultStatus(
  status: StewardResultView["status"],
): ProjectedStewardSession["status"] {
  if (status === "success") return "delivered";
  if (status === "cancelled") return "cancelled";
  return "failed";
}

function observerDeliveryState(
  state: SessionViewTurn["state"],
): SessionViewTurn["delivery_state"] {
  if (state === "delivered") return "delivered";
  if (state === "cancelled") return "cancelled";
  if (state === "failed") return "failed_system";
  return "running";
}

function stewardProgressState(state: string): string {
  if (state === "delivered") return "delivered";
  if (state === "cancelled") return "cancelled";
  if (state === "failed") return "failed";
  return "thinking";
}

function stewardStateLabel(state: string): string {
  if (state === "delivered") return "작업을 완료했습니다.";
  if (state === "cancelled") return "작업이 중단되었습니다.";
  if (state === "failed") return "작업을 완료하지 못했습니다.";
  return "작업을 진행 중입니다.";
}

function isTerminalObserverState(state: string): boolean {
  return state === "delivered" || state === "failed" || state === "cancelled";
}

function approvedPlanRows(
  plan: StewardObserverPlan | null,
  eventRows: ProgressSummaryRow[],
): ProgressSummaryRow[] {
  if (!plan?.approved || plan.actions.length === 0) return [];
  const byActionKey = new Map(
    eventRows
      .filter((row) => row.kind === "todo")
      .flatMap((row) => {
        const key = row.safe_input_label ?? row.id;
        if (!key) return [];
        const suffix = key.split(":").at(-1);
        return suffix && suffix !== key
          ? [[key, row] as const, [suffix, row] as const]
          : [[key, row] as const];
      }),
  );
  const stateByActionKey = new Map(
    plan.action_progress.map((item) => [item.action_key, item.status]),
  );
  return plan.actions.map((action, index) => {
    const eventRow = byActionKey.get(action.action_key);
    const state = stateByActionKey.get(action.action_key);
    return normalizeProgressSummaryRow({
      ...eventRow,
      id: action.action_key,
      kind: "todo",
      safe_label: eventRow?.safe_label ?? action.description,
      safe_input_label: action.action_key,
      safe_order: index,
      state: state === "done" ? "completed" : state ?? "pending",
      bridge_phase: "btcc_work_ledger",
    });
  });
}
