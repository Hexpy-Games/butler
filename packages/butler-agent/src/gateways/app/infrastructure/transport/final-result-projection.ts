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

  projectExecutionModelFromTranscript(options.db, turnId, metadata.executionModel);

  const text = sanitizeAppTransportFinalText(message.text);
  const artifacts = artifactRefsFromOutboundMessage(message.artifacts);
  const delivery = deliveryLimitationMetadataFromRecord(metadata);
  const limitedDelivery = Boolean(delivery);
  const noVisibleReply =
    metadata.noVisibleReply === true ||
    shouldTreatLimitedFinalAsNoVisible(artifacts, delivery, metadata);
  if (
    noVisibleReply &&
    hasUnsupportedNoVisibleDeliveryState(metadata, delivery)
  ) {
    markProjectedTransportEvent(actionId, event.eventId, chatId);
    return false;
  }
  if (!text && artifacts.length === 0 && !noVisibleReply) return false;
  if (noVisibleReply) {
    options.finalizeResponderLimitedDelivery(chatId, turnId, {
      text: null,
      reason: delivery?.limitations[0] ?? "Internal recovery required.",
      delivery: deliveryStateFromProjectedNoVisibleFinal(delivery),
    });
    markProjectedTransportEvent(actionId, event.eventId, chatId);
    options.touchChat(chatId);
    return true;
  }

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
    artifactFiles.length === 0
  ) {
    markProjectedTransportEvent(actionId, event.eventId, chatId);
    return false;
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
  options.insertOrReplaceAssistantReplies(
    chatId,
    turnId,
    text ? [text] : [],
    files,
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
  markProjectedTransportEvent(actionId, event.eventId, chatId);
  options.touchChat(chatId);
  void options.drainQueuedSessionMessages(chatId).catch(() => undefined);
  return true;
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
