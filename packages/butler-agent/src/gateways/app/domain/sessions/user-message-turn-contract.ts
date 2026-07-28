import type { RuntimeTurnEventInput } from "../../../../agent/events/turn-events.ts";
import type { MessageFileRow } from "../message-files/message-file-store.ts";
import type {
  completeResponderTurn as completeResponderTurnLifecycle,
} from "./responder-turn-lifecycle.ts";
import type {
  MessageRecord,
  MessageSendRequest,
  ProgressSummaryRow,
  QueueMessageRequest,
  SessionControlState,
  SessionQueueView,
  TurnRecord,
  TurnState,
} from "../../interface/protocol/app-protocol.ts";
import type {
  AppMessageResponder,
  AppMessageResponderResult,
  SendMessageOptions,
} from "./message-responder-contract.ts";
import type { ProgressSummaryInput } from "../progress-summary/progress-row-normalizer.ts";
import type {
  TurnControlResolution,
  TurnExecutionControlsV1,
} from "../../../core/turn-execution-controls.ts";

export interface UserMessageTurnStoreInput {
  butlerData: string;
  defaultChatId: string;
  ensureChat: (chatId: string) => void;
  sessionHasActiveTurn: (chatId: string) => boolean;
  createQueuedMessage: (input: QueueMessageRequest) => SessionQueueView;
  listMessages: (chatId: string) => MessageRecord[];
  validateAttachable: (
    chatId: string,
    attachments: MessageSendRequest["attachments"],
  ) => MessageFileRow[];
  resolveControlsForMessageSend: (
    chatId: string,
    input: Partial<SessionControlState>,
  ) => TurnControlResolution;
  insertTurn: (
    chatId: string,
    state: TurnState,
    safeStatusLabel: string,
    controlResolution?: TurnControlResolution,
  ) => TurnRecord;
  insertMessage: (
    chatId: string,
    role: "user",
    text: string,
    status: "sent",
    options: {
      clientMessageId?: string;
      turnId?: string;
      attachments?: MessageFileRow[];
    },
  ) => MessageRecord;
  setTurnUserMessage: (turnId: string, messageId: string) => void;
  appendEvent: (type: string, payload: Record<string, unknown>) => void;
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
  enqueueAppTransportTurn: (input: {
    chatId: string;
    turnId: string;
    message: MessageRecord;
    text: string;
    executionControls: TurnExecutionControlsV1;
  }) => TurnRecord;
  appendProgressSummaryEvent: (
    chatId: string,
    turnId: string,
    row: ProgressSummaryInput,
  ) => ProgressSummaryRow;
  appendTurnEvent: (
    chatId: string,
    turnId: string,
    input: RuntimeTurnEventInput,
  ) => void;
  cleanupTurnEventSequences: (chatId: string, turnId: string) => void;
  createResponderMessageFiles: (
    chatId: string,
    files: AppMessageResponderResult["files"],
  ) => MessageFileRow[];
  drainQueuedSessionMessages: (
    chatId: string,
    responder?: AppMessageResponder,
    options?: SendMessageOptions,
  ) => Promise<void>;
  finalizeCancelledTurn: Parameters<
    typeof completeResponderTurnLifecycle
  >[1]["finalizeCancelledTurn"];
  hasTurnEventKind: (turnId: string, kind: string) => boolean;
  insertOrReplaceAssistantReplies: (
    chatId: string,
    turnId: string,
    texts: string[],
    files?: MessageFileRow[],
  ) => MessageRecord[];
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
  touchChat: (chatId: string) => void;
  appendTerminalTurnStateChanged: (turn: TurnRecord) => void;
  runtimeFaultRecordForTurn: (turnId: string) => Record<string, unknown> | null;
  upsertAssistantTurnFailure: (
    chatId: string,
    turnId: string,
    safeError: { code: string; message: string },
    options?: { retryable?: boolean },
  ) => MessageRecord;
}

export interface UserResponderTurnInput {
  chatId: string;
  turnId: string;
  messageId: string;
  text: string;
  responder: AppMessageResponder;
  options: SendMessageOptions;
}
