import {
  SHARED_WORK_BLOCK_MARKER_KIND,
  type SharedProgressRow,
} from "./progress-projection-contract.ts";
import {
  isLegacyDecisionCarrier,
  isTerminalProgressState,
  isToolActivityRow,
  mergeProgressState,
  mergeToolRow,
  sortProjectionRows,
  stripBlockFields,
} from "./shared-progress-row-operations.ts";

export interface SharedProjectedWorkBlock<Row extends SharedProgressRow> {
  id: string;
  label: string;
  state: string;
  rows: Row[];
  decision_title?: string;
  decision_summary?: string;
  decision_rationale?: string;
  decision_next_step?: string;
  decision_source?: string;
  decision_evidence_refs?: string[];
  created_at?: string;
}

export type SharedProgressProjectionIssueCode =
  | "block_reopened"
  | "block_updated_before_start"
  | "block_completed_before_start"
  | "new_block_before_previous_closed"
  | "tool_for_unknown_block"
  | "tool_for_closed_block"
  | "tool_for_noncurrent_block";

export interface SharedProgressProjectionIssue {
  code: SharedProgressProjectionIssueCode;
  rowId: string;
  workBlockId: string;
}

export interface SharedProgressProjection<Row extends SharedProgressRow> {
  blocks: SharedProjectedWorkBlock<Row>[];
  issues: SharedProgressProjectionIssue[];
}

interface MutableProjectedWorkBlock<Row extends SharedProgressRow>
  extends SharedProjectedWorkBlock<Row> {
  closed: boolean;
  rowMap: Map<string, Row>;
}

export class SharedProgressReducer<Row extends SharedProgressRow> {
  readonly #blocks = new Map<string, MutableProjectedWorkBlock<Row>>();
  readonly #processedRowIds = new Set<string>();
  readonly #issues: SharedProgressProjectionIssue[] = [];
  #currentOpenBlockId: string | null = null;

  append(row: Row): void {
    if (this.#processedRowIds.has(row.id)) return;
    this.#processedRowIds.add(row.id);
    if (row.kind === SHARED_WORK_BLOCK_MARKER_KIND) {
      this.#appendBlockMarker(row);
      return;
    }
    if (isLegacyDecisionCarrier(row)) {
      const block = this.#ensureCompatibilityBlock(row, undefined, true);
      block.rowMap.set(`row:${row.id}`, stripBlockFields(row));
      block.rows = [...block.rowMap.values()];
      return;
    }
    if (row.bridge_phase === "btcc_operation") return;
    if (!isToolActivityRow(row)) return;
    this.#appendToolRow(row);
  }

  snapshot(options: { completedOnly?: boolean } = {}): SharedProgressProjection<Row> {
    const blocks = [...this.#blocks.values()]
      .filter((block) => Boolean(block.label.trim()))
      .filter((block) =>
        options.completedOnly
          ? block.closed || isTerminalProgressState(block.state)
          : true,
      )
      .map(({ closed: _closed, rowMap: _rowMap, ...block }) => ({
        ...block,
        rows: [...block.rows],
      }));
    return { blocks, issues: [...this.#issues] };
  }

  #appendBlockMarker(row: Row): void {
    const id = row.work_block_id;
    if (!id) return;
    const phase = row.work_block_phase;
    const existing = this.#blocks.get(id);
    if (!phase) {
      const block = existing ?? this.#openBlock(row, id, true);
      block.state = mergeProgressState(block.state, row.state);
      return;
    }
    if (phase === "started") {
      if (existing?.closed) {
        this.#issue("block_reopened", row, id);
        return;
      }
      if (existing) return;
      if (this.#currentOpenBlockId && this.#currentOpenBlockId !== id) {
        this.#issue("new_block_before_previous_closed", row, id);
        return;
      }
      this.#openBlock(row, id, true);
      return;
    }
    if (!existing) {
      this.#issue(
        phase === "updated"
          ? "block_updated_before_start"
          : "block_completed_before_start",
        row,
        id,
      );
      return;
    }
    if (existing.closed) {
      this.#issue("block_reopened", row, id);
      return;
    }
    if (phase === "updated") {
      existing.state = mergeProgressState(existing.state, row.state);
      return;
    }
    this.#closeBlock(existing, row.state);
  }

  #appendToolRow(row: Row): void {
    const id = row.work_block_id ?? `unbound:${row.tool_call_id ?? row.id}`;
    let block = this.#blocks.get(id);
    if (!block && isExplicitBlockBinding(row)) {
      this.#issue("tool_for_unknown_block", row, id);
      return;
    }
    if (!block) block = this.#ensureCompatibilityBlock(row, id, false);
    if (block.closed) {
      this.#issue("tool_for_closed_block", row, id);
      return;
    }
    if (this.#currentOpenBlockId !== id) {
      this.#issue("tool_for_noncurrent_block", row, id);
      return;
    }
    const key = row.tool_call_id ? `tool:${row.tool_call_id}` : `row:${row.id}`;
    const previous = block.rowMap.get(key);
    const next = previous ? mergeToolRow(previous, row) : stripBlockFields(row);
    block.rowMap.set(key, next);
    block.rows = [...block.rowMap.values()];
    block.state = mergeProgressState(block.state, row.state);
  }

  #ensureCompatibilityBlock(
    row: Row,
    id = row.work_block_id ?? `row:${row.id}`,
    carryDecision = false,
  ) {
    const existing = this.#blocks.get(id);
    if (existing) return existing;
    return this.#openBlock(row, id, carryDecision);
  }

