import type {
  ContextDetailsView,
  MessageFileRef,
  MessageFileUploadResult,
  MessageRecord,
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
  refreshSessionProjection(sessionId: string): number;
  getSessionView(sessionId: string): SessionView;
  listArtifacts(sessionId: string): SessionArtifactSummary[];
  exportTranscript(sessionId: string): TranscriptExportView;
  listMessages(chatId?: string, cursor?: number): MessageRecord[];
  listTurns(chatId?: string, cursor?: number): TurnRecord[];
  listTurnProgressSnapshotsForMessages(
    messages: MessageRecord[],
  ): Record<string, TurnProgressSnapshotView>;
  getTurn(turnId: string): TurnRecord;
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
  createQueuedMessage(input: QueueMessageRequest): SessionQueueView;
  updateQueuedMessage(
    queuedMessageId: string,
    input: UpdateQueuedMessageRequest,
  ): SessionQueueView;
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
  cancelTurn(turnId: string): TurnActionResult;
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
      kernel.reconcileDeliveredSystemResponderTurns(sessionId);
      return kernel.syncAppTransportEventsForChat(sessionId);
    },
    getSessionView(sessionId) {
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
    createMessageFile(input) {
      return kernel.messageFiles.create(input);
    },
    getMessageFileDownload(fileId) {
      return kernel.messageFiles.download(fileId);
    },
    listSessionQueue(sessionId = DEFAULT_CHAT_ID) {
      return kernel.sessionQueue.listSessionQueue(sessionId);
    },
    createQueuedMessage(input) {
      return kernel.sessionQueue.createQueuedMessage(input);
    },
    updateQueuedMessage(queuedMessageId, input) {
      return kernel.sessionQueue.updateQueuedMessage(queuedMessageId, input);
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
    cancelTurn(turnId) {
      return kernel.turnActions.cancelTurn(turnId);
    },
  };
}
