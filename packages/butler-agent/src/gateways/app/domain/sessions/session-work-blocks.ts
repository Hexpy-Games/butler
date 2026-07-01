import type {
  ProgressSummaryRow,
  WorkerActivityWorkBlock,
} from "../../interface/protocol/app-protocol.ts";
import { progressMergeState } from "../progress-summary/progress-row-merge.ts";
import { isPublicDecisionSource } from "../progress-summary/public-decision-source.ts";

export function workBlocksFromTerminalProgressRows(
  rows: ProgressSummaryRow[],
): WorkerActivityWorkBlock[] {
  const blocks = new Map<string, WorkerActivityWorkBlock>();
  const decisionWorkBlockAliases = new Map<string, string>();
  const canonicalWorkBlockId = (
    row: ProgressSummaryRow,
    fallbackId: string,
  ) => {
    const decisionKey = publicDecisionIntentKey(row);
    if (!decisionKey) return fallbackId;
    const existing = decisionWorkBlockAliases.get(decisionKey);
    if (existing) return existing;
    decisionWorkBlockAliases.set(decisionKey, fallbackId);
    return fallbackId;
  };
  const workBlockLabels = new Set(
    rows
      .filter(
        (row) =>
          row.kind === "work_block" ||
          Boolean(row.work_block_label),
      )
      .map((row) => (row.work_block_label ?? "").trim())
      .filter(Boolean),
  );
  const sortedRows = rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const orderDelta =
        progressRowDisplayOrder(left.row) - progressRowDisplayOrder(right.row);
      return orderDelta || left.index - right.index;
    })
    .map(({ row }) => row);
  for (const row of sortedRows) {
    if (!isUserVisibleWorkBlockRow(row)) continue;
    if (row.kind === "todo" && workBlockLabels.has(row.safe_label.trim())) {
      continue;
    }
    const fallbackId =
      row.work_block_id ??
      row.tool_call_id ??
      `work-${row.kind}-${row.id}`.replace(/[^a-zA-Z0-9._:-]/gu, "-");
    const id = canonicalWorkBlockId(row, fallbackId);
    const label = row.work_block_label ?? "";
    const decision = isWorkBlockDecisionCarrierRow(row)
      ? publicDecisionFieldsFromProgressRow(row)
      : {};
    const previous = blocks.get(id);
    const blockRow = workBlockToolRow(row);
    if (previous) {
      if (row.kind !== "work_block") previous.rows.push(blockRow);
      previous.state = progressMergeState(previous.state, row.state);
      continue;
    }
    blocks.set(id, {
      id,
      label,
      state: row.state,
      rows: row.kind === "work_block" ? [] : [blockRow],
      decision_summary: decision.decision_summary,
      decision_rationale: decision.decision_rationale,
      decision_next_step: decision.decision_next_step,
      decision_source: decision.decision_source,
      decision_evidence_refs: decision.decision_evidence_refs,
      created_at: row.created_at,
    });
  }
  return [...blocks.values()]
    .filter((block) => block.rows.length > 0 && Boolean(block.label.trim()))
    .sort((left, right) => {
      const orderDelta =
        progressRowDisplayOrder(left.rows[0]) -
        progressRowDisplayOrder(right.rows[0]);
      return (
        orderDelta ||
        String(left.created_at ?? "").localeCompare(
          String(right.created_at ?? ""),
        )
      );
    });
}

function workBlockToolRow(row: ProgressSummaryRow): ProgressSummaryRow {
  const {
    work_block_id: _workBlockId,
    work_block_label: _workBlockLabel,
    work_decision_summary: _workDecisionSummary,
    work_decision_rationale: _workDecisionRationale,
    work_decision_next_step: _workDecisionNextStep,
    work_decision_source: _workDecisionSource,
    work_decision_evidence_refs: _workDecisionEvidenceRefs,
    ...toolRow
  } = row;
  return toolRow;
}

function progressRowDisplayOrder(row?: ProgressSummaryRow): number {
  const order = Number(row?.safe_order);
  return Number.isFinite(order) && order >= 0
    ? order
    : Number.POSITIVE_INFINITY;
}

function publicDecisionFieldsFromProgressRow(row: ProgressSummaryRow): Partial<{
  decision_summary: string;
  decision_rationale: string;
  decision_next_step: string;
  decision_source: string;
  decision_evidence_refs: string[];
}> {
  if (!isPublicDecisionSource(row.work_decision_source)) return {};
  return {
    decision_summary: row.work_decision_summary,
    decision_rationale: row.work_decision_rationale,
    decision_next_step: row.work_decision_next_step,
    decision_source: row.work_decision_source,
    decision_evidence_refs: row.work_decision_evidence_refs,
  };
}

function isUserVisibleWorkBlockRow(row: ProgressSummaryRow): boolean {
  if (row.kind === "todo") return false;
  if (row.kind === "message") {
    return Boolean(row.work_block_id && row.work_block_label);
  }
  if (row.kind === "system") return false;
  if (row.kind === "thinking" || row.kind === "worked_duration") return false;
  if (row.kind === "dispatch" && !row.tool_call_id) return false;
  return Boolean(
    row.work_block_id ||
    row.work_block_label ||
    row.safe_tool_name ||
    row.safe_input_label ||
    row.safe_detail_rows?.length,
  );
}

function isWorkBlockDecisionCarrierRow(row?: ProgressSummaryRow): boolean {
  if (!row) return false;
  return row.kind === "work_block" ||
    (row.kind === "message" && Boolean(row.work_block_id && row.work_block_label));
}

function publicDecisionIntentKey(row?: ProgressSummaryRow): string | null {
  if (!row || !isPublicDecisionSource(row.work_decision_source)) return null;
  const summary = normalizedDecisionIntentPart(row.work_decision_summary);
  if (!summary) return null;
  return JSON.stringify([
    row.work_decision_source,
    summary,
    normalizedDecisionIntentPart(row.work_decision_rationale),
    normalizedDecisionIntentPart(row.work_decision_next_step),
  ]);
}

function normalizedDecisionIntentPart(value?: string): string {
  return (value ?? "").replace(/\s+/gu, " ").trim();
}
