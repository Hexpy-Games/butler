import type { Database } from "bun:sqlite";
import type { SessionSummary } from "../../interface/protocol/app-protocol.ts";
import { conversationSessionIdForDurableSession } from "../../../../agent/conversation/index.ts";

export function projectWorkSessionResolver(db: Database, projectId: string, sessions: SessionSummary[]) {
  const summaries = new Map(sessions.map((session) => [session.id, session]));
  const links = new Map<string, string[]>();
  for (const link of db.query<{ id: string; conversation_session_id: string | null }, [string]>(
    "SELECT id, conversation_session_id FROM chats WHERE project_id = ?",
  ).all(projectId)) if (link.conversation_session_id) {
    links.set(link.conversation_session_id, [...links.get(link.conversation_session_id) ?? [], link.id]);
  }
  return (workSessionId: string) => {
    const ids = links.get(conversationSessionIdForDurableSession(workSessionId));
    return ids?.length === 1 ? summaries.get(ids[0]!) ?? null : null;
  };
}

export function dashboardSessionRunning(session: SessionSummary | null): boolean {
  return Boolean(session && ["accepted", "thinking", "streaming", "waiting_for_tool", "retrying"].includes(session.active_turn_state ?? ""));
}
