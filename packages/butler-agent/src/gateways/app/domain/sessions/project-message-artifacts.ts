import type { Database } from "bun:sqlite";
import { AppStoreOperationError } from "../../infrastructure/core/app-store-errors.ts";
import { artifactSummaryFromRow, type SessionArtifactReadModelRow } from "./message-read-model.ts";
import { visibleMessageSqlPredicate } from "./visible-message-sql.ts";
import { sanitizePublicText } from "../../../../agent/events/public-text.ts";
import type { DashboardArtifactPage } from "../../interface/protocol/session-dashboard-contract.ts";

/** Published assistant attachments only; changed source files are not artifacts. */
export function projectMessageArtifacts(db: Database, projectId: string, query: { cursor?: string; limit: number }): DashboardArtifactPage {
  let before = Number.MAX_SAFE_INTEGER;
  let beforeFile = "";
  if (query.cursor) {
    try {
      const cursor = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"));
      if (cursor.projectId !== projectId || !Number.isSafeInteger(cursor.rowid) || cursor.rowid < 1 || typeof cursor.fileId !== "string") throw new Error();
      before = cursor.rowid; beforeFile = cursor.fileId;
    } catch { throw new AppStoreOperationError(400, "invalid_cursor", "Invalid cursor."); }
  }
  const rows = db.query<SessionArtifactReadModelRow & { session_title: string }, [string, number, number, string, number]>(`
    SELECT m.rowid AS message_rowid, m.id AS message_id, m.chat_id, m.turn_id,
      c.title AS session_title, f.id, f.owner_session_id, f.kind, f.mime_type,
      f.safe_name, f.size_bytes, f.sha256, f.storage_name, f.created_at
    FROM chats c JOIN messages m ON m.chat_id = c.id
    JOIN message_attachments a ON a.message_id = m.id JOIN message_files f ON f.id = a.file_id
    WHERE c.project_id = ? AND m.role = 'assistant' AND m.status = 'delivered'
      AND ${visibleMessageSqlPredicate("m")}
      AND (m.rowid < ? OR (m.rowid = ? AND f.id < ?))
    ORDER BY m.rowid DESC, f.id DESC LIMIT ?
  `).all(projectId, before, before, beforeFile, query.limit + 1);
  const selected = rows.slice(0, query.limit);
  const last = selected.at(-1);
  return {
    items: selected.map((row) => ({ ...artifactSummaryFromRow(row), project_id: projectId,
      revision: row.sha256, mime_type: row.mime_type,
      title: sanitizePublicText(row.safe_name, ""), safe_path_label: sanitizePublicText(row.safe_name, ""),
      session_title: sanitizePublicText(row.session_title, "") })),
    nextCursor: rows.length > query.limit && last ? Buffer.from(JSON.stringify({
      projectId, rowid: last.message_rowid, fileId: last.id,
    })).toString("base64url") : null,
  };
}

/** Exact published attachment lookup; a path or a user upload is not an artifact identity. */
export function projectMessageArtifact(db: Database, projectId: string, id: string): DashboardArtifactPage["items"][number] | null {
  if (!id.startsWith("artifact-file-")) return null;
  const row = db.query<SessionArtifactReadModelRow & { session_title: string }, [string, string]>(`
    SELECT m.rowid AS message_rowid,m.id AS message_id,m.chat_id,m.turn_id,c.title AS session_title,
      f.id,f.owner_session_id,f.kind,f.mime_type,f.safe_name,f.size_bytes,f.sha256,f.storage_name,f.created_at
    FROM chats c JOIN messages m ON m.chat_id=c.id
    JOIN message_attachments a ON a.message_id=m.id JOIN message_files f ON f.id=a.file_id
    WHERE c.project_id=? AND f.id=? AND m.role='assistant' AND m.status='delivered'
      AND ${visibleMessageSqlPredicate("m")}
    ORDER BY m.rowid DESC LIMIT 1
  `).get(projectId, id.slice("artifact-".length));
  return row ? { ...artifactSummaryFromRow(row), project_id: projectId,
    title: sanitizePublicText(row.safe_name, ""), safe_path_label: sanitizePublicText(row.safe_name, ""),
    session_title: sanitizePublicText(row.session_title, ""), revision: row.sha256, mime_type: row.mime_type } : null;
}
