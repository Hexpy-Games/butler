import type { ProviderModelMetadata } from "../../../../integrations/providers/model-catalog.ts";
import type {
  ChatRow,
  ProjectRow,
} from "../../infrastructure/core/records.ts";
import type { DeliveryLimitationMetadata } from "../../infrastructure/transport/app-delivery-projection.ts";
import type { ProgressSummaryInput } from "../../domain/progress-summary/progress-row-normalizer.ts";
import { sessionHintForRow } from "../../domain/sessions/session-read-model.ts";
import type {
  MessageRecord,
  ProgressSummaryRow,
  SessionControlState,
  SessionSummaryView,
  SessionView,
  SessionViewTurn,
  TurnRecord,
} from "../../interface/protocol/app-protocol.ts";
import type { AppStoreKernel } from "../kernel/app-store-kernel.ts";
import type { TurnControlResolution } from "../../../core/turn-execution-controls.ts";

export interface AppStoreKernelSessionContextHost {
  localModelMetadata(): ProviderModelMetadata[];
  registeredModelMetadata(): ProviderModelMetadata[];
  loadedSkillNamesForSession(sessionId: string, turnId?: string): string[];
  controlsForMessageSend(
    sessionId: string,
    input: Partial<SessionControlState>,
  ): SessionControlState;
  resolveControlsForMessageSend(
    sessionId: string,
    input: Partial<SessionControlState>,
  ): TurnControlResolution;
  hasExplicitSessionControls(sessionId: string): boolean;
  listActiveWorkStreams(
    sessionId: string,
    runtimeSessionId?: string,
    currentTurnId?: string,
  ): SessionView["work_streams"];
  sessionViewTurn(
    turn: TurnRecord,
    options?: { suppressProgressRows?: boolean },
  ): SessionViewTurn;
  sessionViewMessages(sessionId: string): MessageRecord[];
  deliveryMetadataForTurnRecord(
    turn: TurnRecord,
  ): DeliveryLimitationMetadata;
  syncAppTransportEventsForChat(chatId: string): number;
  latestEventCursor(): number;
  appendProgressSummaryEvent(
    sessionId: string,
    turnId: string,
    input: ProgressSummaryInput,
  ): ProgressSummaryRow;
  listProgressRowsForTurn(turnId: string): ProgressSummaryRow[];
  internalContinuationProgressEventIds(turnId: string): Set<string>;
  getChatRow(chatId: string): ChatRow | null;
  getProjectRow(projectId: string): ProjectRow | null;
  getProjectForSession(sessionId: string): ProjectRow | null;
  safeSessionLabel(sessionId: string): string;
  chatIdForRuntimeSession(runtimeSessionId: string): string | null;
  branchInfoForSession(sessionId: string): SessionSummaryView["branch_info"];
}

export function createSessionContextHost(
  kernel: AppStoreKernel,
): AppStoreKernelSessionContextHost {
  return {
    localModelMetadata() {
      return kernel.modelRegistry.localModelMetadata();
    },
    registeredModelMetadata() {
      return kernel.modelRegistry.registeredModelMetadata();
    },
    loadedSkillNamesForSession(sessionId, turnId) {
      return kernel.integrations.loadedSkillNamesForSession(sessionId, turnId);
    },
    controlsForMessageSend(sessionId, input) {
      return kernel.sessionControls.controlsForMessageSend(sessionId, input);
    },
    resolveControlsForMessageSend(sessionId, input) {
      return kernel.sessionControls.resolveForMessageSend(sessionId, input);
    },
    hasExplicitSessionControls(sessionId) {
      return kernel.sessionControls.hasExplicit(sessionId);
    },
    listActiveWorkStreams(
      sessionId,
      runtimeSessionId = sessionHintForRow(sessionId),
      currentTurnId,
    ) {
      return kernel.workers.listActiveWorkStreams(
        sessionId,
        runtimeSessionId,
        currentTurnId,
      );
    },
    sessionViewTurn(turn, options = {}) {
      return kernel.turnProgressView.sessionViewTurn(turn, options);
    },
    sessionViewMessages(sessionId) {
      return kernel.sessionMessageProjection.sessionViewMessages(sessionId);
    },
    deliveryMetadataForTurnRecord(turn) {
      return kernel.sessionMessageProjection.deliveryMetadataForTurnRecord(
        turn,
      );
    },
    syncAppTransportEventsForChat(chatId) {
      return kernel.transportProjection.syncChat(chatId);
    },
    latestEventCursor() {
      return kernel.events.latestCursor();
    },
    appendProgressSummaryEvent(sessionId, turnId, input) {
      return kernel.turnProgress.appendProgressSummaryEvent(
        sessionId,
        turnId,
        input,
      );
    },
    listProgressRowsForTurn(turnId) {
      return kernel.turnProgress.listProgressRowsForTurn(turnId);
    },
    internalContinuationProgressEventIds(turnId) {
      return kernel.turnProgress.internalContinuationProgressEventIds(turnId);
    },
    getChatRow(chatId) {
      return kernel.sessionRecords.getChatRow(chatId);
    },
    getProjectRow(projectId) {
      return kernel.projects.getProjectRow(projectId);
    },
    getProjectForSession(sessionId) {
      const chat = kernel.getChatRow(sessionId);
      return chat?.project_id ? kernel.getProjectRow(chat.project_id) : null;
    },
    safeSessionLabel(sessionId) {
      try {
        return kernel.sessionRecords.getSession(sessionId).title;
      } catch {
        return "Unavailable session";
      }
    },
    chatIdForRuntimeSession(runtimeSessionId) {
      const rows = kernel.db
        .query<{ id: string }, []>("SELECT id FROM chats")
        .all();
      return (
        rows.find((row) => sessionHintForRow(row.id) === runtimeSessionId)
          ?.id ?? null
      );
    },
    branchInfoForSession(sessionId) {
      const project = kernel.getProjectForSession(sessionId);
      if (!project) {
        return {
          available: false,
          workspace_mode: "none",
          safe_status: "No project workspace",
        };
      }
      return {
        available: false,
        workspace_mode: "folder",
        safe_status: "Project workspace",
      };
    },
  };
}
