import type {
  MessageSendRequest,
  PlanDecisionRequest,
  QueueMessageRequest,
} from "./messaging-contract.ts";
import { isMessageContent, messageContentText } from "../../../../foundation/message-content.ts";

export function isPlanDecisionRequest(
  value: unknown,
): value is PlanDecisionRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Partial<PlanDecisionRequest>;
  return (input.action === "accept" || input.action === "reject" ||
      input.action === "instruct") &&
    (input.instruction === undefined || typeof input.instruction === "string");
}

export function isMessageSendRequest(
  value: unknown,
): value is MessageSendRequest {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<MessageSendRequest>;
  if (input.content_parts !== undefined) {
    if (!isMessageContent(input.content_parts)) return false;
    return isMessageSendRequest({ ...input, content_parts: undefined, text: messageContentText(input.content_parts) });
  }
  const hasText =
    typeof input.text === "string" && input.text.trim().length > 0;
  const hasAttachments =
    Array.isArray(input.attachments) &&
    input.attachments.length > 0 &&
    input.attachments.every(
      (attachment) =>
        Boolean(attachment) &&
        typeof attachment === "object" &&
        typeof attachment.file_id === "string" &&
        attachment.file_id.trim().length > 0,
    );
  return (
    (typeof input.text === "string" || hasAttachments) &&
    (hasText || hasAttachments)
  );
}

export function isQueueMessageRequest(
  value: unknown,
): value is QueueMessageRequest {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<QueueMessageRequest>;
  if (input.content_parts !== undefined) {
    if (!isMessageContent(input.content_parts)) return false;
    return isQueueMessageRequest({ ...input, content_parts: undefined, text: messageContentText(input.content_parts) });
  }
  const hasText =
    typeof input.text === "string" && input.text.trim().length > 0;
  const hasAttachments =
    Array.isArray(input.attachments) &&
    input.attachments.length > 0 &&
    input.attachments.every(
      (attachment) =>
        Boolean(attachment) &&
        typeof attachment === "object" &&
        typeof attachment.file_id === "string" &&
        attachment.file_id.trim().length > 0,
    );
  return (
    (typeof input.text === "string" || hasAttachments) &&
    (hasText || hasAttachments)
  );
}
