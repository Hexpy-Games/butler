import type { MessageSendRequest, QueueMessageRequest } from "./messaging-contract.ts";

export function isMessageSendRequest(
  value: unknown,
): value is MessageSendRequest {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<MessageSendRequest>;
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
