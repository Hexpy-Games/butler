import type {
  ProgressSummaryRow,
  SessionRelationView,
  SessionViewTurn,
  StewardResultView,
  StewardSessionSummaryView,
} from "../../interface/protocol/app-protocol.ts";
import { progressRowFromSharedTurnEvent } from "../../../../../../butler-progress-projection/src/index.ts";
import { projectBtccFinalReport } from "../../../../agent/btcc/index.ts";
import { dedupeProgressRows } from "../progress-summary/progress-row-merge.ts";
import { normalizeProgressSummaryRow } from "../progress-summary/progress-row-normalizer.ts";

export interface StewardObserverRelation extends SessionRelationView {}

export interface StewardObserverTurn {
  id: string;
  state: string;
  created_at: string;
  updated_at: string;
  recovery?: {
    state: "live" | "recoverable" | "unknown";
    recovery_id?: string;
  };
}

export interface StewardObserverMessage {
  id: string;
  session_id: string;
  turn_id: string;
  role: "user" | "assistant";
  text: string;
  created_at: string;
  updated_at: string;
  changed_files?: StewardResultView["changed_files"];
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
  waiting_for_children?: boolean;
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

export interface StewardObserverDelegationPresentation {
  task_id: string;
  objective: string;
}

export interface StewardObserverReader {
  relationsForParent(sessionId: string): StewardObserverRelation[];
  relationById(relationId: string): StewardObserverRelation | null;
  relationForChild(sessionId: string): StewardObserverRelation | null;
  delegationPresentation(
    relationId: string,
  ): StewardObserverDelegationPresentation | null;
  isParentResultInput(sessionId: string, text: string): boolean;
  snapshot(sessionId: string): StewardObserverSnapshot | null;
  recoverableTurns(): Array<{
    relation: StewardObserverRelation;
    turn_id: string;
    recovery_id: string;
    original_event_id: string;
    original_message_id: string;
    original_message: string;
  }>;
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
  waiting_for_children: boolean;
  activity_rows: ProgressSummaryRow[];
  approved_plan_revision?: number;
  approved_plan_total?: number;
  approved_plan_completed?: number;
  artifacts: StewardSessionSummaryView["artifacts"];
  changed_files: StewardSessionSummaryView["changed_files"];
  result: StewardResultView | null;
  updated_at: string;
  terminal: boolean;
}

export function projectStewardActivityRows(
  snapshot: StewardObserverSnapshot,
  turnId?: string,
): ProgressSummaryRow[] {
  const rows = dedupeProgressRows(snapshot.progress_events
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
    }));
  const planRows = !turnId || turnId === snapshot.turns.at(-1)?.id
    ? approvedPlanRows(snapshot.plan, rows)
    : [];
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
  active = false,
  waitingForChildren = false,
): SessionViewTurn | null {
  if (!turn) return null;
  const activityUpdatedAt = latestActivityTimestamp(activityRows) ?? turn.updated_at;
  if (turn.recovery?.state === "recoverable") {
    return {
      id: turn.id,
      state: "runtime_fault",
      delivery_state: "failed_system",
      limitations: [],
      limitation_codes: [],
      safe_status_label: "작업이 중단되었습니다. 이어서 진행할 수 있습니다.",
      cancellable: false,
      retryable: true,
      progress: {
        summary: "작업이 중단되었습니다. 이어서 진행할 수 있습니다.",
        updated_at: activityUpdatedAt,
        turn_id: turn.id,
        state: "runtime_fault",
        safe_progress_rows: activityRows,
      },
      created_at: turn.created_at,
      updated_at: activityUpdatedAt,
    };
  }
  const state = active ? "thinking" : observerTurnState(turn.state);
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
      summary: waitingForChildren
        ? "Worker 결과를 기다리는 중입니다."
        : currentStewardActivityLabel(activityRows) ?? stewardStateLabel(turn.state),
      updated_at: activityUpdatedAt,
      turn_id: turn.id,
      state: progressState,
      safe_progress_rows: activityRows,
    },
    created_at: turn.created_at,
    updated_at: activityUpdatedAt,
  };
}

