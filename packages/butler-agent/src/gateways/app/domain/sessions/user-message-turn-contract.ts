import type { RuntimeTurnEventInput } from "../../../../agent/events/turn-events.ts";
import type { MessageFileRow } from "../message-files/message-file-store.ts";
import type {
  completeResponderTurn as completeResponderTurnLifecycle,
} from "./responder-turn-lifecycle.ts";
import type {
  MessageRecord,
  MessageSendRequest,
  MessageSendResult,
  ProgressSummaryRow,
  QueueMessageRequest,
  QueuedMessageRecord,
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
import type { VisualImageAdmissionResult } from "../../../../agent/image-attachment/contracts.ts";

export interface UserMessageTurnStoreInput {
  butlerData: string;
  defaultChatId: string;
  ensureChat: (chatId: string) => void;
  sessionHasActiveTurn: (chatId: string) => boolean;
  createQueuedMessage: (
    input: QueueMessageRequest,
    visualAdmission?: VisualImageAdmissionResult,
    controlResolution?: TurnControlResolution,
  ) => Promise<SessionQueueView>;
  findQueuedMessageByClientId: (
    chatId: string,
    clientMessageId: string,
  ) => QueuedMessageRecord | null;
  queuedControlsFromRow: (
    row: import("../../infrastructure/core/records.ts").QueuedMessageRow,
  ) => SessionControlState;
  controlResolutionFromRow: (
    row: import("../../infrastructure/core/records.ts").QueuedMessageRow,
  ) => TurnControlResolution | null;
  messageFilesForQueuedRow: (
    row: import("../../infrastructure/core/records.ts").QueuedMessageRow,
  ) => MessageFileRow[];
  dispatchQueuedSessionMessage: (
    chatId: string,
    queuedMessageId: string,
    responder?: AppMessageResponder,
    options?: SendMessageOptions,
  ) => Promise<MessageSendResult | undefined>;
  acknowledgeQueuedMessageForTurn: (input: {
    chatId: string;
    turnId: string;
    claimId: string;
    resultMessageId?: string;
    safeErrorCode?: string | null;
  }) => boolean;
  assertQueuedMessageClaim: (
    chatId: string,
    queuedMessageId: string,
    claimId: string,
  ) => boolean;
  fenceQueuedTurnClaim: (input: {
    chatId: string;
    turnId: string;
    claimId: string;
  }) => boolean;
  recordDispatchResult: (
    chatId: string,
    queuedMessageId: string,
    claimId: string,
    result: { messageId?: string; turnId?: string },
  ) => boolean;
  runInTransaction: <T>(callback: () => T) => T;
  getTurn: (turnId: string) => TurnRecord;
  messageRecordById: (messageId: string) => MessageRecord;
  listMessages: (chatId: string) => MessageRecord[];
  terminalResultMessageIdForTurn: (chatId: string, turnId: string) => string | undefined;
  validateAttachable: (
    chatId: string,
    attachments: MessageSendRequest["attachments"],
  ) => MessageFileRow[];
  admitVisualAttachments: (
    files: readonly MessageFileRow[],
    model: string,
  ) => Promise<VisualImageAdmissionResult | undefined>;
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
    queueClaimId?: string;
    queueReplay?: boolean;
    visualAdmission?: VisualImageAdmissionResult;
    authorityRequestRef?: string;
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
  assertQueueClaim?: () => void;
}

export interface UserResponderTurnInput {
  chatId: string;
  turnId: string;
  messageId: string;
  text: string;
  responder: AppMessageResponder;
  options: SendMessageOptions;
  queuedMessageId?: string;
  queueClaimId?: string;
}
