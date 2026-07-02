import type { Database } from "bun:sqlite";
import { sessionHintForRow } from "../sessions/session-read-model.ts";

export function appChatIdForConversationExternalSession(
  db: Database,
  externalSessionId: string,
): string {
  const rows = db.query<{ id: string }, []>(`
    SELECT id
    FROM chats
    ORDER BY rowid ASC
  `).all();
  const hinted = rows.find((row) => sessionHintForRow(row.id) === externalSessionId);
  if (hinted) return hinted.id;
  const direct = rows.find((row) => row.id === externalSessionId);
  return direct?.id ?? externalSessionId;
}