function currentStewardActivityLabel(
  rows: ProgressSummaryRow[],
): string | undefined {
  const currentActivity = rows.findLast((row) =>
    row.kind !== "todo" &&
    row.kind !== "turn" &&
    !isGenericModelRoundActivity(row) &&
    !isModelAuthoredPhaseActivity(row) &&
    (row.state === "running" || row.state === "thinking") &&
    row.safe_label.trim().length > 0,
  );
  if (currentActivity) return currentActivity.safe_label;
  const latestActivity = rows.findLast((row) =>
    row.kind !== "todo" &&
    row.kind !== "turn" &&
    !isGenericModelRoundActivity(row) &&
    !isModelAuthoredPhaseActivity(row) &&
    row.safe_label.trim().length > 0,
  );
  if (latestActivity) return latestActivity.safe_label;
  const currentPlanAction = rows.find((row) =>
    row.kind === "todo" && row.state === "active" && row.safe_label.trim().length > 0,
  );
  if (currentPlanAction) return currentPlanAction.safe_label;
  return rows.findLast((row) =>
    row.kind !== "todo" &&
    row.kind !== "turn" &&
    !isModelAuthoredPhaseActivity(row) &&
    row.safe_label.trim().length > 0,
  )?.safe_label;
}

function isModelAuthoredPhaseActivity(row: ProgressSummaryRow): boolean {
  return row.work_decision_source === "model-authored";
}

function latestActivityTimestamp(rows: ProgressSummaryRow[]): string | undefined {
  return rows.reduce<string | undefined>((latest, row) => {
    if (!row.created_at || !Number.isFinite(Date.parse(row.created_at))) return latest;
    if (!latest || Date.parse(row.created_at) > Date.parse(latest)) return row.created_at;
    return latest;
  }, undefined);
}

function isGenericModelRoundActivity(row: ProgressSummaryRow): boolean {
  return row.bridge_phase === "model_round_waiting" ||
    row.safe_tool_name === "model_round";
}

export function projectStewardSession(
  relation: StewardObserverRelation,
  snapshot: StewardObserverSnapshot,
): ProjectedStewardSession {
  const result = projectedObserverResult(snapshot.result);
  const latestTurn = snapshot.turns.at(-1);
  const activityRows = projectStewardActivityRows(snapshot, latestTurn?.id);
  const approvedPlan = snapshot.plan?.approved ? snapshot.plan : null;
  const planProgress = approvedPlan
    ? approvedPlan.actions.map((action) =>
      approvedPlan.action_progress.find((item) => item.action_key === action.action_key)?.status ?? "pending",
    )
    : [];
  const recoverable = latestTurn?.recovery?.state === "recoverable";
  const waitingForChildren = Boolean(snapshot.waiting_for_children);
  const activeTurn = latestTurn && !result && !recoverable &&
      isActiveObserverTurn(latestTurn.state)
    ? projectStewardTurn(
        latestTurn, activityRows, true, waitingForChildren,
      )
    : null;
  const latestTurnView = projectStewardTurn(
    latestTurn, activityRows, Boolean(activeTurn), waitingForChildren,
  );
  const status = result
    ? observerResultStatus(result.status)
    : recoverable
      ? "failed"
    : latestTurn
      ? "active"
      : "idle";
  return {
    relation,
    session_id: snapshot.session_id,
    title: snapshot.title,
    status,
    active_turn: activeTurn,
    latest_turn: latestTurnView,
    waiting_for_children: waitingForChildren,
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
    artifacts: [],
    changed_files: result?.changed_files ?? [],
    result,
    updated_at: snapshot.updated_at,
    terminal: Boolean(result),
  };
}

function projectedObserverResult(
  result: StewardResultView | null,
): StewardResultView | null {
  if (!result) return null;
  const projected = projectBtccFinalReport(result.summary, result.changed_artifacts);
  return {
    ...result,
    summary: projected.summary,
    changed_artifacts: projected.changedArtifacts,
    changed_files: result.changed_files ?? [],
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
    waiting_for_children: false,
    activity_rows: [],
    artifacts: [],
    changed_files: [],
    result: null,
    updated_at: relation.created_at,
    terminal: false,
  };
}

function isActiveObserverTurn(state: string): boolean {
  return state !== "delivered" && state !== "cancelled" && state !== "failed";
}

function observerTurnState(state: string): SessionViewTurn["state"] {
  if (state === "delivered") return "delivered";
  if (state === "cancelled") return "cancelled";
  if (state === "failed") return "failed";
  if (state === "delivery_committed") return "streaming";
  if (state === "admitted") return "accepted";
  return "thinking";
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
