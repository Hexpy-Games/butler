import type { TranscriptEvent } from "../../../../test-support/harness/transcripts.ts";
import {
  deliveryLimitationMetadataFromRecord,
  deliveryStateFromProjectedNoVisibleFinal,
  hasUnsupportedNoVisibleDeliveryState,
  shouldTreatLimitedFinalAsNoVisible,
} from "./app-delivery-projection.ts";
import {
  artifactRefsFromOutboundMessage,
  sanitizeAppTransportFinalText,
} from "./app-transport-projection.ts";
import type { MessageRow } from "../core/records.ts";
import type { AppTransportProjectionStoreOptions } from "./transport-projection-contract.ts";
import { artifactFilesFromOutbound } from "./outbound-artifact-files.ts";
import { safeOptionalShortToken } from "../core/projection-safe-values.ts";
import { projectClaimedOutbound } from "./claimed-outbound-projection.ts";

export function projectAppFinalResult(input: {
  options: AppTransportProjectionStoreOptions;
  markProjectedTransportEvent: (
    actionId: string,
    eventId: string,
    chatId: string,
  ) => void;
  chatId: string;
  turnId: string;
  actionId: string;
  event: TranscriptEvent;
  message: Record<string, unknown>;
  metadata: Record<string, unknown>;
  terminalRecoverableCorrection: boolean;
  queuedFinalProjection: "accept" | "reject";
  deleteStagedOutbound: () => void;
}): boolean {
  const {
    options,
    markProjectedTransportEvent,
    chatId,
    turnId,
    actionId,
    event,
    message,
    metadata,
    terminalRecoverableCorrection,
    queuedFinalProjection,
  } = input;
  if (queuedFinalProjection === "reject") {
    markProjectedTransportEvent(actionId, event.eventId, chatId);
    return false;
  }

  const text = sanitizeAppTransportFinalText(message.text);
  const artifacts = artifactRefsFromOutboundMessage(message.artifacts);
  const changedFiles = changedFilePathsFromOutbound(message.changedFiles);
  const delivery = deliveryLimitationMetadataFromRecord(metadata);
  const limitedDelivery = Boolean(delivery);
  const noVisibleReply =
    metadata.noVisibleReply === true ||
    shouldTreatLimitedFinalAsNoVisible(artifacts, delivery, metadata);
  const hasDurableQueueClaim = queuedSettlementRequired(options, chatId, turnId, metadata);
  if (noVisibleReply && hasDurableQueueClaim) {
    const settled = projectClaimedOutbound(
      options,
      { chatId, turnId, metadata },
      () => {
        input.deleteStagedOutbound();
        projectExecutionModelFromTranscript(options.db, turnId, metadata.executionModel);
        return projectNoVisibleTerminalFailure(options, chatId, turnId, metadata);
      },
    );
    if (!settled) return false;
    markProjectedTransportEvent(actionId, event.eventId, chatId);
    options.touchChat(chatId);
    void options.drainQueuedSessionMessages(chatId).catch(() => undefined);
    return true;
  }
  if (
    noVisibleReply &&
    hasUnsupportedNoVisibleDeliveryState(metadata, delivery)
  ) {
    markProjectedTransportEvent(actionId, event.eventId, chatId);
    return false;
  }
  if (
    !text && artifacts.length === 0 && changedFiles.length === 0 &&
    !noVisibleReply
  ) return false;
  if (noVisibleReply) {
    if (!hasDurableQueueClaim) {
      input.deleteStagedOutbound();
      projectExecutionModelFromTranscript(options.db, turnId, metadata.executionModel);
      options.finalizeResponderLimitedDelivery(chatId, turnId, {
        text: null,
        reason: delivery?.limitations[0] ?? "Internal recovery required.",
        delivery: deliveryStateFromProjectedNoVisibleFinal(delivery),
      });
      markProjectedTransportEvent(actionId, event.eventId, chatId);
      options.touchChat(chatId);
      return true;
    }
    input.deleteStagedOutbound();
    options.finalizeResponderLimitedDelivery(chatId, turnId, {
      text: null,
      reason: delivery?.limitations[0] ?? "Internal recovery required.",
      delivery: deliveryStateFromProjectedNoVisibleFinal(delivery),
    });
    const settled = settleQueuedTurn(options, chatId, turnId, metadata, undefined, "no_visible_result");
    if (!settled) {
      if (queuedSettlementRequired(options, chatId, turnId, metadata)) return false;
      markProjectedTransportEvent(actionId, event.eventId, chatId);
      options.touchChat(chatId);
      return true;
    }
    markProjectedTransportEvent(actionId, event.eventId, chatId);
    options.touchChat(chatId);
    void options.drainQueuedSessionMessages(chatId).catch(() => undefined);
    return true;
  }

  let settledForDrain = false;
  const projected = projectClaimedOutbound(
    options,
    { chatId, turnId, metadata },
    () => {
      input.deleteStagedOutbound();
      projectExecutionModelFromTranscript(options.db, turnId, metadata.executionModel);
      const existing = options.getLatestAssistantMessageForTurn(turnId);
      const artifactFiles = artifactFilesFromOutbound({
        butlerData: options.butlerData,
        butlerHome: options.butlerHome,
        messageFiles: options.messageFiles,
        getChatRow: options.getChatRow,
        getProjectRow: options.getProjectRow,
        chatId,
        artifacts,
        existingMessageId: existing?.id,
      });
      applyGeneratedSessionTitleFromProjection(options, {
        chatId,
        turnId,
        title: metadata.generatedSessionTitle,
      });
      if (
        isSameDeliveredFinal(existing, text, options.getTurn(turnId).state) &&
        artifactFiles.length === 0 && changedFiles.length === 0
      ) {
        const settled = settleQueuedTurn(options, chatId, turnId, metadata);
        if (!settled && queuedSettlementRequired(options, chatId, turnId, metadata)) {
          return false;
        }
        markProjectedTransportEvent(actionId, event.eventId, chatId);
        settledForDrain = settled;
        return true;
      }

      const files = options.messageFiles.createResponderFiles(
        chatId,
        artifactFiles,
      );
      if (!options.hasTurnEventKind(turnId, "message.final.started")) {
        options.appendTurnEvent(chatId, turnId, {
          kind: "message.final.started",
          payload: { safeLabel: "Preparing final answer" },
        });
      }
      const replies = options.insertOrReplaceAssistantReplies(
        chatId,
        turnId,
        text ? [text] : [],
        files,
        changedFiles,
      );
      if (
        terminalRecoverableCorrection ||
        !options.hasTurnEventKind(turnId, "message.final.completed")
      ) {
        options.appendTurnEvent(chatId, turnId, {
          kind: "message.final.completed",
          payload: {
            safeLabel: limitedDelivery
              ? "Final answer ready with limitations"
              : "Final answer ready",
            textChars: text.length,
            ...(delivery ?? {}),
          },
        });
      }
      const deliveredTurn = options.updateTurnState(turnId, "delivered", {
        safeStatusLabel: limitedDelivery
          ? "Delivered with limitations"
          : "Delivered",
        retryable: false,
        cancellable: false,
        safeErrorCode: null,
      });
      options.appendTerminalTurnStateChanged(deliveredTurn);
      if (
        terminalRecoverableCorrection ||
        !options.hasTurnEventKind(turnId, "turn.completed")
      ) {
        options.appendTurnEvent(chatId, turnId, {
          kind: "turn.completed",
          payload: {
            safeLabel: limitedDelivery ? "Completed with limitations" : "Completed",
            ...(delivery ?? {}),
          },
        });
      }
      const settled = settleQueuedTurn(
        options,
        chatId,
        turnId,
        metadata,
        replies.at(-1)?.id,
      );
      if (!settled && queuedSettlementRequired(options, chatId, turnId, metadata)) {
        return false;
      }
      markProjectedTransportEvent(actionId, event.eventId, chatId);
      options.touchChat(chatId);
      settledForDrain = settled;
      return true;
    },
  );
  if (!projected) return false;
  if (settledForDrain) void options.drainQueuedSessionMessages(chatId).catch(() => undefined);
  return true;
}

