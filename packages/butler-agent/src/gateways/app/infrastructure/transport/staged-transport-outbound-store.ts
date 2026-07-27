import type { Database } from "bun:sqlite";
import type { TranscriptEvent } from "../../../../test-support/harness/transcripts.ts";

export type StagedTransportOutboundState =
  | "awaiting_delivery"
  | "deferred_final";

export type StagedTransportOutbound = {
  actionId: string;
  chatId: string;
  event: TranscriptEvent;
  state: StagedTransportOutboundState;
};

export type StagedOutboundBatch = {
  rows: StagedTransportOutbound[];
  nextCursor: string;
  pending: boolean;
};

const STAGED_OUTBOUND_BATCH = 32;

export class StagedTransportOutboundStore {
  constructor(private readonly db: Database) {}

  stage(input: StagedTransportOutbound): void {
    const now = new Date().toISOString();
    const eventJson = JSON.stringify(input.event);
    this.db.query(`
      INSERT OR IGNORE INTO app_transport_projection_staged_outbounds (
        action_id, chat_id, event_json, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.actionId,
      input.chatId,
      eventJson,
      input.state,
      now,
      now,
    );
    const stored = this.db.query<StagedOutboundRow, [string]>(`
      SELECT action_id, chat_id, event_json, state
      FROM app_transport_projection_staged_outbounds WHERE action_id = ?
    `).get(input.actionId);
    if (
      stored?.chat_id !== input.chatId || stored.event_json !== eventJson ||
      stored.state !== input.state
    ) {
      throw new Error("Transport staged outbound identity conflict");
    }
  }

  load(actionId: string): StagedTransportOutbound | null {
    const row = this.db.query<StagedOutboundRow, [string]>(`
      SELECT action_id, chat_id, event_json, state
      FROM app_transport_projection_staged_outbounds
      WHERE action_id = ?
    `).get(actionId);
    return row ? decodeRow(row) : null;
  }

  delete(actionId: string): void {
    this.db.query(`
      DELETE FROM app_transport_projection_staged_outbounds WHERE action_id = ?
    `).run(actionId);
  }

  listDeferredBatch(
    afterActionId: string,
    limit = STAGED_OUTBOUND_BATCH,
  ): StagedOutboundBatch {
    const rows = this.db.query<StagedOutboundRow, [string, number]>(`
      SELECT action_id, chat_id, event_json, state
      FROM app_transport_projection_staged_outbounds
      WHERE state = 'deferred_final' AND action_id > ?
      ORDER BY action_id
      LIMIT ?
    `).all(afterActionId, limit + 1);
    const batch = rows.slice(0, limit);
    return {
      rows: batch.map(decodeRow),
      nextCursor: batch.at(-1)?.action_id ?? afterActionId,
      pending: rows.length > limit,
    };
  }
}

type StagedOutboundRow = {
  action_id: string;
  chat_id: string;
  event_json: string;
  state: StagedTransportOutboundState;
};

function decodeRow(row: StagedOutboundRow): StagedTransportOutbound {
  return {
    actionId: row.action_id,
    chatId: row.chat_id,
    event: JSON.parse(row.event_json) as TranscriptEvent,
    state: row.state,
  };
}
