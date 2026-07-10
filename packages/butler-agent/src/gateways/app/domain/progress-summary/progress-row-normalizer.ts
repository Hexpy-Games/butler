import { randomUUID } from "node:crypto";
import type { ProgressSummaryRow } from "../../interface/protocol/app-protocol.ts";
import { isPublicDecisionSource } from "./public-decision-source.ts";
import {
  isRecord,
  safeIsoDate,
  safeOptionalNonNegativeInteger,
  safeOptionalShortText,
  safeOptionalShortToken,
  safeShortText,
  safeShortToken,
} from "./safe-progress-values.ts";

export type ProgressSummaryInput = Omit<ProgressSummaryRow, "created_at"> & {
  created_at?: string;
};

export function normalizeProgressSummaryRow(
  input: ProgressSummaryInput | Record<string, unknown>,
): ProgressSummaryRow {
  const now = new Date().toISOString();
  const safeLabel = safeShortText(input.safe_label, "Activity");
  const kind = safeShortToken(input.kind, "used_tool");
  const row: ProgressSummaryRow = {
    id: safeShortToken(input.id, `progress-${randomUUID()}`),
    kind,
    safe_label: safeLabel,
    state: safeShortToken(input.state, "thinking"),
    created_at: safeIsoDate(input.created_at, now),
  };
  applyBasicProgressFields(row, input);
  applyPublicDecisionFields(row, input);
  applyRuntimeFaultFields(row, input);
  applyWorkDecisionFields(row, input);
  applyStructuredDetailFields(row, input);
  return row;
}

function applyBasicProgressFields(
  row: ProgressSummaryRow,
  input: Record<string, unknown>,
): void {
  const toolName = safeOptionalShortText(input.safe_tool_name);
  if (toolName) row.safe_tool_name = toolName;
  const inputLabel = safeOptionalShortText(input.safe_input_label);
  if (inputLabel) row.safe_input_label = inputLabel;
  const toolCallId = safeOptionalShortToken(input.tool_call_id);
  if (toolCallId) row.tool_call_id = toolCallId;
  const bridgePhase = safeOptionalShortToken(input.bridge_phase);
  if (bridgePhase) row.bridge_phase = bridgePhase;
  const receiptKind = safeOptionalShortToken(input.receipt_kind);
  if (receiptKind) row.receipt_kind = receiptKind;
  const workContractId = safeOptionalShortToken(input.work_contract_id);
  if (workContractId) row.work_contract_id = workContractId;
  const workStreamId = safeOptionalShortToken(input.work_stream_id);
  if (workStreamId) row.work_stream_id = workStreamId;
  const semanticBlockId = safeOptionalShortToken(input.semantic_block_id);
  if (semanticBlockId) row.semantic_block_id = semanticBlockId;
  const workBlockId = safeOptionalShortToken(input.work_block_id);
  if (workBlockId) row.work_block_id = workBlockId;
  const workBlockLabel = safeOptionalShortText(input.work_block_label);
  if (workBlockLabel) row.work_block_label = workBlockLabel;
}

function applyPublicDecisionFields(
  row: ProgressSummaryRow,
  input: Record<string, unknown>,
): void {
  const publicDecisionSource = safeOptionalShortText(
    input.public_decision_source,
  );
  if (!isPublicDecisionSource(publicDecisionSource)) return;
  row.public_decision_source = publicDecisionSource;
  const publicDecisionRole = safeOptionalShortText(
    input.public_decision_role,
  );
  if (publicDecisionRole) row.public_decision_role = publicDecisionRole;
  const publicDecisionSummary = safeOptionalShortText(
    input.public_decision_summary,
  );
  if (publicDecisionSummary) {
    row.public_decision_summary = publicDecisionSummary;
  }
  const publicDecisionRationale = safeOptionalShortText(
    input.public_decision_rationale,
  );
  if (publicDecisionRationale) {
    row.public_decision_rationale = publicDecisionRationale;
  }
  const publicDecisionNextStep = safeOptionalShortText(
    input.public_decision_next_step,
  );
  if (publicDecisionNextStep) {
    row.public_decision_next_step = publicDecisionNextStep;
  }
  const publicDecisionModelCallId = safeOptionalShortToken(
    input.public_decision_model_call_id,
  );
  if (publicDecisionModelCallId) {
    row.public_decision_model_call_id = publicDecisionModelCallId;
  }
  const publicDecisionLatencyMs = safeOptionalNonNegativeInteger(
    input.public_decision_latency_ms,
  );
  if (publicDecisionLatencyMs !== undefined) {
    row.public_decision_latency_ms = publicDecisionLatencyMs;
  }
  const refs = safeTextList(input.public_decision_evidence_refs, 6);
  if (refs.length > 0) row.public_decision_evidence_refs = refs;
}

