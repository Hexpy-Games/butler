import type { Database } from "bun:sqlite";
import type { MessageRecord } from "../../interface/protocol/app-protocol.ts";
import { AgentConversationStore } from "../../../../agent/conversation/store.ts";
import { conversationMessageText } from "../../../../agent/conversation/message-text.ts";
import { visibleMessageSqlPredicate } from "./visible-message-sql.ts";
import { messageFromRow } from "./message-read-model.ts";
import type { MessageRow } from "../../infrastructure/core/records.ts";
import { sessionHintForRow } from "./session-read-model.ts";
import { appChatIdForConversationExternalSession } from "../projections/app-conversation-session-id.ts";

/** Conversation discovery returns runtime/canonical IDs; the App owns their
 * existing binding to a visible session. Do not parse or guess ID prefixes. */
export function resolveBranchSessionId(db: Database, butlerData: string, id: string): string {
  const direct = appChatIdForConversationExternalSession(db, id);
  if (db.query("SELECT 1 FROM chats WHERE id=?").get(direct)) return direct;
  const conversations = new AgentConversationStore({ butlerData });
  try {
    const binding = conversations.getGatewayBindingForConversation(id, "app");
    return binding ? appChatIdForConversationExternalSession(db, binding.external_session_id) : id;
  } finally { conversations.close(); }
}

/** Resolve public App and canonical answer identities through the persisted turn
 * outcome, not text similarity or a fallback to a different latest answer. */
export function readBranchAnswer(db: Database, butlerData: string, sessionId: string, requestedId?: string): MessageRecord | null {
  const conversations = new AgentConversationStore({ butlerData });
  try {
    const canonicalSession = conversations.getSessionByGatewayBinding("app", sessionHintForRow(sessionId));
    let row = db.query<MessageRow, [string, string | null, string | null, string | null]>(`
      SELECT rowid,* FROM messages WHERE chat_id=? AND role='assistant'
      AND status IN ('delivered','completed','sent')
      AND (? IS NULL OR id=? OR conversation_message_id=?) ORDER BY rowid DESC LIMIT 1
    `).get(sessionId, requestedId ?? null, requestedId ?? null, requestedId ?? null);
    if (!row && requestedId && canonicalSession) {
      const anchor = conversations.readMessageById(requestedId);
      const outcome = anchor?.turn_id ? conversations.readTurnOutcome(anchor.turn_id) : null;
      if (!anchor || anchor.session_id !== canonicalSession.id || anchor.role !== "assistant" ||
        !outcome || outcome.public_assistant_message_id !== anchor.id || outcome.outcome !== "delivered") return null;
      const matches = db.query<MessageRow, [string, string]>(`
        SELECT rowid,* FROM messages WHERE chat_id=? AND turn_id=? AND role='assistant'
        AND status IN ('delivered','completed','sent') AND ${visibleMessageSqlPredicate()} LIMIT 2
      `).all(sessionId, outcome.turn_id);
      if (matches.length !== 1) return null;
      row = matches[0]!;
    }
    if (!row) return null;
    const message = messageFromRow(row);
    const outcome = row.turn_id ? conversations.readTurnOutcome(row.turn_id) : null;
    if (canonicalSession && outcome?.session_id === canonicalSession.id && outcome.public_assistant_message_id && outcome.outcome === "delivered") {
      message.conversation_session_id = canonicalSession.id;
      message.conversation_message_id = outcome.public_assistant_message_id;
      message.conversation_turn_id = outcome.turn_id;
    }
    return message;
  } finally { conversations.close(); }
}

/** Read only history at or before the chosen answer, including an existing valid summary. */
export function readBranchContext(db: Database, butlerData: string, message: MessageRecord): string {
  if (message.conversation_session_id && message.conversation_message_id) {
    const conversations = new AgentConversationStore({ butlerData });
    try {
      const anchor = conversations.readMessageById(message.conversation_message_id);
      if (anchor && anchor.session_id === message.conversation_session_id) {
        const summary = conversations.readSummaries(anchor.session_id)
          .filter(item => !item.invalidated_at && item.covers_to_seq <= anchor.seq)
          .sort((a, b) => b.covers_to_seq - a.covers_to_seq)[0];
        const history = conversations.readMessagesAround({ sessionId: anchor.session_id,
          anchorMessageId: anchor.id, direction: "before", limit: 100, includeCompacted: true })
          .filter(item => item.seq <= anchor.seq && (!summary || item.seq > summary.covers_to_seq) &&
            (item.visibility === "model" || item.visibility === "user") &&
            (item.role === "user" || item.role === "assistant"));
        if (!history.some(item => item.id === anchor.id)) history.push(anchor);
        return [summary ? `Existing summary through sequence ${summary.covers_to_seq}:\n${summary.summary_text}` : "",
          `History window ending at sequence ${anchor.seq}; earlier details may require source retrieval.`,
          ...history.map(item => `${item.role}: ${conversationMessageText(item)}`)].filter(Boolean).join("\n\n");
      }
    } finally { conversations.close(); }
  }
  const source = db.query<{ role: string; text: string }, [string, string]>(`
    SELECT role,text FROM messages WHERE chat_id=? AND rowid <= (SELECT rowid FROM messages WHERE id=?)
    AND role IN ('user','assistant') AND ${visibleMessageSqlPredicate()} ORDER BY rowid DESC LIMIT 100
  `).all(message.chat_id!, message.id).reverse();
  return ["Recent public conversation window ending at the selected answer; older details may be omitted.",
    ...source.map(item => `${item.role}: ${item.text}`)].join("\n\n");
}
