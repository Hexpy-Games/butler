import { projectSharedWorkBlocks } from "../../../../../../butler-progress-projection/src/index.ts";
import type { ProgressRow, WorkBlockView } from "../types.ts";
import { visibleProgressRows } from "./progress-rows.ts";

export type PhaseActivity = {
  id: string;
  phase?: string;
  summary: string;
  rationale: string;
  nextStep: string;
  createdAt?: string;
  operations: ProgressRow[];
};

export type ActivityReadModel =
  | { type: "receipt"; label: string; state: string; receiptKind: string }
  | { type: "decision"; summary: string; rationale?: string; nextStep?: string; source: string; modelCallId?: string; latencyMs?: number; evidenceRefs?: string[] }
  | { type: "work_block"; id: string; label?: string; state: string }
  | { type: "tool_control"; toolName: string; inputLabel?: string; label: string; toolCallId?: string; workBlockId?: string }
  | { type: "observation"; label: string; detailRows?: ProgressRow["safe_detail_rows"] }
  | { type: "outcome"; state: string; publicSummary: string }
  | { type: "runtime_fault"; faultId: string; kind: string; retryable: boolean; publicSummary: string; safeErrorCode?: string; safeCause?: string };

export interface TurnActivityProjection {
  visibleRows: ProgressRow[];
  readModels: ActivityReadModel[];
  decisions: Extract<ActivityReadModel, { type: "decision" }>[];
  workBlocks: WorkBlockView[];
  phaseActivities: PhaseActivity[];
  publicActivity?: ProgressRow;
  semanticState?: string;
  modelRoundWait?: ProgressRow;
  operation?: ProgressRow;
}

export function projectTurnActivity(rows: ProgressRow[]): TurnActivityProjection {
  const visibleRows = visibleProgressRows(rows);
  const readModels = projectActivityReadModels(visibleRows);
  const activityRows = visibleRows.filter((row) => row.kind !== "todo");
  const phaseActivities = phaseActivityRows(activityRows);
  return {
    visibleRows,
    readModels,
    decisions: readModels.filter(isDecisionReadModel),
    workBlocks: projectWorkBlocks(activityRows),
    phaseActivities,
    publicActivity: latestPublicActivity(activityRows, phaseActivities.length > 0),
    semanticState: currentSemanticState(activityRows, phaseActivities),
    modelRoundWait: currentModelRoundWait(activityRows),
    operation: currentOperationActivity(activityRows),
  };
}

export function projectWorkBlocks(rows: ProgressRow[]): WorkBlockView[] {
  return projectSharedWorkBlocks(rows, { completedOnly: false }).blocks;
}

export function projectCompletedWorkBlocks(rows: ProgressRow[]): WorkBlockView[] {
  return projectSharedWorkBlocks(rows, { completedOnly: true }).blocks;
}

export function projectCompletedActivityRows(rows: ProgressRow[]): ProgressRow[] {
  const byKey = new Map<string, ProgressRow>();
  for (const row of visibleProgressRows(rows)) {
    if (row.kind === "todo" || row.kind === "work_block") continue;
    const kind = row.kind ?? "";
    const lifecycle = [
      "accepted", "started", "thinking", "queued for butler service",
      "working on request", "checking response", "response checked",
      "preparing final answer", "final answer ready", "completed", "delivered",
    ].includes(row.safe_label.trim().toLowerCase());
    const visible = ["searched", "read", "ran_command", "edited", "dispatch", "used_tool"]
      .includes(kind) || Boolean(row.safe_tool_name || row.safe_input_label) ||
      (kind === "message" && !lifecycle);
    if (!visible) continue;
    byKey.set(row.tool_call_id ? `tool:${row.tool_call_id}` : `row:${row.id}`, row);
  }
  return [...byKey.values()];
}

