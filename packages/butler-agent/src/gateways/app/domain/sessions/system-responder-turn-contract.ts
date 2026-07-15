import type { RuntimeTurnEventInput } from "../../../../agent/events/turn-events.ts";
import type { DeliveryLimitationMetadata } from "../../infrastructure/transport/app-delivery-projection.ts";
import type { AppLimitedDelivery } from "../../infrastructure/transport/failure-ux-contract.ts";
import type { MessageFileRow } from "../message-files/message-file-store.ts";
import type { MessageRow } from "../../infrastructure/core/records.ts";
import type {
  MessageFileRef,
  MessageRecord,
  ProgressSummaryRow,
  SessionControlState,
  TurnRecord,
  TurnState,
} from "../../interface/protocol/app-protocol.ts";
import type {
  AppMessageResponder,
  AppMessageResponderResult,
  SendMessageOptions,
} from "./message-responder-contract.ts";
import type { ProgressSummaryInput } from "../progress-summary/progress-row-normalizer.ts";

export interface SystemResponderTurnStoreInput {
  ensureChat: (chatId: string) => void;
  getSessionControls: (chatId: string) => SessionControlState;
  insertTurn: (
    chatId: string,
    state: TurnState,
    safeStatusLabel: string,
  ) => TurnRecord;
  appendTurnAcknowledgedEvent: (chatId: string, turnId: string) => void;
  updateTurnState: (
    turnId: string,
    state: TurnState,
    options: {
      safeStatusLabel: string;
      safeErrorCode?: string | null;
      retryable?: boolean;
      cancellable?: boolean;
      attempt?: number;
    },
  ) => TurnRecord;
  appendEvent: (type: string, payload: Record<string, unknown>) => void;
  appendTurnEvent: (
    chatId: string,
    turnId: string,
    input: RuntimeTurnEventInput,
  ) => void;
  appendProgressSummaryEvent: (
    chatId: string,
    turnId: string,
    row: ProgressSummaryInput,
  ) => ProgressSummaryRow;
  runResponder: (
    chatId: string,
    turnId: string,
    messageId: string,
    text: string,
    responder: AppMessageResponder,
    options: SendMessageOptions,
    onProgress?: (row: ProgressSummaryInput) => void,
    onTurnEvent?: (event: RuntimeTurnEventInput) => void,
  ) => Promise<AppMessageResponderResult>;
  hasTurnEventKind: (turnId: string, kind: string) => boolean;
  appendTerminalTurnStateChanged: (turn: TurnRecord) => void;
  touchChat: (chatId: string) => void;
  createResponderFiles: (
    chatId: string,
    files: AppMessageResponderResult["files"],
  ) => MessageFileRow[];
  insertOrReplaceAssistantReplies: (
    chatId: string,
    turnId: string,
    texts: string[],
    files?: MessageFileRow[],
  ) => MessageRecord[];
  finalizeCancelledTurn: (chatId: string, turnId: string) => TurnRecord;
  getMessageRow: (messageId: string) => MessageRow | null;
  refsForMessage: (messageId: string) => MessageFileRef[];
  markResponderNonPublicContinuation: (
    chatId: string,
    turnId: string,
    safeErrorCode?: "provider_round_timeout" | null,
  ) => { reply?: MessageRecord; replies: MessageRecord[]; turn: TurnRecord };
  routeResponderRuntimeInterruption: (input: {
    chatId: string;
    turnId: string;
    messageId: string;
    text: string;
    error: unknown;
  }) => void;
  finalizeResponderLimitedDelivery: (
    chatId: string,
    turnId: string,
    limitedDelivery: AppLimitedDelivery,
  ) => { reply?: MessageRecord; replies: MessageRecord[]; turn: TurnRecord };
  cleanupTurnEventSequences: (chatId: string, turnId: string) => void;
}

export interface SystemResponderCompletionInput {
  chatId: string;
  messageId: string;
  text: string;
  responder: AppMessageResponder;
  options: SendMessageOptions;
  turn: TurnRecord;
}

export type SystemResponderAppendTurnEvent = (
  event: RuntimeTurnEventInput,
) => void;

export type SystemResponderLimitedDelivery =
  DeliveryLimitationMetadata | null;
