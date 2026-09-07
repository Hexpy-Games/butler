export type MessageContentPart =
  | { type: "text"; text: string }
  | { type: "session_ref"; sessionId: string; titleSnapshot: string };
export interface MessageContent { version: 1; parts: MessageContentPart[] }
export interface ResolvedSessionReference {
  sessionId: string; title: string; canonicalSessionId: string | null;
  status: "available" | "empty" | "unavailable"; preview: string;
}

export function isMessageContent(value: unknown): value is MessageContent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const doc = value as Partial<MessageContent>;
  return doc.version === 1 && Array.isArray(doc.parts) && doc.parts.every(part =>
    part && typeof part === "object" && (part.type === "text"
      ? typeof part.text === "string"
      : part.type === "session_ref" && typeof part.sessionId === "string" && part.sessionId.trim().length > 0 &&
        typeof part.titleSnapshot === "string"));
}

export function messageContentText(content: MessageContent): string {
  return content.parts.map(part => part.type === "text" ? part.text : `@${part.titleSnapshot}`).join("");
}

export function readMessageContent(json: string | null | undefined): MessageContent | undefined {
  if (!json) return undefined;
  const parsed: unknown = JSON.parse(json);
  if (!isMessageContent(parsed)) throw new Error("invalid_message_content");
  return parsed;
}