function changedFilePathsFromOutbound(value: unknown): import("../../../../agent/tools/file-tools/shared/changed-file-detail.ts").ChangedFileDetail[] {
  if (!Array.isArray(value)) return [];
  return value.filter((detail): detail is import("../../../../agent/tools/file-tools/shared/changed-file-detail.ts").ChangedFileDetail =>
    Boolean(detail && typeof detail === "object" && !Array.isArray(detail) &&
      typeof (detail as Record<string, unknown>).path === "string" &&
      Array.isArray((detail as Record<string, unknown>).lines)),
  ).slice(0, 40);
}

function settleQueuedTurn(
  options: AppTransportProjectionStoreOptions,
  chatId: string,
  turnId: string,
  metadata: Record<string, unknown>,
  resultMessageId?: string,
  safeErrorCode?: string,
): boolean {
  const claimId = safeOptionalShortToken(metadata.appQueueClaimId);
  if (!claimId) return false;
  return options.acknowledgeQueuedMessageForTurn({
    chatId,
    turnId,
    claimId,
    ...(resultMessageId ? { resultMessageId } : {}),
    ...(safeErrorCode ? { safeErrorCode } : {}),
  });
}

function queuedSettlementRequired(
  options: AppTransportProjectionStoreOptions,
  chatId: string,
  turnId: string,
  metadata: Record<string, unknown>,
): boolean {
  return options.queuedTurnClaimStatus(
    chatId,
    turnId,
    safeOptionalShortToken(metadata.appQueueClaimId),
  ) !== "unlinked";
}

