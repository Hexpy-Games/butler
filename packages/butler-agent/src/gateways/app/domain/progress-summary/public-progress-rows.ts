import { FIRST_VISIBLE_PROGRESS_WORK_BLOCK_PREFIX } from "../../../../agent/events/first-visible-progress.ts";
import type { ProgressSummaryRow, TurnState } from "../../interface/protocol/app-protocol.ts";
import {
  dedupeProgressRows,
  isTerminalProgressState,
} from "./progress-row-merge.ts";
import {
  isRecord,
  safeBooleanLike,
  safeOptionalShortToken,
} from "./safe-progress-values.ts";

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
  return (
    safeOptionalShortToken(payload.activityKind) === "model" &&
    safeBooleanLike(payload.noVisibleReply) &&
    (safeBooleanLike(payload.continuationRequeued) ||
      safeBooleanLike(payload.continuation_requeued) ||
      safeBooleanLike(payload.recoveryRequeued) ||
      safeBooleanLike(payload.recovery_requeued))
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
  return rows
    .filter((row) => !isFirstVisibleProgressRow(row))
    .map((row) => {
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

function isFirstVisibleProgressRow(row: ProgressSummaryRow): boolean {
  return (
    row.kind === "message" &&
    Boolean(
      row.work_block_id?.startsWith(
        `${FIRST_VISIBLE_PROGRESS_WORK_BLOCK_PREFIX}-`,
      ),
    )
  );
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

function terminalFailureProgressSupersededByTurn(
  row: ProgressSummaryRow,
  turnState: TurnState | null | undefined,
): boolean {
  if (turnState !== "delivered") return false;
  return row.kind === "turn" && row.state === "failed";
}
