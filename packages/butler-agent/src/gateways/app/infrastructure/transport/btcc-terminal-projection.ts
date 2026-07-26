import type { Database } from "bun:sqlite";
import type { TranscriptEvent } from "../../../../test-support/harness/transcripts.ts";
import { projectAppFinalResult } from "./final-result-projection.ts";
import type { AppTransportProjectionStoreOptions } from "./transport-projection-contract.ts";

type CanonicalDeliveryRow = {
  turn_id: string;
  chat_id: string;
  outbox_id: string;
  message_id: string;
  content: string;
  created_at: string;
};

export function reconcileBtccTerminalDeliveries(input: {
  options: AppTransportProjectionStoreOptions;
  hasProjectedAction(actionId: string): boolean;
  markProjectedAction(actionId: string, eventId: string, chatId: string): void;
  chatId?: string;
}): number {
  const rows = terminalDeliveries(input.options.db, input.chatId);
  let projected = 0;
  for (const row of rows) {
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
  return projected;
}

function terminalDeliveries(
  db: Database,
  chatId?: string,
): CanonicalDeliveryRow[] {
  try {
    return db.query<CanonicalDeliveryRow, [string | null, string | null]>(`
      SELECT btcc_turns.turn_id, turns.chat_id, outbox.outbox_id,
        canonical.message_id, canonical.content, canonical.created_at
      FROM btcc_turns
      JOIN turns ON turns.id = btcc_turns.turn_id
      JOIN btcc_delivery_outbox AS outbox
        ON outbox.outbox_id = btcc_turns.delivery_outbox_id
      JOIN btcc_messages AS canonical
        ON canonical.message_id = btcc_turns.canonical_assistant_message_id
      WHERE btcc_turns.semantic_state = 'delivered'
        AND btcc_turns.final_disposition = 'completed'
        AND outbox.status = 'observed'
        AND turns.state NOT IN ('delivered', 'cancelled')
        AND (? IS NULL OR turns.chat_id = ?)
      ORDER BY turns.rowid
    `).all(chatId ?? null, chatId ?? null);
  } catch {
    return [];
  }
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
