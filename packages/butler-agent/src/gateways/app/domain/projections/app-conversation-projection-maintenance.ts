import type { Database } from "bun:sqlite";

export interface ProjectionAttachmentLink {
  conversation_message_id: string;
  file_id: string;
  position: number;
}

export function readProjectionAttachmentLinks(
  db: Database,
  conversationSessionId: string,
): ProjectionAttachmentLink[] {
  return db.query<ProjectionAttachmentLink, [string]>(`
    SELECT m.conversation_message_id, ma.file_id, ma.position
    FROM messages m
    JOIN message_attachments ma ON ma.message_id = m.id
    WHERE m.conversation_session_id = ?
      AND m.conversation_message_id IS NOT NULL
    ORDER BY m.rowid ASC, ma.position ASC
  `).all(conversationSessionId);
}

export function restoreProjectionAttachmentLinks(
  db: Database,
  links: ProjectionAttachmentLink[],
): void {
  for (const link of links) {
    const row = db.query<{ id: string }, [string]>(`
      SELECT id
      FROM messages
      WHERE conversation_message_id = ?
      LIMIT 1
    `).get(link.conversation_message_id);
    if (!row) continue;
    db.query(`
      INSERT OR REPLACE INTO message_attachments (message_id, file_id, position)
      VALUES (?, ?, ?)
    `).run(row.id, link.file_id, link.position);
    db.query(`
      UPDATE message_files
      SET message_id = ?
      WHERE id = ?
    `).run(row.id, link.file_id);
  }
}

export function deleteStaleSemanticProjectionRows(
  db: Database,
  conversationSessionId: string,
  projectedConversationMessageIds: Set<string>,
): void {
  const rows = db.query<{
    id: string;
    conversation_message_id: string;
  }, [string]>(`
    SELECT id, conversation_message_id
    FROM messages
    WHERE conversation_session_id = ?
      AND conversation_message_id IS NOT NULL
  `).all(conversationSessionId);
  for (const row of rows) {
    if (projectedConversationMessageIds.has(row.conversation_message_id)) continue;
    db.query("DELETE FROM messages WHERE id = ?").run(row.id);
  }
}