export function projectActivityReadModels(rows: ProgressRow[]): ActivityReadModel[] {
  return rows.flatMap((row): ActivityReadModel[] => {
    if (row.runtime_fault_id && row.runtime_fault_kind && row.runtime_fault_public_summary) {
      return [{
        type: "runtime_fault",
        faultId: row.runtime_fault_id,
        kind: row.runtime_fault_kind,
        retryable: row.runtime_fault_retryable === true,
        publicSummary: row.runtime_fault_public_summary,
        safeErrorCode: row.runtime_fault_safe_error_code,
        safeCause: row.runtime_fault_safe_cause,
      }];
    }
    if (row.receipt_kind) {
      return [{ type: "receipt", label: row.safe_label, state: row.state, receiptKind: row.receipt_kind }];
    }
    if (row.kind === "decision" && isPublicDecisionSource(row.public_decision_source)) {
      if (!row.public_decision_summary) return [];
      return [{
        type: "decision",
        summary: row.public_decision_summary,
        rationale: row.public_decision_rationale,
        nextStep: row.public_decision_next_step,
        source: row.public_decision_source,
        modelCallId: row.public_decision_model_call_id,
        latencyMs: row.public_decision_latency_ms,
        evidenceRefs: row.public_decision_evidence_refs,
      }];
    }
    if (row.kind === "work_block" && row.work_block_id) {
      return [{ type: "work_block", id: row.work_block_id, label: row.work_block_label, state: row.state }];
    }
    if (isToolControlRow(row)) {
      const toolName = row.safe_tool_name ?? "Tool";
      const inputLabel = row.safe_input_label;
      return [{
        type: "tool_control",
        toolName,
        inputLabel,
        label: inputLabel && row.safe_tool_name
          ? `${toolName}: ${inputLabel}`
          : row.safe_tool_name ?? inputLabel ?? "Tool",
        toolCallId: row.tool_call_id,
        workBlockId: row.work_block_id,
      }];
    }
    if (row.kind === "turn" && isTerminal(row.state)) {
      return [{ type: "outcome", state: row.state, publicSummary: row.safe_label }];
    }
    if (row.safe_detail_rows?.length) {
      return [{ type: "observation", label: row.safe_label, detailRows: row.safe_detail_rows }];
    }
    return [];
  });
}

function phaseActivityRows(rows: ProgressRow[]): PhaseActivity[] {
  const operationsByPhase = new Map<string, ProgressRow[]>();
  for (const row of rows) {
    if (row.bridge_phase !== "btcc_operation" || !row.semantic_block_id) continue;
    const operations = operationsByPhase.get(row.semantic_block_id) ?? [];
    operations.push(row);
    operationsByPhase.set(row.semantic_block_id, operations);
  }
  return rows.flatMap((row): PhaseActivity[] => {
    if (
      row.kind !== "message" || row.work_block_id || !row.semantic_block_id ||
      row.work_decision_source !== "model-authored" || !row.work_decision_summary ||
      !row.work_decision_rationale || !row.work_decision_next_step
    ) return [];
    return [{
      id: row.id,
      phase: row.semantic_block_id,
      summary: row.work_decision_summary,
      rationale: row.work_decision_rationale,
      nextStep: row.work_decision_next_step,
      createdAt: row.created_at,
      operations: operationsByPhase.get(row.semantic_block_id) ?? [],
    }];
  });
}

function currentOperationActivity(rows: ProgressRow[]): ProgressRow | undefined {
  return findLatest(rows, (row) => row.bridge_phase === "btcc_operation" && row.state === "running");
}

function currentModelRoundWait(rows: ProgressRow[]): ProgressRow | undefined {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!row) continue;
    if (isTerminal(row.state)) return undefined;
    if (row.bridge_phase === "model_round_waiting") return row;
    if (row.work_decision_source === "model-authored" || row.bridge_phase === "operational_recovery")
      return undefined;
  }
  return undefined;
}

function latestPublicActivity(rows: ProgressRow[], hasModelActivity: boolean): ProgressRow | undefined {
  return findLatest(rows, (row) => {
    if (row.kind !== "message" || row.state !== "running" || row.work_block_id) return false;
    if (row.bridge_phase === "model_round_waiting" || row.work_decision_source) return false;
    if (hasModelActivity && row.bridge_phase !== "operational_recovery") return false;
    return row.safe_label.trim().length > 0;
  });
}

function currentSemanticState(rows: ProgressRow[], activities: PhaseActivity[]): string | undefined {
  return findLatest(rows, (row) => Boolean(row.semantic_block_id))?.semantic_block_id
    ?? activities.at(-1)?.phase;
}

function findLatest(
  rows: ProgressRow[],
  predicate: (row: ProgressRow) => boolean,
): ProgressRow | undefined {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row && predicate(row)) return row;
  }
  return undefined;
}

function isDecisionReadModel(
  model: ActivityReadModel,
): model is Extract<ActivityReadModel, { type: "decision" }> {
  return model.type === "decision";
}

function isPublicDecisionSource(value: unknown): value is string {
  return value === "assistant-authored" || value === "model-authored" || value === "principal-authored";
}

function isToolControlRow(row: ProgressRow): boolean {
  if (row.kind === "decision" || row.kind === "work_block") return false;
  return Boolean(row.safe_tool_name || row.safe_input_label || row.tool_call_id);
}

function isTerminal(state: string): boolean {
  return ["failed", "cancelled", "delivered", "complete", "completed", "stopped"].includes(state);
}
