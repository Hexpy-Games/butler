import type { TurnRow } from "../../infrastructure/core/records.ts";
import {
  type DeliveryLimitationMetadata,
} from "../../infrastructure/transport/app-delivery-projection.ts";
import {
  publicAppDeliveryMetadata,
  publicDeliveryMetadataForProjection,
  publicDeliveryStateForTurnState,
} from "../../infrastructure/transport/btcc-public-projection.ts";
import { isTerminalProgressState } from "../progress-summary/progress-row-merge.ts";
import { progressRowsForTurnState } from "../progress-summary/public-progress-rows.ts";
import { workBlocksFromTerminalProgressRows } from "./session-work-blocks.ts";
import type {
  MessageRecord,
  ProgressSummaryRow,
  TurnRecord,
} from "../../interface/protocol/app-protocol.ts";
import type {
  SessionMessagePage,
  SessionMessagePageOptions,
} from "./session-message-page.ts";

export class AppSessionMessageProjectionStore {
  constructor(
    private readonly input: {
      listMessages: (
        sessionId: string,
        options?: SessionMessagePageOptions,
      ) => MessageRecord[];
      listMessagePage?: (
        sessionId: string,
        options?: SessionMessagePageOptions,
      ) => SessionMessagePage<MessageRecord>;
      getTurnRow: (turnId: string) => TurnRow | null;
      listProgressRowsForTurn: (turnId: string) => ProgressSummaryRow[];
      explicitDeliveryMetadataForTurn: (
        turnId: string,
      ) => DeliveryLimitationMetadata | null;
    },
  ) {}

  sessionViewMessages(
    sessionId: string,
    options?: SessionMessagePageOptions,
  ): MessageRecord[] {
    return this.sessionViewMessagePage(sessionId, options).items;
  }

  sessionViewMessagePage(
    sessionId: string,
    options?: SessionMessagePageOptions,
  ): SessionMessagePage<MessageRecord> {
    const page = this.input.listMessagePage?.(sessionId, options) ?? {
      items: this.input.listMessages(sessionId, options),
      nextCursor: 0,
      previousCursor: null,
      hasMore: false,
    };
    return {
      ...page,
      items: page.items.map((message) => {
        if (message.role !== "assistant" || !message.turn_id) return message;
        const turn = this.input.getTurnRow(message.turn_id);
        if (!turn || !isTerminalProgressState(turn.state)) return message;
        const delivery = this.explicitDeliveryMetadataForTurn(message.turn_id);
        const publicDelivery = delivery
          ? publicAppDeliveryMetadata(
              publicDeliveryMetadataForProjection(delivery),
            )
          : null;
        const terminalRows = progressRowsForTurnState(
          this.input.listProgressRowsForTurn(message.turn_id),
          turn.state,
        );
        const workBlocks = workBlocksFromTerminalProgressRows(terminalRows);
        const activityRows = terminalRows.filter(isTurnActivityRow);
        if (
          workBlocks.length === 0 &&
          activityRows.length === 0 &&
          !publicDelivery
        ) {
          return message;
        }
        return {
          ...message,
          ...(publicDelivery ?? {}),
          ...(workBlocks.length > 0 ? { work_blocks: workBlocks } : {}),
          ...(activityRows.length > 0
            ? { turn_activity_rows: activityRows }
            : {}),
        };
      }),
    };
  }

  deliveryMetadataForTurnRecord(turn: TurnRecord): DeliveryLimitationMetadata {
    return this.explicitDeliveryMetadataForTurn(turn.id) ?? {
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
    const delivery = this.explicitDeliveryMetadataForTurn(turnId);
    const publicDelivery = delivery
      ? publicDeliveryMetadataForProjection(delivery)
      : null;
    const terminalRows = progressRowsForTurnState(
      this.input.listProgressRowsForTurn(turnId),
      turn.state,
    );
    const workBlocks = workBlocksFromTerminalProgressRows(terminalRows);
    const activityRows = terminalRows.filter(isTurnActivityRow);
    return {
      ...message,
      ...(publicDelivery ?? {}),
      ...(workBlocks.length > 0 ? { work_blocks: workBlocks } : {}),
      ...(activityRows.length > 0 ? { turn_activity_rows: activityRows } : {}),
    };
  }

  explicitDeliveryMetadataForTurn(
    turnId: string,
  ): DeliveryLimitationMetadata | null {
    return this.input.explicitDeliveryMetadataForTurn(turnId);
  }
}

function isTurnActivityRow(row: ProgressSummaryRow): boolean {
  if (row.kind === "todo" && row.bridge_phase === "btcc_work_ledger") return true;
  if (row.bridge_phase === "btcc_operation" && row.semantic_block_id) return true;
  return Boolean(
    row.kind === "message" &&
    !row.work_block_id &&
    row.semantic_block_id &&
    row.work_decision_source === "model-authored" &&
    row.work_decision_summary,
  );
}
