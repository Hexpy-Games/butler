import type { ProgressSummaryRow } from "../../interface/protocol/app-protocol.ts";

export function dedupeProgressRows(
  rows: ProgressSummaryRow[],
): ProgressSummaryRow[] {
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
    state === "completed" ||
    state === "stopped"
  );
}

export function progressMergeState(current: string, incoming: string): string {
  if (isTerminalProgressState(incoming)) return incoming;
  if (isTerminalProgressState(current)) return current;
  return progressStateRank(incoming) >= progressStateRank(current)
    ? incoming
    : current;
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

function progressRowDirectMergeKey(row: ProgressSummaryRow): string {
  if (row.kind === "work_block" && row.work_block_id) {
    return `work-event:${row.id}`;
  }
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
  const stableId = normalizeProgressPart(row.safe_input_label ?? row.id);
  return stableId ? `id:${stableId}` : null;
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
    left.semantic_block_id &&
    right.semantic_block_id &&
    left.semantic_block_id !== right.semantic_block_id
  )
    return false;
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
  if (isCanonicalWorkTaskRow(current) && isCanonicalWorkTaskRow(incoming)) {
    const next = {
      ...current,
      ...incoming,
      created_at: current.created_at,
      safe_order: minimumOptionalNumber(current.safe_order, incoming.safe_order),
    };
    return progressRowsEquivalent(current, next) ? current : next;
  }
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
    safe_order:
      current.kind === "todo" && incoming.kind === "todo"
        ? minimumOptionalNumber(current.safe_order, incoming.safe_order)
        : base.safe_order ?? current.safe_order ?? incoming.safe_order,
    safe_path_labels:
      base.safe_path_labels ??
      current.safe_path_labels ??
      incoming.safe_path_labels,
    tool_call_id:
      base.tool_call_id ?? current.tool_call_id ?? incoming.tool_call_id,
    tool_result_id:
      base.tool_result_id ?? current.tool_result_id ?? incoming.tool_result_id,
    tool_result_byte_length:
      base.tool_result_byte_length ??
      current.tool_result_byte_length ??
      incoming.tool_result_byte_length,
    bridge_phase:
      base.bridge_phase ?? current.bridge_phase ?? incoming.bridge_phase,
    turn_event_sequence: minimumOptionalNumber(
      current.turn_event_sequence,
      incoming.turn_event_sequence,
    ),
    work_contract_id:
      base.work_contract_id ?? current.work_contract_id ?? incoming.work_contract_id,
    work_stream_id:
      base.work_stream_id ?? current.work_stream_id ?? incoming.work_stream_id,
    semantic_block_id:
      base.semantic_block_id ?? current.semantic_block_id ?? incoming.semantic_block_id,
    work_block_id:
      base.work_block_id ?? current.work_block_id ?? incoming.work_block_id,
    work_block_label:
      base.work_block_label ??
      current.work_block_label ??
      incoming.work_block_label,
    work_block_phase:
      base.work_block_phase ??
      current.work_block_phase ??
      incoming.work_block_phase,
    work_block_sequence:
      base.work_block_sequence ??
      current.work_block_sequence ??
      incoming.work_block_sequence,
    work_decision_id:
      base.work_decision_id ??
      current.work_decision_id ??
      incoming.work_decision_id,
    work_decision_title:
      base.work_decision_title ??
      current.work_decision_title ??
      incoming.work_decision_title,
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
    public_decision_model_call_id:
      base.public_decision_model_call_id ??
      current.public_decision_model_call_id ??
      incoming.public_decision_model_call_id,
    public_decision_latency_ms:
      base.public_decision_latency_ms ??
      current.public_decision_latency_ms ??
      incoming.public_decision_latency_ms,
    created_at: current.created_at ?? incoming.created_at,
  };
}

function isCanonicalWorkTaskRow(row: ProgressSummaryRow): boolean {
  return row.kind === "todo" && row.bridge_phase === "btcc_work_ledger";
}

function minimumOptionalNumber(
  left: number | undefined,
  right: number | undefined,
): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.min(left, right);
}

function progressStateRank(state: string): number {
  if (state === "failed" || state === "cancelled") return 4;
  if (state === "delivered" || state === "complete" || state === "completed") {
    return 3;
  }
  if (state === "running" || state === "streaming") return 2;
  if (state === "thinking" || state === "accepted") return 1;
  return 0;
}
