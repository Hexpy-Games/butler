import { createHash } from "node:crypto";
import type { ConversationMessageWithParts } from "./types.ts";

/**
 * Stable source identity for a canonical message sequence. The iterable
 * boundary lets bounded readers hash streamed rows without retaining a whole
 * history page, while arrays remain valid callers for existing write paths.
 */
export function conversationMessagesSourceHash(
  messages: Iterable<ConversationMessageWithParts>,
): string {
  const hash = createHash("sha256");
  hash.update("[");
  let first = true;
  for (const message of messages) {
    if (!first) hash.update(",");
    hash.update(JSON.stringify(conversationMessageSourcePayload(message)));
    first = false;
  }
  hash.update("]");
  return `sha256:${hash.digest("hex")}`;
}

function conversationMessageSourcePayload(message: ConversationMessageWithParts) {
  return {
    id: message.id,
    session_id: message.session_id,
    turn_id: message.turn_id,
    seq: message.seq,
    role: message.role,
    visibility: message.visibility,
    provenance: message.provenance,
    created_at: message.created_at,
    source_gateway: message.source_gateway,
    source_ref: message.source_ref,
    parts: message.parts.map((part) => ({
      id: part.id,
      part_index: part.part_index,
      kind: part.kind,
      content_json: part.content_json,
      tool_call_id: part.tool_call_id,
      parent_tool_call_id: part.parent_tool_call_id,
      provider_shape: part.provider_shape,
      status: part.status,
    })),
  };
}
