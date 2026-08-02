import type {
  MessageRecord,
  ProgressRow,
  TurnProgressSnapshot,
  WorkBlockView,
} from "../types.ts";
import { projectCompletedWorkBlocks } from "./activity.ts";
import { isInternalProgressRow } from "./progress-rows.ts";

const TOOL_ACTIVITY_KINDS = new Set([
  "searched",
  "read",
  "ran_command",
  "edited",
  "dispatch",
  "used_tool",
]);
const FIRST_PROGRESS_PREFIX = "first-progress-";

export function freezeConversationActivity(
  messages: MessageRecord[],
  turnProgress: Record<string, TurnProgressSnapshot>,
): MessageRecord[] {
  let changed = false;
  const next = messages.map((message) => {
    const frozen = freezeMessageActivity(
      message,
      message.turn_id ? turnProgress[message.turn_id] : undefined,
    );
    if (frozen !== message) changed = true;
    return frozen;
  });
  return changed ? next : messages;
}

export function freezeMessageActivity(
  message: MessageRecord,
  snapshot: TurnProgressSnapshot | null | undefined,
): MessageRecord {
  if (message.role !== "assistant" || !message.turn_id) return message;
  const activity = freezePhaseActivity(message, snapshot);
  const clean = sanitizeWorkBlocks(activity);
  const blocks = completedWorkBlocks(
    snapshot,
    terminalStateFromMessageStatus(message.status),
  );
  if (blocks.length === 0) return clean;
  if (clean.work_blocks && workBlocksEqual(clean.work_blocks, blocks)) return clean;
  return { ...clean, work_blocks: blocks };
}

export function completedWorkBlocks(
  snapshot: TurnProgressSnapshot | null | undefined,
  terminalStateOverride?: string,
): WorkBlockView[] {
  if (!snapshot) return [];
  const state = terminalStateOverride ?? snapshot.state ?? "";
  const rows = isTerminal(state)
    ? (snapshot.safe_progress_rows ?? [])
        .filter((row) => !isFirstVisibleProgressRow(row))
        .map((row) => isTerminal(row.state) ? row : { ...row, state })
    : (snapshot.safe_progress_rows ?? []);
  return projectCompletedWorkBlocks(rows).filter((block) =>
    block.rows.some((row) => isVisibleToolActivity(row, block.label)),
  );
}

export function isVisibleToolActivity(
  row: ProgressRow,
  blockLabel: string,
): boolean {
  const label = row.safe_label.trim();
  const block = blockLabel.trim();
  const toolName = row.safe_tool_name?.trim();
  if (isInternalProgressRow(row) || row.kind === "todo" || row.kind === "message")
    return false;
  if (label && label === block && !row.safe_input_label) return false;
  if (
    toolName && toolName === block && !row.tool_call_id &&
    !row.safe_input_label && !row.safe_detail_rows?.length
  ) return false;
  return Boolean(
    row.tool_call_id || row.safe_input_label || row.safe_detail_rows?.length ||
    TOOL_ACTIVITY_KINDS.has(row.kind ?? ""),
  );
}

function freezePhaseActivity(
  message: MessageRecord,
  snapshot: TurnProgressSnapshot | null | undefined,
): MessageRecord {
  const rows = (snapshot?.safe_progress_rows ?? []).filter(isRetainedActivityRow);
  if (rows.length === 0) return message;
  if (message.turn_activity_rows && progressRowsEqual(message.turn_activity_rows, rows))
    return message;
  return { ...message, turn_activity_rows: rows };
}

function isRetainedActivityRow(row: ProgressRow): boolean {
  if (row.kind === "todo" && row.bridge_phase === "btcc_work_ledger") return true;
  if (row.bridge_phase === "btcc_operation" && row.semantic_block_id) return true;
  return Boolean(
    row.kind === "message" && !row.work_block_id && row.semantic_block_id &&
    row.work_decision_source === "model-authored" && row.work_decision_summary,
  );
}

