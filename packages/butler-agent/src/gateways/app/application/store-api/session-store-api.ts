import type {
  AppConversationProjectionRebuildResult,
  AppConversationProjectionReplayResult,
  AppConversationProjectionStatus,
  AppConversationProjectionActivityState,
  AppConversationProjectionBindingRef,
} from "../../domain/projections/app-conversation-projection-store.ts";
import type {
  ContextDetailsView,
  MessageFileRef,
  MessageFileUploadResult,
  MessageRecord,
  OperationOutputView,
  MessageSendRequest,
  MessageSendResult,
  QueueMessageRequest,
  SessionArtifactSummary,
  SessionControlState,
  SessionControlsView,
  SessionQueueView,
  SessionSummaryView,
  SessionView,
  TranscriptExportView,
  TurnActionResult,
  TurnProgressSnapshotView,
  TurnRecord,
  UpdateQueuedMessageRequest,
} from "../../interface/protocol/app-protocol.ts";
import type {
  AppMessageResponder,
  SendMessageOptions,
} from "../../domain/sessions/message-responder-contract.ts";
import type { AppStoreKernel } from "../kernel/app-store-kernel.ts";
import { operationOutputIsLinked } from
  "../../domain/progress-summary/operation-output-reference.ts";

const DEFAULT_CHAT_ID = "general";

export interface AppStoreSessionApi {
  getSessionControlsView(sessionId: string): SessionControlsView;
  updateSessionControlsView(
    sessionId: string,
    input: Partial<SessionControlState>,
  ): SessionControlsView;
  getSessionControls(sessionId: string): SessionControlState;
  updateSessionControls(
    sessionId: string,
    input: Partial<SessionControlState>,
  ): SessionControlState;
  getContextDetails(sessionId: string): ContextDetailsView;
  getSessionSummary(sessionId: string): SessionSummaryView;
  refreshSessionProjection(sessionId: string): void;
  getConversationProjectionStatus(): AppConversationProjectionStatus;
  replayConversationProjection(input?: { limit?: number }): AppConversationProjectionReplayResult;
  rebuildConversationProjection(conversationSessionId: string): AppConversationProjectionRebuildResult;
  getConversationProjectionBinding(conversationSessionId: string): AppConversationProjectionBindingRef | null;
  getConversationProjectionSessionView(conversationSessionId: string): SessionView | null;
  listConversationProjectionMessages(conversationSessionId: string, cursor?: number): MessageRecord[];
  getConversationProjectionActivityState(conversationSessionId: string): AppConversationProjectionActivityState;
  getSessionView(sessionId: string): SessionView;
  listArtifacts(sessionId: string): SessionArtifactSummary[];
  exportTranscript(sessionId: string): TranscriptExportView;
  listMessages(chatId?: string, cursor?: number): MessageRecord[];
  listTurns(chatId?: string, cursor?: number): TurnRecord[];
  listTurnProgressSnapshotsForMessages(
    messages: MessageRecord[],
  ): Record<string, TurnProgressSnapshotView>;
  getTurn(turnId: string): TurnRecord;
  getOperationOutput(input: {
    turnId: string;
    requestId: string;
    resultId: string;
    byteStart: number;
  }): OperationOutputView | null;
  createMessageFile(input: {
    ownerSessionId?: string;
    name: string;
    mimeType?: string;
    bytes: Uint8Array | ArrayBuffer | string;
    allowGeneric?: boolean;
  }): MessageFileUploadResult;
  getMessageFileDownload(fileId: string): {
    file: MessageFileRef;
    bytes: Buffer;
  };
  listSessionQueue(sessionId?: string): SessionQueueView;
  createQueuedMessage(input: QueueMessageRequest): Promise<SessionQueueView>;
  updateQueuedMessage(
    queuedMessageId: string,
    input: UpdateQueuedMessageRequest,
  ): Promise<SessionQueueView>;
  deleteQueuedMessage(queuedMessageId: string): SessionQueueView;
  sendMessage(
    input: MessageSendRequest,
    responder?: AppMessageResponder,
    options?: SendMessageOptions,
  ): Promise<MessageSendResult>;
  retryTurn(
    turnId: string,
    responder?: AppMessageResponder,
    options?: SendMessageOptions,
  ): Promise<TurnActionResult>;
  retryTurnWithCurrentControls(
    turnId: string,
    responder?: AppMessageResponder,
    options?: SendMessageOptions,
  ): Promise<MessageSendResult>;
  cancelTurn(turnId: string): Promise<TurnActionResult>;
}

