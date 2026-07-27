import type { RuntimeTurnEventInput } from "../../../../agent/events/turn-events.ts";
import type { AppLimitedDelivery } from "../../infrastructure/transport/failure-ux-contract.ts";
import type { MessageFileRow } from "../message-files/message-file-store.ts";
import {
  executionControlsFromJson,
  messageFromRow,
  turnFromRow,
} from "./message-read-model.ts";
import type { MessageRow, TurnRow } from "../../infrastructure/core/records.ts";
import {
  isContinuationDeliveryIssue,
  shouldAutomaticallyRequeueContinuation,
} from "../../infrastructure/transport/continuation-delivery.ts";
import {
  publicDeliveryStateForProjection,
} from "../../infrastructure/transport/btcc-public-projection.ts";
import type {
  MessageRecord,
  MessageFileRef,
  TurnRecord,
} from "../../interface/protocol/app-protocol.ts";
import type { TurnExecutionControlsV1 } from "../../../core/turn-execution-controls.ts";
import {
  isInternalContinuationTurnState,
} from "../../infrastructure/transport/app-transport-metadata.ts";
import { AppStoreOperationError } from "../../infrastructure/core/app-store-errors.ts";

interface LimitedDeliveryStoreInput {
  hasPublicContinuationProgressSinceLatestQueue: (turnId: string) => boolean;
  hasTurnEventKind: (turnId: string, kind: string) => boolean;
  appendTurnEvent: (
    chatId: string,
    turnId: string,
    input: RuntimeTurnEventInput,
  ) => void;
  deleteAssistantMessagesForTurn: (turnId: string) => void;
  insertOrReplaceAssistantReplies: (
    chatId: string,
    turnId: string,
    texts: string[],
    files?: MessageFileRow[],
  ) => MessageRecord[];
  updateTurnState: (
    turnId: string,
    state: TurnRecord["state"],
    options: {
      safeStatusLabel: string;
      safeErrorCode?: string | null;
      retryable?: boolean;
      cancellable?: boolean;
      attempt?: number;
    },
  ) => TurnRecord;
  appendTerminalTurnStateChanged: (turn: TurnRecord) => void;
  appendEvent: (type: string, payload: Record<string, unknown>) => void;
  getTurnRow: (turnId: string) => TurnRow | null;
  getMessageRow: (messageId: string) => MessageRow | null;
  refsForMessage: (messageId: string) => MessageFileRef[];
  enqueueAppTransportTurn: (input: {
    chatId: string;
    turnId: string;
    message: MessageRecord;
    text: string;
    executionControls: TurnExecutionControlsV1;
  }) => TurnRecord;
}

export class AppLimitedDeliveryStore {
  constructor(private readonly input: LimitedDeliveryStoreInput) {}

  finalizeResponderLimitedDelivery(
    chatId: string,
    turnId: string,
    limitedDelivery: AppLimitedDelivery,
    options: { allowContinuation?: boolean; visibleNoReplyText?: string } = {},
  ): { reply?: MessageRecord; replies: MessageRecord[]; turn: TurnRecord } {
    if (
      options.allowContinuation !== false &&
      isContinuationDeliveryIssue(limitedDelivery.delivery.issue_kind)
    ) {
      return this.markResponderContinuation(chatId, turnId, limitedDelivery);
    }
    const text = limitedDelivery.text ?? options.visibleNoReplyText ?? null;
    const noVisibleReply = text === null;
    const deliveryState = publicDeliveryStateForProjection(
      limitedDelivery.delivery.delivery_state,
    );
    const limitations = limitedDelivery.delivery.limitations;
    const limitationCodes = limitedDelivery.delivery.limitation_codes;
    if (!this.input.hasTurnEventKind(turnId, "message.final.started")) {
      this.input.appendTurnEvent(chatId, turnId, {
        kind: "message.final.started",
        payload: { safeLabel: "Preparing final answer" },
      });
    }
    if (text === null) this.input.deleteAssistantMessagesForTurn(turnId);
    const replies =
      text === null
        ? []
        : this.input.insertOrReplaceAssistantReplies(chatId, turnId, [text]);
    if (
      noVisibleReply ||
      !this.input.hasTurnEventKind(turnId, "message.final.completed")
    ) {
      this.input.appendTurnEvent(chatId, turnId, {
        kind: "message.final.completed",
        payload: {
          safeLabel: "Final answer ready with limitations",
          textChars: text?.length ?? 0,
          noVisibleReply,
          deliveryState,
          delivery_state: deliveryState,
          limitations,
          limitationCodes,
          limitation_codes: limitationCodes,
        },
      });
    }
    const deliveredTurn = this.input.updateTurnState(turnId, "delivered", {
      safeStatusLabel: "Delivered with limitations",
      retryable: false,
      cancellable: false,
      safeErrorCode: null,
    });
    this.input.appendTerminalTurnStateChanged(deliveredTurn);
    if (noVisibleReply || !this.input.hasTurnEventKind(turnId, "turn.completed")) {
      this.input.appendTurnEvent(chatId, turnId, {
        kind: "turn.completed",
        payload: {
          safeLabel: "Completed with limitations",
          deliveryState,
          delivery_state: deliveryState,
          limitations,
          limitationCodes,
          limitation_codes: limitationCodes,
        },
      });
    }
    const projectedReplies = replies.map((reply) => ({
      ...reply,
      delivery_state: deliveryState,
      limitations,
      limitation_codes: limitationCodes,
    }));
    return {
      reply: projectedReplies.at(-1),
      replies: projectedReplies,
      turn: deliveredTurn,
    };
  }

