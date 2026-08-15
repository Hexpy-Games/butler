import type { ProgressRow } from "../types.ts";
import type { PhaseActivity } from "./activity.ts";

/**
 * Presentation-only grouping for orphan ordinary-tool rows. It deliberately
 * carries no phase, Work, or authority fields and is scoped to one Turn.
 */
export function fallbackOrdinaryActivity(
  rows: ProgressRow[],
  turnId?: string,
): PhaseActivity[] {
  const resolvedTurnId = resolveTurnId(rows, turnId);
  if (!resolvedTurnId) return [];
  const operations = dedupeOrdinaryOperations(rows, resolvedTurnId);
  if (operations.length === 0) return [];
  const first = operations[0];
  return [{
    id: first.semantic_block_id?.trim() || `turn:${resolvedTurnId}:ordinary`,
    title: "작업 중",
    summary: "작업 중",
    createdAt: first.created_at,
    operations,
  }];
}

function resolveTurnId(rows: ProgressRow[], turnId?: string): string | undefined {
  const explicitTurnId = turnId?.trim();
  if (explicitTurnId) return explicitTurnId;
  const rowTurnIds = new Set(rows.map((row) => row.turn_id?.trim()).filter(Boolean));
  if (rowTurnIds.size !== 1) return undefined;
  const [resolvedTurnId] = rowTurnIds;
  return resolvedTurnId;
}

function dedupeOrdinaryOperations(rows: ProgressRow[], turnId: string): ProgressRow[] {
  const seenToolCallIds = new Set<string>();
  const seenRowIds = new Set<string>();
  const operations: ProgressRow[] = [];
  for (const row of rows) {
    if (
      row.bridge_phase !== "btcc_operation" ||
      (row.turn_id !== undefined && row.turn_id.trim() !== turnId) ||
      row.work_block_id ||
      row.work_contract_id ||
      row.work_stream_id
    ) continue;
    const toolCallId = row.tool_call_id?.trim();
    if (seenRowIds.has(row.id) || (toolCallId && seenToolCallIds.has(toolCallId))) continue;
    seenRowIds.add(row.id);
    if (toolCallId) seenToolCallIds.add(toolCallId);
    operations.push(row);
  }
  return operations;
}