function projectNoVisibleTerminalFailure(
  options: AppTransportProjectionStoreOptions,
  chatId: string,
  turnId: string,
  metadata: Record<string, unknown>,
): boolean {
  const safeError = {
    code: "no_visible_result",
    message: "Butler could not produce a visible answer for this request.",
  };
  if (!options.hasTurnEventKind(turnId, "turn.failed")) {
    options.appendTurnEvent(chatId, turnId, {
      kind: "turn.failed",
      payload: {
        safeLabel: "No visible answer",
        safeErrorCode: safeError.code,
      },
    });
  }
  const failedTurn = options.updateTurnState(turnId, "failed", {
    safeStatusLabel: "Failed",
    safeErrorCode: safeError.code,
    retryable: false,
    cancellable: false,
  });
  options.appendTerminalTurnStateChanged(failedTurn);
  return settleQueuedTurn(options, chatId, turnId, metadata, undefined, safeError.code);
}

function projectExecutionModelFromTranscript(
  db: AppTransportProjectionStoreOptions["db"],
  turnId: string,
  value: unknown,
): void {
  if (!tableHasColumn(db, "turns", "execution_model_json")) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const identity = value as Record<string, unknown>;
  if (
    !isModelRef(identity.requestedModelRef) ||
    !isModelRef(identity.effectiveModelRef) ||
    (identity.providerReportedModelRef !== undefined &&
      !isModelRef(identity.providerReportedModelRef))
  ) return;
  db.query(`
    UPDATE turns
    SET execution_model_json = ?, updated_at = ?
    WHERE id = ?
  `).run(
    JSON.stringify({
      requested_model_ref: identity.requestedModelRef,
      adapter_effective_model_ref: identity.effectiveModelRef,
      ...(identity.providerReportedModelRef
        ? { provider_reported_model_ref: identity.providerReportedModelRef }
        : {}),
    }),
    new Date().toISOString(),
    turnId,
  );
}

function isModelRef(value: unknown): value is string {
  return typeof value === "string" && value.length <= 256 &&
    /^[^/\s]+\/[^/\s]+$/u.test(value);
}

function tableHasColumn(
  db: AppTransportProjectionStoreOptions["db"],
  table: string,
  column: string,
): boolean {
  return db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all()
    .some((row) => row.name === column);
}

export function isSameDeliveredFinalProjection(input: {
  options: AppTransportProjectionStoreOptions;
  turnId: string;
  turnState: string;
  message: Record<string, unknown>;
}): boolean {
  return isSameDeliveredFinal(
    input.options.getLatestAssistantMessageForTurn(input.turnId),
    sanitizeAppTransportFinalText(input.message.text),
    input.turnState,
  );
}

function applyGeneratedSessionTitleFromProjection(
  options: AppTransportProjectionStoreOptions,
  input: { chatId: string; turnId: string; title: unknown },
): void {
  if (typeof input.title !== "string" || !input.title.trim()) return;
  const turn = options.getTurnRow(input.turnId);
  const sourceText = turn?.user_message_id
    ? options.getMessageRow(turn.user_message_id)?.text
    : null;
  if (!sourceText) return;
  options.generatedSessionTitleHandler(input.chatId, sourceText)?.(
    input.title,
  );
}

function isSameDeliveredFinal(
  existing: MessageRow | null,
  text: string,
  turnState: string,
): boolean {
  return (
    existing?.text === text &&
    existing.status === "delivered" &&
    turnState === "delivered"
  );
}