function sanitizeWorkBlocks(message: MessageRecord): MessageRecord {
  const blocks = message.work_blocks;
  if (!blocks) return message;
  let changed = false;
  const sanitized: WorkBlockView[] = [];
  for (const block of blocks) {
    const rows = block.rows.filter((row) => isVisibleToolActivity(row, block.label));
    if (rows.length === 0) {
      changed = true;
      continue;
    }
    if (rows.length !== block.rows.length) {
      changed = true;
      sanitized.push({ ...block, rows });
    } else {
      sanitized.push(block);
    }
  }
  if (!changed) return message;
  if (sanitized.length > 0) return { ...message, work_blocks: sanitized };
  const { work_blocks: _workBlocks, ...rest } = message;
  return rest;
}

function terminalStateFromMessageStatus(
  status?: MessageRecord["status"],
): string | undefined {
  if (status === "delivered") return "delivered";
  if (status === "failed") return "failed";
  return undefined;
}

function isFirstVisibleProgressRow(row: ProgressRow): boolean {
  return row.kind === "message" &&
    Boolean(row.work_block_id?.startsWith(FIRST_PROGRESS_PREFIX));
}

function isTerminal(state: string): boolean {
  return ["failed", "cancelled", "delivered", "complete", "completed", "stopped"]
    .includes(state);
}

function workBlocksEqual(left: WorkBlockView[], right: WorkBlockView[]): boolean {
  return left.length === right.length && left.every((block, index) => {
    const other = right[index]!;
    return block.id === other.id && block.label === other.label &&
      block.state === other.state && block.decision_title === other.decision_title &&
      block.decision_summary === other.decision_summary &&
      block.decision_rationale === other.decision_rationale &&
      block.decision_next_step === other.decision_next_step &&
      block.decision_source === other.decision_source &&
      block.created_at === other.created_at && progressRowsEqual(block.rows, other.rows) &&
      JSON.stringify(block.decision_evidence_refs ?? []) ===
        JSON.stringify(other.decision_evidence_refs ?? []);
  });
}

function progressRowsEqual(left: ProgressRow[], right: ProgressRow[]): boolean {
  return left.length === right.length && left.every((row, index) => {
    const other = right[index]!;
    return row.id === other.id && row.kind === other.kind && row.state === other.state &&
      row.safe_label === other.safe_label && row.safe_tool_name === other.safe_tool_name &&
      row.safe_input_label === other.safe_input_label && row.safe_order === other.safe_order &&
      row.turn_event_sequence === other.turn_event_sequence &&
      row.tool_call_id === other.tool_call_id && row.tool_result_id === other.tool_result_id &&
      row.tool_result_byte_length === other.tool_result_byte_length &&
      row.work_contract_id === other.work_contract_id && row.work_stream_id === other.work_stream_id &&
      row.semantic_block_id === other.semantic_block_id && row.work_block_id === other.work_block_id &&
      row.work_block_label === other.work_block_label && row.work_block_phase === other.work_block_phase &&
      row.work_block_sequence === other.work_block_sequence && row.work_decision_id === other.work_decision_id &&
      row.work_decision_title === other.work_decision_title &&
      row.work_decision_summary === other.work_decision_summary &&
      row.work_decision_rationale === other.work_decision_rationale &&
      row.work_decision_next_step === other.work_decision_next_step &&
      row.work_decision_source === other.work_decision_source && row.created_at === other.created_at &&
      JSON.stringify(row.work_decision_evidence_refs ?? []) ===
        JSON.stringify(other.work_decision_evidence_refs ?? []) &&
      JSON.stringify(row.safe_path_labels ?? []) === JSON.stringify(other.safe_path_labels ?? []) &&
      JSON.stringify(row.safe_detail_rows ?? []) === JSON.stringify(other.safe_detail_rows ?? []);
  });
}
