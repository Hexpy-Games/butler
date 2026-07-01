import { Database } from "bun:sqlite";
import type { EventRow, TurnRow } from "../../infrastructure/core/records.ts";
import {
  deliveryLimitationMetadataFromRecord,
  type DeliveryLimitationMetadata,
} from "../../infrastructure/transport/app-delivery-projection.ts";
import {
  publicAppDeliveryMetadata,
  publicDeliveryMetadataForProjection,
  publicDeliveryStateForTurnState,
} from "../../infrastructure/transport/btcc-public-projection.ts";
import { isTerminalProgressState } from "../progress-summary/progress-row-merge.ts";
import { progressRowsForTurnState } from "../progress-summary/public-progress-rows.ts";
import { safeParseRecord, isRecord } from "../../infrastructure/core/projection-safe-values.ts";
import { workBlocksFromTerminalProgressRows } from "./session-work-blocks.ts";
import type {
  MessageRecord,
  ProgressSummaryRow,
  TurnRecord,
} from "../../interface/protocol/app-protocol.ts";

export class AppSessionMessageProjectionStore {
  constructor(
    private readonly input: {
      db: Database;
      listMessages: (sessionId: string) => MessageRecord[];
      getTurnRow: (turnId: string) => TurnRow | null;
      listProgressRowsForTurn: (turnId: string) => ProgressSummaryRow[];
    },
  ) {}

  sessionViewMessages(sessionId: string): MessageRecord[] {
    return this.input.listMessages(sessionId).map((message) => {
      if (message.role !== "assistant" || !message.turn_id) return message;
      const turn = this.input.getTurnRow(message.turn_id);
      if (!turn || !isTerminalProgressState(turn.state)) return message;
      const delivery = this.deliveryLimitationMetadataForTurn(message.turn_id);
      const publicDelivery = delivery
        ? publicAppDeliveryMetadata(publicDeliveryMetadataForProjection(delivery))
        : null;
      const workBlocks = workBlocksFromTerminalProgressRows(
        progressRowsForTurnState(
          this.input.listProgressRowsForTurn(message.turn_id),
          turn.state,
        ),
      );
      if (workBlocks.length === 0 && !publicDelivery) return message;
      return {
        ...message,
        ...(publicDelivery ?? {}),
        ...(workBlocks.length > 0 ? { work_blocks: workBlocks } : {}),
      };
    });
  }

  deliveryMetadataForTurnRecord(turn: TurnRecord): DeliveryLimitationMetadata {
    return this.deliveryLimitationMetadataForTurn(turn.id) ?? {
      delivery_state: publicDeliveryStateForTurnState(turn.state),
      limitation_codes: [],
      limitations: [],
    };
  }

  messageWithTerminalWorkBlocks(
    message: MessageRecord,
    turnId: string,
  ): MessageRecord {
    const turn = this.input.getTurnRow(turnId);
    if (!turn || !isTerminalProgressState(turn.state)) return message;
    const delivery = this.deliveryLimitationMetadataForTurn(turnId);
    const publicDelivery = delivery
      ? publicDeliveryMetadataForProjection(delivery)
      : null;
    const workBlocks = workBlocksFromTerminalProgressRows(
      progressRowsForTurnState(
        this.input.listProgressRowsForTurn(turnId),
        turn.state,
      ),
    );
    return {
      ...message,
      ...(publicDelivery ?? {}),
      ...(workBlocks.length > 0 ? { work_blocks: workBlocks } : {}),
    };
  }

  private deliveryLimitationMetadataForTurn(
    turnId: string,
  ): DeliveryLimitationMetadata | null {
    const rows = this.input.db
      .query<EventRow, [string]>(
        `
      SELECT id, type, payload_json, created_at
      FROM events
      WHERE type = 'agent.turn_event'
        AND json_extract(payload_json, '$.turn_id') = ?
      ORDER BY id DESC
      LIMIT 500
    `,
      )
      .all(turnId);
    for (const row of rows) {
      const payload = safeParseRecord(row.payload_json);
      if (payload.turn_id !== turnId) continue;
      const event = isRecord(payload.event) ? payload.event : {};
      const eventPayload = isRecord(event.payload) ? event.payload : {};
      const metadata = deliveryLimitationMetadataFromRecord(eventPayload);
      if (metadata) return metadata;
    }
    return null;
  }
}