function applyRuntimeFaultFields(
  row: ProgressSummaryRow,
  input: Record<string, unknown>,
): void {
  const runtimeFaultId = safeOptionalShortToken(input.runtime_fault_id);
  const runtimeFaultKind = safeOptionalShortToken(input.runtime_fault_kind);
  const runtimeFaultSummary = safeOptionalShortText(
    input.runtime_fault_public_summary,
  );
  if (!runtimeFaultId || !runtimeFaultKind || !runtimeFaultSummary) return;
  row.runtime_fault_id = runtimeFaultId;
  row.runtime_fault_kind = runtimeFaultKind;
  row.runtime_fault_retryable = input.runtime_fault_retryable === true;
  row.runtime_fault_public_summary = runtimeFaultSummary;
  const safeErrorCode = safeOptionalShortToken(
    input.runtime_fault_safe_error_code,
  );
  if (safeErrorCode) row.runtime_fault_safe_error_code = safeErrorCode;
  const safeCause = safeOptionalShortText(input.runtime_fault_safe_cause);
  if (safeCause) row.runtime_fault_safe_cause = safeCause;
}

function applyWorkDecisionFields(
  row: ProgressSummaryRow,
  input: Record<string, unknown>,
): void {
  const decisionSource = safeOptionalShortText(input.work_decision_source);
  if (!isPublicDecisionSource(decisionSource)) return;
  row.work_decision_source = decisionSource;
  const decisionSummary = safeOptionalShortText(input.work_decision_summary);
  if (decisionSummary) row.work_decision_summary = decisionSummary;
  const decisionRationale = safeOptionalShortText(
    input.work_decision_rationale,
  );
  if (decisionRationale) row.work_decision_rationale = decisionRationale;
  const decisionNextStep = safeOptionalShortText(
    input.work_decision_next_step,
  );
  if (decisionNextStep) row.work_decision_next_step = decisionNextStep;
  const refs = safeTextList(input.work_decision_evidence_refs, 6);
  if (refs.length > 0) row.work_decision_evidence_refs = refs;
}

function applyStructuredDetailFields(
  row: ProgressSummaryRow,
  input: Record<string, unknown>,
): void {
  const safeCount = Number(input.safe_count);
  if (Number.isFinite(safeCount) && safeCount >= 0) {
    row.safe_count = Math.floor(safeCount);
  }
  const safeOrder = Number(input.safe_order);
  if (Number.isFinite(safeOrder) && safeOrder >= 0) {
    row.safe_order = Math.floor(safeOrder);
  }
  const pathLabels = safeTextList(input.safe_path_labels, 12);
  if (pathLabels.length > 0) row.safe_path_labels = pathLabels;
  if (!Array.isArray(input.safe_detail_rows)) return;
  const details = input.safe_detail_rows
    .filter(isRecord)
    .map((detail, index) => ({
      id: safeShortToken(detail.id, `${row.id}-detail-${index + 1}`),
      kind: safeOptionalShortToken(detail.kind),
      safe_label: safeShortText(detail.safe_label, "Detail"),
      safe_value: safeOptionalShortText(detail.safe_value),
      state: safeOptionalShortToken(detail.state),
    }))
    .slice(0, 20);
  if (details.length > 0) row.safe_detail_rows = details;
}

function safeTextList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => safeOptionalShortText(item))
    .filter((item): item is string => Boolean(item))
    .slice(0, limit);
}