export function createSessionStoreApi(
  kernel: AppStoreKernel,
): AppStoreSessionApi {
  return {
    getSessionControlsView(sessionId) {
      return kernel.sessionControls.getView(sessionId);
    },
    updateSessionControlsView(sessionId, input) {
      return kernel.sessionControls.updateView(sessionId, input);
    },
    getSessionControls(sessionId) {
      return kernel.sessionControls.get(sessionId);
    },
    updateSessionControls(sessionId, input) {
      return kernel.sessionControls.update(sessionId, input);
    },
    getContextDetails(sessionId) {
      return kernel.contextDetails.getContextDetails(sessionId);
    },
    getSessionSummary(sessionId) {
      return kernel.sessionViews.getSessionSummary(sessionId);
    },
    refreshSessionProjection(sessionId) {
      kernel.conversationProjection.replayOutbox();
      kernel.reconcileDeliveredSystemResponderTurns(sessionId);
    },
    getConversationProjectionStatus() {
      return kernel.conversationProjection.status();
    },
    replayConversationProjection(input = {}) {
      return kernel.conversationProjection.replayOutbox(input);
    },
    rebuildConversationProjection(conversationSessionId) {
      return kernel.conversationProjection.rebuildSession(conversationSessionId);
    },
    getConversationProjectionBinding(conversationSessionId) {
      return kernel.conversationProjection.readConversationBinding(conversationSessionId);
    },
    getConversationProjectionSessionView(conversationSessionId) {
      const appSessionId = kernel.conversationProjection
        .appSessionIdForConversation(conversationSessionId);
      return appSessionId ? kernel.sessionViews.getSessionView(appSessionId) : null;
    },
    listConversationProjectionMessages(conversationSessionId, cursor = 0) {
      return kernel.conversationProjection.listMessageProjection(
        conversationSessionId,
        cursor,
        (messageId) => kernel.messageFiles.refsForMessage(messageId),
      );
    },
    getConversationProjectionActivityState(conversationSessionId) {
      return kernel.conversationProjection.readActivityState(conversationSessionId);
    },
    getSessionView(sessionId) {
      kernel.turnActions.reconcileCancellationSettlements(sessionId);
      kernel.turnActions.reconcileCancelledTurnActivityMessages(sessionId);
      return kernel.sessionViews.getSessionView(sessionId);
    },
    listArtifacts(sessionId) {
      return kernel.sessionViews.listArtifacts(sessionId);
    },
    exportTranscript(sessionId) {
      return kernel.sessionViews.exportTranscript(sessionId);
    },
    listMessages(chatId = DEFAULT_CHAT_ID, cursor = 0) {
      return kernel.sessionRecords.listMessages(chatId, cursor);
    },
    listTurns(chatId = DEFAULT_CHAT_ID, cursor = 0) {
      return kernel.sessionRecords.listTurns(chatId, cursor);
    },
    listTurnProgressSnapshotsForMessages(messages) {
      return kernel.turnProgressView.listForMessages(messages);
    },
    getTurn(turnId) {
      return kernel.turns.getTurn(turnId);
    },
    getOperationOutput(input) {
      return kernel.operationOutputs.read({
        ...input,
        allowAliasedRequest: operationOutputIsLinked(
          kernel.turnProgress.listProgressRowsForTurn(input.turnId),
          input.requestId,
          input.resultId,
        ),
      });
    },
    createMessageFile(input) {
      return kernel.messageFiles.create(input);
    },
    getMessageFileDownload(fileId) {
      return kernel.messageFiles.download(fileId);
    },
    listSessionQueue(sessionId = DEFAULT_CHAT_ID) {
      return kernel.sessionQueue.listSessionQueue(sessionId);
    },
    async createQueuedMessage(input) {
      return await kernel.sessionQueue.createQueuedMessage(input);
    },
    async updateQueuedMessage(queuedMessageId, input) {
      return await kernel.sessionQueue.updateQueuedMessage(queuedMessageId, input);
    },
    deleteQueuedMessage(queuedMessageId) {
      return kernel.sessionQueue.deleteQueuedMessage(queuedMessageId);
    },
    async sendMessage(input, responder, options = {}) {
      return await kernel.userMessageTurns.sendMessage(
        input,
        responder,
        options,
      );
    },
    async retryTurn(turnId, responder, options = {}) {
      return await kernel.turnActions.retryTurn(turnId, responder, options);
    },
    async retryTurnWithCurrentControls(turnId, responder, options = {}) {
      return await kernel.turnActions.retryTurnWithCurrentControls(
        turnId,
        responder,
        options,
      );
    },
    async cancelTurn(turnId) {
      return await kernel.turnActions.cancelTurn(turnId);
    },
  };
}