  #openBlock(
    row: Row,
    id: string,
    carryDecision: boolean,
  ): MutableProjectedWorkBlock<Row> {
    if (this.#currentOpenBlockId && this.#currentOpenBlockId !== id) {
      const current = this.#blocks.get(this.#currentOpenBlockId);
      if (current && !current.closed) {
        current.closed = true;
        this.#issue("new_block_before_previous_closed", row, id);
      }
    }
    const block: MutableProjectedWorkBlock<Row> = {
      id,
      label:
        row.work_decision_title ??
        row.work_block_label ??
        (row.work_block_id ? "" : row.safe_label),
      state: row.state,
      rows: [],
      rowMap: new Map(),
      closed: false,
      decision_title: carryDecision ? row.work_decision_title : undefined,
      decision_summary: carryDecision ? row.work_decision_summary : undefined,
      decision_rationale: carryDecision ? row.work_decision_rationale : undefined,
      decision_next_step: carryDecision ? row.work_decision_next_step : undefined,
      decision_source: carryDecision ? row.work_decision_source : undefined,
      decision_evidence_refs: carryDecision
        ? row.work_decision_evidence_refs
        : undefined,
      created_at: row.created_at,
    };
    this.#blocks.set(id, block);
    this.#currentOpenBlockId = id;
    return block;
  }

  #closeBlock(block: MutableProjectedWorkBlock<Row>, state: string): void {
    block.state = mergeProgressState(block.state, state);
    block.closed = true;
    if (this.#currentOpenBlockId === block.id) this.#currentOpenBlockId = null;
  }

  #issue(
    code: SharedProgressProjectionIssueCode,
    row: Row,
    workBlockId: string,
  ): void {
    this.#issues.push({ code, rowId: row.id, workBlockId });
  }
}

function isExplicitBlockBinding(row: SharedProgressRow): boolean {
  return Boolean(row.work_decision_id || row.work_block_sequence !== undefined);
}

export function projectSharedWorkBlocks<Row extends SharedProgressRow>(
  rows: Row[],
  options: { completedOnly?: boolean } = {},
): SharedProgressProjection<Row> {
  const reducer = new SharedProgressReducer<Row>();
  for (const row of sortProjectionRows(rows)) reducer.append(row);
  return reducer.snapshot(options);
}
