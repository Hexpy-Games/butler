import { randomUUID } from "node:crypto";
import type { ProgressSummaryRow, TurnState } from "./protocol.ts";
import { isPublicDecisionSource } from "./public-decision-source.ts";

export type ProgressSummaryInput = Omit<ProgressSummaryRow, "created_at"> & {
  created_at?: string;
};

const STATUS_ONLY_PROGRESS_LABELS = new Set([
  "accepted",
  "started",
  "thinking",
  "working on request",
  "checking response",
  "response checked",
  "preparing final answer",
  "final answer ready",
  "completed",
  "delivered",
]);

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
  const toolName = safeOptionalShortText(input.safe_tool_name);
  if (toolName) row.safe_tool_name = toolName;
  const inputLabel = safeOptionalShortText(input.safe_input_label);
  if (inputLabel) row.safe_input_label = inputLabel;
  const toolCallId = safeOptionalShortToken(input.tool_call_id);
  if (toolCallId) row.tool_call_id = toolCallId;
  const bridgePhase = safeOptionalShortToken(input.bridge_phase);
  if (bridgePhase) row.bridge_phase = bridgePhase;
  const workBlockId = safeOptionalShortToken(input.work_block_id);
  if (workBlockId) row.work_block_id = workBlockId;
  const workBlockLabel = safeOptionalShortText(input.work_block_label);
  if (workBlockLabel) row.work_block_label = workBlockLabel;
  const decisionSource = safeOptionalShortText(input.work_decision_source);
  if (isPublicDecisionSource(decisionSource)) {
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
    row.work_decision_source = decisionSource;
    if (Array.isArray(input.work_decision_evidence_refs)) {
      const refs = input.work_decision_evidence_refs
        .map((value) => safeOptionalShortText(value))
        .filter((value): value is string => Boolean(value))
        .slice(0, 6);
      if (refs.length > 0) row.work_decision_evidence_refs = refs;
    }
  }
  const safeCount = Number(input.safe_count);
  if (Number.isFinite(safeCount) && safeCount >= 0)
    row.safe_count = Math.floor(safeCount);
  const safeOrder = Number(input.safe_order);
  if (Number.isFinite(safeOrder) && safeOrder >= 0)
    row.safe_order = Math.floor(safeOrder);
  if (Array.isArray(input.safe_path_labels)) {
    const labels = input.safe_path_labels
      .map((value) => safeOptionalShortText(value))
      .filter((value): value is string => Boolean(value))
      .slice(0, 12);
    if (labels.length > 0) row.safe_path_labels = labels;
  }
  if (Array.isArray(input.safe_detail_rows)) {
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
  return row;
}

export function publicProgressRowsForTurn(
  rows: ProgressSummaryRow[],
  turnState: TurnState | null | undefined,
): ProgressSummaryRow[] {
  return dedupeProgressRows(rows)
    .filter((row) => !terminalFailureProgressSupersededByTurn(row, turnState))
    .filter(isSessionSummaryProgressRow);
}

export function isInternalContinuationProgressEvent(
  event: Record<string, unknown> | null,
): boolean {
  if (!event || event.kind !== "tool.progress") return false;
  const payload = isRecord(event.payload) ? event.payload : null;
  if (!payload) return false;
  return safeOptionalShortToken(payload.activityKind) === "model" &&
    safeBooleanLike(payload.noVisibleReply) &&
    (
      safeBooleanLike(payload.continuationRequeued) ||
      safeBooleanLike(payload.continuation_requeued) ||
      safeBooleanLike(payload.recoveryRequeued) ||
      safeBooleanLike(payload.recovery_requeued)
    );
}

export function progressSummaryStatusLabel(
  row: ProgressSummaryRow,
): string | null {
  const label = (row.work_decision_summary ?? row.safe_label).trim();
  if (!label) return null;
  if (STATUS_ONLY_PROGRESS_LABELS.has(label.toLowerCase())) return null;
  return label;
}

