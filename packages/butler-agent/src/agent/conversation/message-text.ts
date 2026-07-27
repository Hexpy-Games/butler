import type { ConversationMessageWithParts } from "./types.ts";

export function conversationMessageText(message: ConversationMessageWithParts): string {
  return message.parts
    .filter((part) => part.kind === "text")
    .map((part) => {
      const content = part.content_json;
      if (!content || typeof content !== "object" || Array.isArray(content)) return "";
      const value = (content as Record<string, unknown>).text;
      return typeof value === "string" ? value : "";
    })
    .filter(Boolean)
    .join(" ")
    .trim();
}
