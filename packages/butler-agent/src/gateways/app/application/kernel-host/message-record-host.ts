import type { RuntimeTurnEventInput } from "../../../../agent/events/turn-events.ts";
import type {
  MessageRow,
  QueuedMessageRow,
  TurnRow,
} from "../../infrastructure/core/records.ts";
import type { AppLimitedDelivery } from "../../infrastructure/transport/failure-ux-contract.ts";
import type { MessageFileRow } from "../../domain/message-files/message-file-store.ts";
import type {
  AppMessageResponder,
  AppMessageResponderResult,
  SendMessageOptions,
} from "../../domain/sessions/message-responder-contract.ts";
import type { ProgressSummaryInput } from "../../domain/progress-summary/progress-row-normalizer.ts";
import type {
  MessageRecord,
  MessageRole,
  MessageStatus,
  QueuedMessageRecord,
  SessionControlState,
} from "../../interface/protocol/app-protocol.ts";
import type { AppEventEnvelope } from "../../interface/protocol/app-protocol.ts";
import type { AppStoreKernel } from "../kernel/app-store-kernel.ts";

export interface AppStoreKernelMessageRecordHost {
  ensureChat(chatId: string): void;
  getQueuedMessageRow(queuedMessageId: string): QueuedMessageRow | null;
  queuedControlsFromRow(row: QueuedMessageRow): SessionControlState;
  queuedMessageFromRow(row: QueuedMessageRow): QueuedMessageRecord;
  insertMessage(
    chatId: string,
    role: MessageRole,
    text: string,
    status: MessageStatus,
    options?: {
      clientMessageId?: string;
      turnId?: string;
      safeErrorCode?: string;
      retryable?: boolean;
      attachments?: MessageFileRow[];
      conversationSessionId?: string | null;
      conversationTurnId?: string | null;
      conversationMessageId?: string | null;
    },
  ): MessageRecord;
  insertAssistantReplies(
    chatId: string,
    turnId: string,
    texts: string[],
    files?: MessageFileRow[],
    changedFiles?: string[],
  ): MessageRecord[];
  insertOrReplaceAssistantReplies(
    chatId: string,
    turnId: string,
    texts: string[],
    files?: MessageFileRow[],
    changedFiles?: string[],
  ): MessageRecord[];
  replaceMessageChangedFiles(
    messageId: string,
    paths: readonly string[],
  ): MessageRecord;
  finalizeResponderLimitedDelivery(
    chatId: string,
    turnId: string,
    limitedDelivery: AppLimitedDelivery,
    options?: { allowContinuation?: boolean; visibleNoReplyText?: string },
  ): { reply?: MessageRecord; replies: MessageRecord[]; turn: unknown };
  markResponderNonPublicContinuation(
    chatId: string,
    turnId: string,
    safeErrorCode?: "provider_round_timeout" | null,
  ): { reply?: MessageRecord; replies: MessageRecord[]; turn: unknown };
  deleteAssistantMessagesForTurn(turnId: string): void;
  upsertAssistantTurnFailure(
    chatId: string,
    turnId: string,
    safeError: { code: string; message: string },
    options?: { retryable?: boolean },
  ): MessageRecord;
  ensureCancelledTurnActivityMessage(
    chatId: string,
    turnId: string,
  ): MessageRecord | null;
  messageWithTerminalWorkBlocks(
    message: MessageRecord,
    turnId: string,
  ): MessageRecord;
  updateMessage(
    messageId: string,
    input: {
      text?: string;
      status?: MessageStatus;
      safeErrorCode?: string | null;
      retryable?: boolean;
    },
  ): MessageRecord;
  runResponder(
    chatId: string,
    turnId: string,
    messageId: string,
    text: string,
    responder?: AppMessageResponder,
    options?: SendMessageOptions,
    onProgress?: (row: ProgressSummaryInput) => void,
    onTurnEvent?: (event: RuntimeTurnEventInput) => void,
  ): Promise<AppMessageResponderResult>;
  touchChat(chatId: string): void;
  generatedSessionTitleHandler(
    chatId: string,
    sourceText: string,
  ): ((title: string) => void) | undefined;
  getTurnRow(turnId: string): TurnRow | null;
  turnExists(turnId: string): boolean;
  isTerminalTurn(turnId: string): boolean;
  shouldPersistRuntimeTurnEvent(turnId: string, kind: string): boolean;
  hasEquivalentProgressSummaryRow(
    turnId: string,
    input: ProgressSummaryInput,
  ): boolean;
  getMessageRow(messageId: string): MessageRow | null;
  messageRecordById(messageId: string): MessageRecord;
  getLatestAssistantMessageForTurn(turnId: string): MessageRow | null;
  nextSessionTurnEventSequence(sessionId: string): number;
  nextTurnEventSequence(turnId: string): number;
  cleanupTurnEventSequences(sessionId: string, turnId: string): void;
  hasTurnEventKind(turnId: string, kind: string): boolean;
  runtimeFaultRecordForTurn(turnId: string): Record<string, unknown> | null;
  appendEvent(type: string, payload: Record<string, unknown>): AppEventEnvelope;
}