export function progressRowsForTurnState(
  rows: ProgressSummaryRow[],
  turnState?: string,
): ProgressSummaryRow[] {
  if (!turnState || !isTerminalProgressState(turnState)) return rows;
  const rowState = progressRowStateForTerminalTurn(turnState);
  return rows.map((row) => {
    const safeDetailRows = row.safe_detail_rows?.map((detail) =>
      detail.state && !isTerminalProgressState(detail.state)
        ? { ...detail, state: rowState }
        : detail,
    );
    const nextRow = !isTerminalProgressState(row.state)
      ? { ...row, state: rowState }
      : row;
    if (!safeDetailRows) return nextRow;
    return { ...nextRow, safe_detail_rows: safeDetailRows };
  });
}

export function progressRowsEquivalent(
  left: ProgressSummaryRow,
  right: ProgressSummaryRow,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function isTerminalProgressState(state: string): boolean {
  return (
    state === "failed" ||
    state === "cancelled" ||
    state === "delivered" ||
    state === "complete" ||
    state === "completed"
  );
}

function dedupeProgressRows(rows: ProgressSummaryRow[]): ProgressSummaryRow[] {
  const byKey = new Map<string, ProgressSummaryRow>();
  for (const row of rows) {
    const directKey = progressRowDirectMergeKey(row);
    let key = directKey;
    const sameToolKey = row.tool_call_id
      ? findProgressRowKey(
          byKey,
          (candidate) => candidate.tool_call_id === row.tool_call_id,
        )
      : null;
    if (sameToolKey) {
      key = sameToolKey;
    } else if (row.tool_call_id && !byKey.has(directKey)) {
      const legacyCandidates = findProgressRowKeys(
        byKey,
        (candidate) =>
          !candidate.tool_call_id &&
          !isTerminalProgressState(candidate.state) &&
          progressRowsSemanticallyMatch(candidate, row),
      );
      if (legacyCandidates.length === 1) key = legacyCandidates[0]!;
    } else if (!row.tool_call_id && !isTerminalProgressState(row.state)) {
      const toolCandidates = findProgressRowKeys(
        byKey,
        (candidate) =>
          Boolean(candidate.tool_call_id) &&
          progressRowsSemanticallyMatch(candidate, row),
      );
      if (toolCandidates.length === 1) key = toolCandidates[0]!;
    }
    const previous = byKey.get(key);
    byKey.set(key, previous ? mergeProgressRow(previous, row) : row);
  }
  return [...byKey.values()];
}

function findProgressRowKey(
  rows: Map<string, ProgressSummaryRow>,
  predicate: (row: ProgressSummaryRow) => boolean,
): string | null {
  for (const [key, row] of rows) {
    if (predicate(row)) return key;
  }
  return null;
}

function findProgressRowKeys(
  rows: Map<string, ProgressSummaryRow>,
  predicate: (row: ProgressSummaryRow) => boolean,
): string[] {
  const matches: string[] = [];
  for (const [key, row] of rows) {
    if (predicate(row)) matches.push(key);
  }
  return matches;
}

function isSessionSummaryProgressRow(row: ProgressSummaryRow): boolean {
  if (row.kind === "work_block") return false;
  if (row.kind === "turn" || row.kind === "thinking") return false;
  if (row.kind === "message" || row.kind === "system") {
    return !STATUS_ONLY_PROGRESS_LABELS.has(
      row.safe_label.trim().toLowerCase(),
    );
  }
  return true;
}

function progressRowStateForTerminalTurn(turnState: string): string {
  if (turnState === "failed" || turnState === "cancelled") return turnState;
  return "delivered";
}

function progressRowDirectMergeKey(row: ProgressSummaryRow): string {
  if (row.kind === "work_block" && row.work_block_id)
    return `work:${row.work_block_id}`;
  const todoKey = todoProgressMergeKey(row);
  if (todoKey) return `todo:${todoKey}`;
  if (row.tool_call_id) return `tool:${row.tool_call_id}`;
  const semanticKey = progressRowSemanticMergeKey(row);
  if (semanticKey) return `activity:${semanticKey}:row:${row.id}`;
  return `row:${row.id}`;
}

function progressRowSemanticMergeKey(row: ProgressSummaryRow): string | null {
  if (row.kind === "message" || row.kind === "system") return null;
  const todoKey = todoProgressMergeKey(row);
  if (todoKey) return `todo:${todoKey}`;
  const semanticParts = [
    row.kind,
    row.safe_tool_name ?? "",
    row.safe_input_label ?? "",
    row.safe_label,
  ].map((part) => part.trim().toLowerCase());
  return row.safe_label ? semanticParts.join(":") : null;
}

function todoProgressMergeKey(row: ProgressSummaryRow): string | null {
  if (row.kind !== "todo") return null;
  const stableId = normalizeProgressPart(row.safe_input_label);
  if (stableId) return `id:${stableId}`;
  const label = normalizeTodoProgressLabel(row.safe_label);
  return label ? `label:${label}` : null;
}

function normalizeTodoProgressLabel(value?: string): string {
  return normalizeProgressPart(value)
    .replace(/\s*(?:하는\s*)?중입니다$/u, "")
    .replace(/\s*(?:하는\s*)?중$/u, "")
    .trim();
}

function progressRowsSemanticallyMatch(
  left: ProgressSummaryRow,
  right: ProgressSummaryRow,
): boolean {
  if (left.kind === "message" || left.kind === "system") return false;
  if (right.kind === "message" || right.kind === "system") return false;
  if (left.kind !== right.kind) return false;
  if (!progressRowsHaveCompatibleEvidence(left, right)) return false;
  const leftExact = progressRowSemanticMergeKey(left);
  const rightExact = progressRowSemanticMergeKey(right);
  if (leftExact && rightExact && leftExact === rightExact) return true;

  const leftLabel = normalizeProgressPart(left.safe_label);
  const rightLabel = normalizeProgressPart(right.safe_label);
  if (leftLabel && leftLabel === rightLabel) {
    const leftTool = normalizeProgressPart(left.safe_tool_name);
    const rightTool = normalizeProgressPart(right.safe_tool_name);
    const leftInput = normalizeProgressPart(left.safe_input_label);
    const rightInput = normalizeProgressPart(right.safe_input_label);
    const toolsCompatible = !leftTool || !rightTool || leftTool === rightTool;
    const inputsCompatible =
      !leftInput || !rightInput || leftInput === rightInput;
    return toolsCompatible && inputsCompatible;
  }

  const leftTool = normalizeProgressPart(left.safe_tool_name);
  const rightTool = normalizeProgressPart(right.safe_tool_name);
  const leftInput = normalizeProgressPart(left.safe_input_label);
  const rightInput = normalizeProgressPart(right.safe_input_label);
  return Boolean(
    leftTool &&
    rightTool &&
    leftInput &&
    rightInput &&
    leftTool === rightTool &&
    leftInput === rightInput,
  );
}

function progressRowsHaveCompatibleEvidence(
  left: ProgressSummaryRow,
  right: ProgressSummaryRow,
): boolean {
  if (
    left.work_block_id &&
    right.work_block_id &&
    left.work_block_id !== right.work_block_id
  )
    return false;
  if (
    !progressDetailRowsCompatible(left.safe_detail_rows, right.safe_detail_rows)
  )
    return false;
  if (left.safe_path_labels?.length && right.safe_path_labels?.length) {
    const rightPaths = new Set(
      right.safe_path_labels.map(normalizeProgressPart),
    );
    return left.safe_path_labels.some((pathLabel) =>
      rightPaths.has(normalizeProgressPart(pathLabel)),
    );
  }
  return true;
}

function progressDetailRowsCompatible(
  leftRows?: ProgressSummaryRow["safe_detail_rows"],
  rightRows?: ProgressSummaryRow["safe_detail_rows"],
): boolean {
  if (!leftRows?.length || !rightRows?.length) return true;
  const rightById = new Map(rightRows.map((row) => [row.id, row]));
  for (const leftRow of leftRows) {
    const rightRow = rightById.get(leftRow.id);
    if (!rightRow) continue;
    const leftValue = normalizeProgressPart(leftRow.safe_value);
    const rightValue = normalizeProgressPart(rightRow.safe_value);
    if (leftValue && rightValue && leftValue !== rightValue) return false;
  }
  return true;
}

function normalizeProgressPart(value?: string): string {
  return (value ?? "").trim().toLowerCase();
}

function mergeProgressRow(
  current: ProgressSummaryRow,
  incoming: ProgressSummaryRow,
): ProgressSummaryRow {
  const incomingWins =
    progressMergeState(current.state, incoming.state) === incoming.state;
  const base = incomingWins
    ? { ...current, ...incoming }
    : { ...incoming, ...current };
  return {
    ...base,
    state: progressMergeState(current.state, incoming.state),
    safe_label: base.safe_label || current.safe_label || incoming.safe_label,
    safe_tool_name:
      base.safe_tool_name ?? current.safe_tool_name ?? incoming.safe_tool_name,
    safe_input_label:
      base.safe_input_label ??
      current.safe_input_label ??
      incoming.safe_input_label,
    safe_detail_rows:
      base.safe_detail_rows ??
      current.safe_detail_rows ??
      incoming.safe_detail_rows,
    safe_order: base.safe_order ?? current.safe_order ?? incoming.safe_order,
    safe_path_labels:
      base.safe_path_labels ??
      current.safe_path_labels ??
      incoming.safe_path_labels,
    tool_call_id:
      base.tool_call_id ?? current.tool_call_id ?? incoming.tool_call_id,
    bridge_phase:
      base.bridge_phase ?? current.bridge_phase ?? incoming.bridge_phase,
    work_block_id:
      base.work_block_id ?? current.work_block_id ?? incoming.work_block_id,
    work_block_label:
      base.work_block_label ??
      current.work_block_label ??
      incoming.work_block_label,
    work_decision_summary:
      base.work_decision_summary ??
      current.work_decision_summary ??
      incoming.work_decision_summary,
    work_decision_rationale:
      base.work_decision_rationale ??
      current.work_decision_rationale ??
      incoming.work_decision_rationale,
    work_decision_next_step:
      base.work_decision_next_step ??
      current.work_decision_next_step ??
      incoming.work_decision_next_step,
    work_decision_source:
      base.work_decision_source ??
      current.work_decision_source ??
      incoming.work_decision_source,
    work_decision_evidence_refs:
      base.work_decision_evidence_refs ??
      current.work_decision_evidence_refs ??
      incoming.work_decision_evidence_refs,
    created_at: current.created_at ?? incoming.created_at,
  };
}

export function progressMergeState(current: string, incoming: string): string {
  if (isTerminalProgressState(incoming)) return incoming;
  if (isTerminalProgressState(current)) return current;
  return progressStateRank(incoming) >= progressStateRank(current)
    ? incoming
    : current;
}

function progressStateRank(state: string): number {
  if (state === "failed" || state === "cancelled") return 4;
  if (state === "delivered" || state === "complete" || state === "completed")
    return 3;
  if (state === "running" || state === "streaming") return 2;
  if (state === "thinking" || state === "accepted") return 1;
  return 0;
}

function terminalFailureProgressSupersededByTurn(
  row: ProgressSummaryRow,
  turnState: TurnState | null | undefined,
): boolean {
  if (turnState !== "delivered") return false;
  return row.kind === "turn" && row.state === "failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeBooleanLike(value: unknown): boolean {
  return value === true || value === "true";
}

function safeShortToken(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text && /^[\w:./-]+$/u.test(text) ? text.slice(0, 96) : fallback;
}

function safeOptionalShortToken(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || !/^[\w:./-]+$/u.test(text)) return undefined;
  return text.slice(0, 96);
}

function safeShortText(value: unknown, fallback: string): string {
  return safeOptionalShortText(value) ?? fallback;
}

function safeOptionalShortText(value: unknown): string | undefined {
  const text =
    typeof value === "string" ? stripControlCharacters(value).trim() : "";
  if (!text) return undefined;
  return text
    .replace(
      /\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+/giu,
      "[redacted]",
    )
    .replace(/\s+/gu, " ")
    .slice(0, 180);
}

function stripControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  }).join("");
}

function safeIsoDate(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value : "";
  return Number.isFinite(Date.parse(text)) ? text : fallback;
}