  markResponderNonPublicContinuation(
    chatId: string,
    turnId: string,
    safeErrorCode?: "provider_round_timeout" | null,
  ): { reply?: MessageRecord; replies: MessageRecord[]; turn: TurnRecord } {
    return this.markResponderContinuation(chatId, turnId, {
      text: null,
      reason: "Continuation remains active.",
      delivery: {
        delivery_state: "running",
        issue_kind: "none",
        visibility: "continuation_progress",
        terminal: false,
        failure_notice: false,
        limitation_codes: [],
        limitations: [],
      },
    }, { safeErrorCode });
  }

  private markResponderContinuation(
    chatId: string,
    turnId: string,
    limitedDelivery: AppLimitedDelivery,
    options: { safeErrorCode?: "provider_round_timeout" | null } = {},
  ): { reply?: MessageRecord; replies: MessageRecord[]; turn: TurnRecord } {
    this.input.deleteAssistantMessagesForTurn(turnId);
    const currentTurn = this.input.getTurnRow(turnId);
    const deliveryState = limitedDelivery.delivery.delivery_state;
    const progressedDuringCurrentQueue =
      currentTurn && isInternalContinuationTurnState(currentTurn.state)
        ? this.input.hasPublicContinuationProgressSinceLatestQueue(turnId)
        : false;
    const shouldRequeue =
      shouldAutomaticallyRequeueContinuation(currentTurn, deliveryState) ||
      progressedDuringCurrentQueue;
    if (
      !shouldRequeue &&
      currentTurn &&
      isInternalContinuationTurnState(currentTurn.state)
    ) {
      return { replies: [], turn: turnFromRow(currentTurn) };
    }
    const attempt =
      shouldRequeue && currentTurn
        ? currentTurn.attempt + 1
        : currentTurn?.attempt;
    const recoveryTurn = this.input.updateTurnState(
      turnId,
      shouldRequeue ? "retrying" : "waiting_for_tool",
      {
        safeStatusLabel: "",
        retryable: false,
        cancellable: true,
        safeErrorCode: options.safeErrorCode ?? null,
        attempt,
      },
    );
    this.input.appendEvent("turn.state_changed", { turn: recoveryTurn });
    if (shouldRequeue) this.requeueRecoverableAppTurn(chatId, recoveryTurn);
    return {
      replies: [],
      turn: recoveryTurn,
    };
  }

  private requeueRecoverableAppTurn(chatId: string, turn: TurnRecord): void {
    const row = this.input.getTurnRow(turn.id);
    if (!row?.user_message_id) return;
    const messageRow = this.input.getMessageRow(row.user_message_id);
    if (!messageRow) return;
    const executionControls = executionControlsFromJson(
      row.execution_controls_json,
    );
    if (!executionControls) {
      throw new AppStoreOperationError(
        409,
        "turn_execution_controls_missing",
        "This legacy turn cannot be continued without its original execution snapshot.",
      );
    }
    this.input.enqueueAppTransportTurn({
      chatId,
      turnId: turn.id,
      message: messageFromRow(
        messageRow,
        this.input.refsForMessage(messageRow.id),
      ),
      text: messageRow.text,
      executionControls,
    });
  }
}
