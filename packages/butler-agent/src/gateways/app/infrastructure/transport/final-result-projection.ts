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
import { queuedFinalProjectionDisposition } from "./inbound-queue-terminal-records.ts";

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
  } = input;
  const queuedFinalProjection = queuedFinalProjectionDisposition({
    butlerData: options.butlerData,
    metadata,
  });
  if (queuedFinalProjection === "reject") {
    markProjectedTransportEvent(actionId, event.eventId, chatId);
    return false;
  }
  if (queuedFinalProjection === "defer") return false;

  const text = sanitizeAppTransportFinalText(message.text);
  const artifacts = artifactRefsFromOutboundMessage(message.artifacts);
  const delivery = deliveryLimitationMetadataFromRecord(metadata);
  const limitedDelivery =
    delivery?.delivery_state === "delivered_with_limitations";
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
  applyGeneratedSessionTitleFromProjection(options, {
    chatId,
    turnId,
    title: metadata.generatedSessionTitle,
  });
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