export function createMessageRecordHost(
  kernel: AppStoreKernel,
): AppStoreKernelMessageRecordHost {
  return {
    ensureChat(chatId) {
      kernel.sessionRecords.ensureChat(chatId);
    },
    getQueuedMessageRow(queuedMessageId) {
      return kernel.sessionQueue.getQueuedMessageRow(queuedMessageId);
    },
    queuedControlsFromRow(row) {
      return kernel.sessionQueue.queuedControlsFromRow(row);
    },
    queuedMessageFromRow(row) {
      return kernel.sessionQueue.queuedMessageFromRow(row);
    },
    insertMessage(chatId, role, text, status, options = {}) {
      return kernel.sessionRecords.insertMessage(
        chatId,
        role,
        text,
        status,
        options,
      );
    },
    insertAssistantReplies(chatId, turnId, texts, files = [], changedFiles = []) {
      return kernel.assistantMessages.insertReplies(
        chatId,
        turnId,
        texts,
        files,
        changedFiles,
      );
    },
    insertOrReplaceAssistantReplies(
      chatId,
      turnId,
      texts,
      files = [],
      changedFiles = [],
    ) {
      return kernel.assistantMessages.insertOrReplaceReplies(
        chatId,
        turnId,
        texts,
        files,
        changedFiles,
      );
    },
    replaceMessageChangedFiles(messageId, paths) {
      return kernel.sessionRecords.replaceMessageChangedFiles(messageId, paths);
    },
    finalizeResponderLimitedDelivery(
      chatId,
      turnId,
      limitedDelivery,
      options = {},
    ) {
      return kernel.limitedDelivery.finalizeResponderLimitedDelivery(
        chatId,
        turnId,
        limitedDelivery,
        options,
      );
    },
    markResponderNonPublicContinuation(chatId, turnId, safeErrorCode) {
      return kernel.limitedDelivery.markResponderNonPublicContinuation(
        chatId,
        turnId,
        safeErrorCode,
      );
    },
    deleteAssistantMessagesForTurn(turnId) {
      kernel.assistantMessages.deleteForTurn(turnId);
    },
    upsertAssistantTurnFailure(chatId, turnId, safeError, options = {}) {
      return kernel.assistantMessages.upsertTurnFailure(
        chatId,
        turnId,
        safeError,
        options,
      );
    },
    ensureCancelledTurnActivityMessage(chatId, turnId) {
      return kernel.assistantMessages.ensureCancelledTurnActivity(
        chatId,
        turnId,
      );
    },
    messageWithTerminalWorkBlocks(message, turnId) {
      return kernel.sessionMessageProjection.messageWithTerminalWorkBlocks(
        message,
        turnId,
      );
    },
    updateMessage(messageId, input) {
      return kernel.sessionRecords.updateMessage(messageId, input);
    },
    async runResponder(
      chatId,
      turnId,
      messageId,
      text,
      responder,
      options = {},
      onProgress,
      onTurnEvent,
    ) {
      return await kernel.responderRuntime.run({
        chatId,
        turnId,
        messageId,
        text,
        responder,
        options,
        onProgress,
        onTurnEvent,
      });
    },
    touchChat(chatId) {
      kernel.sessionRecords.touchChat(chatId);
    },
    generatedSessionTitleHandler(chatId, sourceText) {
      return kernel.generatedSessionTitles.handler(chatId, sourceText);
    },
    getTurnRow(turnId) {
      return kernel.turns.getTurnRow(turnId);
    },
    turnExists(turnId) {
      return kernel.turns.turnExists(turnId);
    },
    isTerminalTurn(turnId) {
      return kernel.turns.isTerminalTurn(turnId);
    },
    shouldPersistRuntimeTurnEvent(turnId, kind) {
      return kernel.turns.shouldPersistRuntimeTurnEvent(turnId, kind);
    },
    hasEquivalentProgressSummaryRow(turnId, input) {
      return kernel.turnProgress.hasEquivalentProgressSummaryRow(
        turnId,
        input,
      );
    },
    getMessageRow(messageId) {
      return kernel.sessionRecords.getMessageRow(messageId);
    },
    messageRecordById(messageId) {
      return kernel.sessionRecords.messageRecordById(messageId);
    },
    getLatestAssistantMessageForTurn(turnId) {
      return kernel.sessionRecords.getLatestAssistantMessageForTurn(turnId);
    },
    nextSessionTurnEventSequence(sessionId) {
      return kernel.events.nextSessionTurnEventSequence(sessionId);
    },
    nextTurnEventSequence(turnId) {
      return kernel.events.nextTurnEventSequence(turnId);
    },
    cleanupTurnEventSequences(sessionId, turnId) {
      kernel.events.cleanupTurnEventSequences(sessionId, turnId);
    },
    hasTurnEventKind(turnId, kind) {
      return kernel.events.hasTurnEventKind(turnId, kind);
    },
    runtimeFaultRecordForTurn(turnId) {
      return kernel.events.runtimeFaultRecordForTurn(turnId);
    },
    appendEvent(type, payload) {
      return kernel.events.append(type, payload);
    },
  };
}
