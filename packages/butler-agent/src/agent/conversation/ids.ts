export type ConversationIdPrefix = "cs" | "ct" | "cm" | "cp" | "csm" | "cpo" | "cto";
export type ConversationIdFactory = (prefix: ConversationIdPrefix) => string;

export function defaultConversationIdFactory(prefix: ConversationIdPrefix): string {
  return `${prefix}_${crypto.randomUUID()}`;
}
