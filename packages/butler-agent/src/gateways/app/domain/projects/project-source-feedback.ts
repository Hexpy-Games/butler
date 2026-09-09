import type { Database } from "bun:sqlite";
import { isMessageContent } from "../../../../foundation/message-content.ts";
import { sanitizePublicText } from "../../../../agent/events/public-text.ts";

/** Read user observations attached to exact sources, not assistant completion claims.
 * The persisted user message is the authority for what the user reported, never for Work status.
 */
export function readProjectSourceFeedback(db: Database, projectId: string, sourceId: string) {
  const rows = db.query<{
    id: string; text: string; chars: number; content_parts_json: string; created_at: string;
  }, [string, string, string]>(`
    SELECT m.id, substr(m.text, 1, 1200) AS text, length(m.text) AS chars,
      m.content_parts_json, m.created_at
    FROM chats c JOIN messages m ON m.chat_id = c.id
    WHERE c.project_id = ? AND m.role = 'user' AND m.status = 'sent'
      AND EXISTS (
        SELECT 1 FROM json_each(CASE WHEN json_valid(m.content_parts_json)
          THEN m.content_parts_json ELSE '{"parts":[]}' END, '$.parts') ref
        WHERE ref.type = 'object'
          AND json_extract(ref.value, '$.type') = 'project_source_ref'
          AND json_extract(ref.value, '$.projectId') = ?
          AND json_extract(ref.value, '$.source.kind') || ':' || json_extract(ref.value, '$.source.id') = ?
      )
    ORDER BY m.created_at DESC, m.id DESC LIMIT 3
  `).all(projectId, projectId, sourceId);
  return rows.flatMap(row => {
    const content: unknown = JSON.parse(row.content_parts_json);
    if (!isMessageContent(content)) return [];
    const references = content.parts.flatMap(part => part.type === "project_source_ref" &&
      part.projectId === projectId && `${part.source.kind}:${part.source.id}` === sourceId
      ? [{ revision: part.source.revision, ...(part.topic ? { topic: sanitizePublicText(part.topic, "") } : {}) }] : []);
    // Mention labels are session/document titles, not the user's observation about the selected feature.
    const textParts = content.parts.filter(part => part.type === "text");
    const observation = textParts.length ? textParts.map(part => part.text).join("") : row.text;
    return [{ messageId: row.id, reportedAt: row.created_at,
      observation: sanitizePublicText(observation.slice(0, 1200), ""),
      excerptTruncated: textParts.length ? observation.length > 1200 : row.chars > 1200, references }];
  }).reverse();
}
