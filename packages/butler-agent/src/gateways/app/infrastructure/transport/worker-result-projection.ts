import type { TranscriptEvent } from "../../../../test-support/harness/transcripts.ts";
import {
  artifactRefsFromOutboundMessage,
  sanitizeAppTransportFinalText,
} from "./app-transport-projection.ts";
import type { AppTransportProjectionStoreOptions } from "./transport-projection-contract.ts";
import { artifactFilesFromOutbound } from "./outbound-artifact-files.ts";

export function projectAppWorkerResult(input: {
  options: AppTransportProjectionStoreOptions;
  hasProjectedTransportEvent: (actionId: string) => boolean;
  markProjectedTransportEvent: (
    actionId: string,
    eventId: string,
    chatId: string,
  ) => void;
  chatId: string;
  event: TranscriptEvent;
  actionId: string | undefined;
  message: Record<string, unknown>;
}): boolean {
  const {
    options,
    hasProjectedTransportEvent,
    markProjectedTransportEvent,
    chatId,
    event,
    actionId,
    message,
  } = input;
  if (!actionId || hasProjectedTransportEvent(actionId)) return false;
  const text = sanitizeAppTransportFinalText(message.text);
  const artifacts = artifactRefsFromOutboundMessage(message.artifacts);
  if (!text && artifacts.length === 0) return false;
  const files = options.messageFiles.createResponderFiles(
    chatId,
    artifactFilesFromOutbound({
      butlerData: options.butlerData,
      butlerHome: options.butlerHome,
      messageFiles: options.messageFiles,
      getChatRow: options.getChatRow,
      getProjectRow: options.getProjectRow,
      chatId,
      artifacts,
    }),
  );
  const projected = options.insertMessage(
    chatId,
    "assistant",
    text,
    "delivered",
    {
      attachments: files,
    },
  );
  options.appendEvent("message.created", { message: projected });
  markProjectedTransportEvent(actionId, event.eventId, chatId);
  options.touchChat(chatId);
  return true;
}
