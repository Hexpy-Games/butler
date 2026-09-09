import type { MessageContent, ResolvedSessionReference } from "../../../../foundation/message-content.ts";
import type { ChatRow } from "../../infrastructure/core/records.ts";
import { AgentConversationStore } from "../../../../agent/conversation/store.ts";
import { conversationMessageText } from "../../../../agent/conversation/message-text.ts";
import { sessionHintForRow } from "./session-read-model.ts";

/** Local App authority resolves App ids; no client-supplied canonical identity is trusted. */
export function resolveSessionReferences(input: {
  content?: MessageContent; butlerData: string; getChat(id: string): ChatRow | null;
}): ResolvedSessionReference[] {
  const references = input.content?.parts.filter(part => part.type === "session_ref") ?? [];
  if (!references.length) return [];
  const unique = new Map(references.map(reference => [reference.sessionId, reference]));
  const conversations = new AgentConversationStore({ butlerData: input.butlerData });
  let previewBudget = 4096;
  try {
    return [...unique.values()].map(reference => {
      const session = input.getChat(reference.sessionId);
      if (!session) return { sessionId: reference.sessionId, title: reference.titleSnapshot, canonicalSessionId: null, status: "unavailable", preview: "" };
      const canonical = conversations.getSessionByGatewayBinding("app", sessionHintForRow(session.id));
      let preview = "";
      if (canonical && previewBudget > 0) {
        preview = conversations.readCognitionMessages({ sessionId: canonical.id, roles: ["user", "assistant"], limit: 2, order: "desc" })
          .reverse().map(message => `${message.role}: ${conversationMessageText(message)}`).join("\n").slice(0, Math.min(1024, previewBudget));
        previewBudget -= preview.length;
      }
      return { sessionId: session.id, title: session.title, canonicalSessionId: canonical?.id ?? null, status: canonical ? "available" : "empty", preview };
    });
  } finally { conversations.close(); }
}
