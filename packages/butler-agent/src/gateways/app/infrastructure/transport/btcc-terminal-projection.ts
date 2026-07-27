import type { Database } from "bun:sqlite";
import type { TranscriptEvent } from "../../../../test-support/harness/transcripts.ts";
import { projectAppFinalResult } from "./final-result-projection.ts";
import type { AppTransportProjectionStoreOptions } from "./transport-projection-contract.ts";
import { loadBoundedTurnPage } from "./bounded-turn-page.ts";

type CanonicalDeliveryRow = {
  row_id: number;
  turn_id: string;
  chat_id: string;
  outbox_id: string;
  message_id: string;
  content: string;
  created_at: string;
};

export type TerminalDeliveryBatch = {
  applied: number;
  nextCursor: number;
  pending: boolean;
};

const TERMINAL_DELIVERY_BATCH_SIZE = 32;

export function reconcileBtccTerminalDeliveries(input: {
  options: AppTransportProjectionStoreOptions;
  hasProjectedAction(actionId: string): boolean;
  markProjectedAction(actionId: string, eventId: string, chatId: string): void;
  chatId?: string;
}): number {
  return reconcileBtccTerminalDeliveryBatch({
    ...input,
    afterRowId: 0,
  }).applied;
}

export function reconcileBtccTerminalDeliveryBatch(input: {
  options: AppTransportProjectionStoreOptions;
  hasProjectedAction(actionId: string): boolean;
  markProjectedAction(actionId: string, eventId: string, chatId: string): void;
  chatId?: string;
  afterRowId: number;
  limit?: number;
}): TerminalDeliveryBatch {
  const limit = input.limit ?? TERMINAL_DELIVERY_BATCH_SIZE;
  const page = loadBoundedTurnPage(
    input.options.db,
    input.afterRowId,
    limit,
  );
  const candidateTurnIds = page.rows
    .filter((row) =>
      row.state !== "delivered" && row.state !== "cancelled" &&
      (!input.chatId || row.chatId === input.chatId),
    )
    .map((row) => row.turnId);
  const batch = terminalDeliveries(input.options.db, candidateTurnIds);
  let projected = 0;
  for (const row of batch) {
    const actionId = `btcc-canonical-final:${row.outbox_id}`;
    if (input.hasProjectedAction(actionId)) continue;
    const event = terminalDeliveryEvent(row, actionId);
    if (projectAppFinalResult({
      options: input.options,
      markProjectedTransportEvent: input.markProjectedAction,
      chatId: row.chat_id,
      turnId: row.turn_id,
      actionId,
      event,
      message: event.payload.message as Record<string, unknown>,
      metadata: event.payload.metadata as Record<string, unknown>,
      terminalRecoverableCorrection: false,
      queuedFinalProjection: "accept",
    })) projected += 1;
  }
  return {
    applied: projected,
    nextCursor: page.nextCursor,
    pending: page.pending,
  };
}

function terminalDeliveries(
  db: Database,
  turnIds: string[],
): CanonicalDeliveryRow[] {
  if (turnIds.length === 0 || !terminalProjectionSchemaExists(db)) return [];
  const placeholders = turnIds.map(() => "?").join(", ");
  return db.query<
    CanonicalDeliveryRow,
    string[]
  >(`
      SELECT turns.rowid AS row_id, btcc_turns.turn_id, turns.chat_id, outbox.outbox_id,
        canonical.message_id, canonical.content, canonical.created_at
      FROM btcc_turns
      JOIN turns ON turns.id = btcc_turns.turn_id
      JOIN btcc_delivery_outbox AS outbox
        ON outbox.outbox_id = btcc_turns.delivery_outbox_id
      JOIN btcc_messages AS canonical
        ON canonical.message_id = btcc_turns.canonical_assistant_message_id
      WHERE turns.id IN (${placeholders})
        AND btcc_turns.semantic_state = 'delivered'
        AND btcc_turns.final_disposition = 'completed'
        AND outbox.status = 'observed'
        AND turns.state NOT IN ('delivered', 'cancelled')
      ORDER BY turns.rowid
    `).all(...turnIds);
}

function terminalProjectionSchemaExists(db: Database): boolean {
  const required = ["btcc_turns", "btcc_delivery_outbox", "btcc_messages"];
  const rows = db.query<{ name: string }, [string, string, string]>(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN (?, ?, ?)
  `).all(required[0]!, required[1]!, required[2]!);
  return rows.length === required.length;
}

function terminalDeliveryEvent(
  row: CanonicalDeliveryRow,
  actionId: string,
): TranscriptEvent {
  return {
    eventId: actionId,
    sessionId: row.chat_id,
    kind: "outbound",
    timestamp: row.created_at,
    transport: "app",
    payload: {
      actionId,
      message: { text: row.content },
      metadata: {
        source: "btcc-canonical-delivery-reconciliation",
        kind: "final_result",
        turnId: row.turn_id,
        canonicalMessageId: row.message_id,
      },
    },
  };
}
