import type { Database } from "bun:sqlite";
import { recordOperationalMetric } from
  "../../../../operations/metrics/operational-metrics.ts";
import { TerminalTurnRetention } from
  "../../infrastructure/retention/terminal-turn-retention.ts";
import {
  TerminalTurnRetentionQueue,
  type TerminalTurnRetentionPage,
} from "../../infrastructure/retention/terminal-turn-retention-queue.ts";
import type { AppStoreKernel } from "./app-store-kernel.ts";

export function initializeTerminalTurnRetention(
  kernel: AppStoreKernel,
): (event: { turnId: string; eventId: number }) => void {
  const transcriptRetention = {
    isSettled: (_turnId: string) => true,
  };
  kernel.terminalTurnRetention = new TerminalTurnRetention(
    kernel.db,
    transcriptRetention,
  );
  kernel.terminalTurnRetentionQueue = new TerminalTurnRetentionQueue({
    terminalTurnPage: (afterRowId, limit) =>
      terminalTurnPage(kernel.db, afterRowId, limit),
    compactTurn: (turnId) => {
      if (kernel.closed) return "not_ready";
      const turn = kernel.turns.getTurn(turnId);
      return kernel.terminalTurnRetention.compact({
        turnId: turn.id,
        chatId: turn.chat_id,
        state: turn.state,
        deliveryMetadata:
          kernel.sessionMessageProjection.explicitDeliveryMetadataForTurn(
            turn.id,
          ),
      });
    },
    recordFailure: (error) => recordRetentionFailure(kernel, error),
  });
  return ({ turnId, eventId }) => {
    kernel.terminalTurnRetentionQueue.advanceEventCursor(eventId);
    if (!kernel.closed && turnId && kernel.isTerminalTurn(turnId)) {
      kernel.terminalTurnRetentionQueue.schedule(turnId);
    }
  };
}

export function terminalTurnPage(
  db: Database,
  afterRowId: number,
  limit: number,
): TerminalTurnRetentionPage {
  if (hasTerminalSweepIndex(db)) {
    const rows = indexedTerminalTurnRows(db, afterRowId, limit + 1);
    const page = rows.slice(0, limit);
    return {
      turns: page.map((row) => ({ turnId: row.id, rowId: row.row_id })),
      nextCursor: page.at(-1)?.row_id ?? afterRowId,
      hasMore: rows.length > limit,
    };
  }
  const rawRows = db.query<
    { id: string; row_id: number; state: string },
    [number, number]
  >(`
    SELECT id, rowid AS row_id, state FROM turns NOT INDEXED
    WHERE rowid > ?
    ORDER BY rowid
    LIMIT ?
  `).all(afterRowId, limit + 1);
  const page = rawRows.slice(0, limit);
  const terminalStates = new Set([
    "delivered", "failed", "cancelled", "runtime_fault",
  ]);
  return {
    turns: page
      .filter((row) => terminalStates.has(row.state))
      .map((row) => ({ turnId: row.id, rowId: row.row_id })),
    nextCursor: page.at(-1)?.row_id ?? afterRowId,
    hasMore: rawRows.length > limit,
  };
}

function indexedTerminalTurnRows(
  db: Database,
  afterRowId: number,
  limit: number,
): Array<{ id: string; row_id: number }> {
  return ["delivered", "failed", "cancelled", "runtime_fault"]
    .flatMap((state) => db.query<
      { id: string; row_id: number },
      [string, number, number]
    >(`
      SELECT id, rowid AS row_id FROM turns INDEXED BY turns_state_rowid_idx
      WHERE state = ? AND rowid > ?
      ORDER BY rowid
      LIMIT ?
    `).all(state, afterRowId, limit))
    .sort((left, right) => left.row_id - right.row_id)
    .slice(0, limit);
}

function hasTerminalSweepIndex(db: Database): boolean {
  return Boolean(db.query<{ name: string }, []>(`
    SELECT name FROM sqlite_master
    WHERE type = 'index' AND name = 'turns_state_rowid_idx'
  `).get());
}

function recordRetentionFailure(kernel: AppStoreKernel, error: unknown): void {
  recordOperationalMetric({
    category: "maintenance",
    name: "app.terminal_turn_retention",
    status: "error",
    dimensions: {
      error_name: error instanceof Error ? error.name : "unknown",
    },
  }, { butlerData: kernel.butlerData });
}
