import {
  createTurnAcknowledgedPayload,
  TURN_ACKNOWLEDGED_EVENT_KIND,
} from "../../../../agent/events/turn-state-contract.ts";
import {
  applyTurnLocalWorkOutcomeForSession,
} from "../../../../agent/work/work-stream.ts";
import type {
  MessageRecord,
  MessageSendResult,
  SessionControlState,
  TurnRecord,
  TurnState,
} from "../../interface/protocol/app-protocol.ts";
import type {
  AppMessageResponder,
  SendMessageOptions,
} from "../../domain/sessions/message-responder-contract.ts";
import {
  turnLocalWorkOutcomeForAppTurn,
  turnLocalWorkOutcomeStatusNote,
} from "../../domain/sessions/turn-local-work-outcome.ts";
import { sessionHintForRow } from "../../domain/sessions/session-read-model.ts";
import type { AppStoreKernel } from "../kernel/app-store-kernel.ts";

export interface AppStoreKernelTurnLifecycleHost {
  reconcileTurnLocalWorkOutcomeForTurn(turn: TurnRecord): void;
  appendTurnAcknowledgedEvent(chatId: string, turnId: string): void;
  appendTerminalTurnStateChanged(turn: TurnRecord): void;
  dispatchDeferredResponderTurn(input: {
    chatId: string;
    turnId: string;
    messageId: string;
    text: string;
    responder: AppMessageResponder;
    options: SendMessageOptions;
  }): void;
  completeResponderTurn(input: {
    chatId: string;
    turnId: string;
    messageId: string;
    text: string;
    responder: AppMessageResponder;
    options: SendMessageOptions;
  }): Promise<{
    reply?: MessageRecord;
    replies: MessageRecord[];
    turn: TurnRecord;
    next_cursor: number;
  }>;
  enqueueAppTransportTurn(input: {
    chatId: string;
    turnId: string;
    message: MessageRecord;
    text: string;
    controls: SessionControlState;
  }): TurnRecord;
  runSystemResponderTurn(
    chatId: string,
    messageId: string,
    text: string,
    responder: AppMessageResponder,
    options?: SendMessageOptions,
  ): Promise<MessageSendResult>;
  scheduleSystemResponderTurn(input: {
    key: string;
    chatId: string;
    text: string;
    responder: AppMessageResponder;
    options?: SendMessageOptions;
    onSuccess?: () => void;
  }): boolean;
  drainQueuedSessionMessages(
    chatId: string,
    responder?: AppMessageResponder,
    options?: SendMessageOptions,
  ): Promise<void>;
  sessionHasActiveTurn(sessionId: string): boolean;
  reconcileDeliveredSystemResponderTurns(sessionId: string): void;
  reconcileCancelledTurnActivityMessages(): void;
  insertTurn(
    chatId: string,
    state: TurnState,
    safeStatusLabel: string,
  ): TurnRecord;
  setTurnUserMessage(turnId: string, messageId: string): void;
  updateTurnState(
    turnId: string,
    state: TurnState,
    options: {
      safeStatusLabel: string;
      safeErrorCode?: string | null;
      retryable?: boolean;
      cancellable?: boolean;
      attempt?: number;
    },
  ): TurnRecord;
  claimRetryTurn(turnId: string, attempt: number): TurnRecord;
  finalizeCancelledTurn(chatId: string, turnId: string): TurnRecord;
}

export function createTurnLifecycleHost(
  kernel: AppStoreKernel,
): AppStoreKernelTurnLifecycleHost {
  return {
    reconcileTurnLocalWorkOutcomeForTurn(turn) {
      const outcome = turnLocalWorkOutcomeForAppTurn(turn.state);
      if (!outcome) return;
      try {
        applyTurnLocalWorkOutcomeForSession({
          butlerData: kernel.butlerData,
          sessionId: sessionHintForRow(turn.chat_id),
          turnId: turn.id,
          outcome,
          statusNote: turnLocalWorkOutcomeStatusNote(outcome),
        });
      } catch {
        // Terminal turn projection must stay available even if repair fails.
      }
    },
    appendTurnAcknowledgedEvent(chatId, turnId) {
      kernel.turnProgress.appendTurnEvent(chatId, turnId, {
        kind: TURN_ACKNOWLEDGED_EVENT_KIND,
        payload: createTurnAcknowledgedPayload({
          safeLabel: "Request received. Preparing the work.",
          transport: "app",
        }),
      });
    },
    appendTerminalTurnStateChanged(turn) {
      kernel.appendEvent("turn.state_changed", { turn });
      kernel.reconcileTurnLocalWorkOutcomeForTurn(turn);
    },
    dispatchDeferredResponderTurn(input) {
      kernel.userMessageTurns.dispatchDeferredResponderTurn(input);
    },
    async completeResponderTurn(input) {
      return await kernel.userMessageTurns.completeResponderTurn(input);
    },
    enqueueAppTransportTurn(input) {
      return kernel.appTransportQueue.enqueueAppTransportTurn(input);
    },
    async runSystemResponderTurn(
      chatId,
      messageId,
      text,
      responder,
      options = {},
    ) {
      return await kernel.systemResponderTurns.run(
        chatId,
        messageId,
        text,
        responder,
        options,
      );
    },
    scheduleSystemResponderTurn(input) {
      return kernel.systemResponderTurns.schedule(input);
    },
    async drainQueuedSessionMessages(chatId, responder, options = {}) {
      return await kernel.sessionQueueDispatcher.drain(
        chatId,
        responder,
        options,
      );
    },
    sessionHasActiveTurn(sessionId) {
      return kernel.turnActions.sessionHasActiveTurn(sessionId);
    },
    reconcileDeliveredSystemResponderTurns(sessionId) {
      kernel.turnActions.reconcileDeliveredSystemResponderTurns(sessionId);
    },
    reconcileCancelledTurnActivityMessages() {
      kernel.turnActions.reconcileCancelledTurnActivityMessages();
    },
    insertTurn(chatId, state, safeStatusLabel) {
      return kernel.turns.insertTurn(chatId, state, safeStatusLabel);
    },
    setTurnUserMessage(turnId, messageId) {
      kernel.turns.setTurnUserMessage(turnId, messageId);
    },
    updateTurnState(turnId, state, options) {
      return kernel.turns.updateTurnState(turnId, state, options);
    },
    claimRetryTurn(turnId, attempt) {
      return kernel.turns.claimRetryTurn(turnId, attempt);
    },
    finalizeCancelledTurn(chatId, turnId) {
      const current = kernel.getTurnRow(turnId);
      if (current?.state === "cancelled") {
        kernel.ensureCancelledTurnActivityMessage(chatId, turnId);
        return kernel.turns.getTurn(turnId);
      }
      const cancelledTurn = kernel.updateTurnState(turnId, "cancelled", {
        safeStatusLabel: "Cancelled",
        retryable: false,
        cancellable: false,
        safeErrorCode: null,
      });
      kernel.appendTerminalTurnStateChanged(cancelledTurn);
      if (!kernel.hasTurnEventKind(turnId, "turn.cancelled")) {
        kernel.turnProgress.appendTurnEvent(chatId, turnId, {
          kind: "turn.cancelled",
          payload: { safeLabel: "Cancelled" },
        });
      }
      kernel.ensureCancelledTurnActivityMessage(chatId, turnId);
      kernel.touchChat(chatId);
      void kernel.drainQueuedSessionMessages(chatId).catch(() => undefined);
      return cancelledTurn;
    },
  };
}
