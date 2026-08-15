import type { Database } from "bun:sqlite";
import type { MessageFileKind } from "../../interface/protocol/app-protocol.ts";
import { MESSAGE_FILE_ID_PATTERN } from "./message-file-storage.ts";

export interface MessageFileRow {
  id: string;
  owner_session_id: string | null;
  message_id: string | null;
  kind: MessageFileKind;
  mime_type: string;
  safe_name: string;
  size_bytes: number;
  sha256: string;
  storage_name: string;
  created_at: string;
}

const MESSAGE_FILE_COLUMNS = `
  id, owner_session_id, message_id, kind, mime_type, safe_name,
  size_bytes, sha256, storage_name, created_at
`;

const MESSAGE_ATTACHMENT_FILE_COLUMNS = `
  f.id, f.owner_session_id, f.message_id, f.kind, f.mime_type, f.safe_name,
  f.size_bytes, f.sha256, f.storage_name, f.created_at
`;

export function getMessageFileRow(
  db: Database,
  fileId: string,
): MessageFileRow | null {
  if (!MESSAGE_FILE_ID_PATTERN.test(fileId)) return null;
  return (
    db
      .query<MessageFileRow, [string]>(
        `
      SELECT ${MESSAGE_FILE_COLUMNS}
      FROM message_files
      WHERE id = ?
    `,
      )
      .get(fileId) ?? null
  );
}

export function listQueuedMessageFileRows(
  db: Database,
  row: { attachments_json: string },
): MessageFileRow[] {
  return attachmentIdsFromJson(row.attachments_json)
    .map((fileId) => getMessageFileRow(db, fileId))
    .filter((file): file is MessageFileRow => Boolean(file));
}

export function listMessageAttachmentRows(
  db: Database,
  messageId: string,
): MessageFileRow[] {
  return db
    .query<MessageFileRow, [string]>(
      `
      SELECT ${MESSAGE_ATTACHMENT_FILE_COLUMNS}
      FROM message_attachments a
      JOIN message_files f ON f.id = a.file_id
      WHERE a.message_id = ?
      ORDER BY a.position ASC
    `,
    )
    .all(messageId);
}

/**
 * Read attachment rows for a bounded message page in one query.
 *
 * Session views commonly materialize up to 200 messages. Issuing one
 * prepared statement per message makes a read-only page unnecessarily retain
 * thousands of SQLite statement/result objects in Bun's native heap while a
 * polling client refreshes the view. Keep the query bounded by the caller's
 * page and preserve attachment order within each message.
 */
export function listMessageAttachmentRowsForMessages(
  db: Database,
  messageIds: readonly string[],
): Map<string, MessageFileRow[]> {
  const ids = [...new Set(messageIds.filter((id) => id.length > 0))];
  const result = new Map<string, MessageFileRow[]>();
  if (ids.length === 0) return result;
  const placeholders = ids.map(() => "?").join(", ");
  const rows = db
    .query<MessageFileRow, string[]>(
      `
      SELECT ${MESSAGE_ATTACHMENT_FILE_COLUMNS}
      FROM message_attachments a
      JOIN message_files f ON f.id = a.file_id
      WHERE a.message_id IN (${placeholders})
      ORDER BY a.message_id ASC, a.position ASC
    `,
    )
    .all(...ids);
  for (const row of rows) {
    const existing = result.get(row.message_id!) ?? [];
    existing.push(row);
    result.set(row.message_id!, existing);
  }
  return result;
}

export function listSessionMessageFileRows(
  db: Database,
  sessionId: string,
): MessageFileRow[] {
  return db
    .query<MessageFileRow, [string]>(
      `
      SELECT ${MESSAGE_FILE_COLUMNS}
      FROM message_files
      WHERE owner_session_id = ?
      ORDER BY created_at ASC
    `,
    )
    .all(sessionId);
}

export function countSessionMessageFileRows(
  db: Database,
  sessionId: string,
): number {
  return Number(
    db
      .query<{ count: number }, [string]>(
        `
      SELECT COUNT(*) AS count
      FROM message_files
      WHERE owner_session_id = ?
    `,
      )
      .get(sessionId)?.count ?? 0,
  );
}

export function artifactRevisionForSession(
  db: Database,
  sessionId: string,
): string {
  const row = db
    .query<{
      count: number;
      latest_message_cursor: number | null;
      latest_file_created_at: string | null;
    }, [string]>(
      `
      SELECT
        COUNT(*) AS count,
        MAX(m.rowid) AS latest_message_cursor,
        MAX(f.created_at) AS latest_file_created_at
      FROM messages AS m
      JOIN message_attachments AS a ON a.message_id = m.id
      JOIN message_files AS f ON f.id = a.file_id
      WHERE m.chat_id = ?
        AND m.role = 'assistant'
    `,
    )
    .get(sessionId);
  return [
    row?.count ?? 0,
    row?.latest_message_cursor ?? 0,
    row?.latest_file_created_at ?? "",
  ].join(":");
}

function attachmentIdsFromJson(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && "file_id" in item &&
            typeof item.file_id === "string") return item.file_id;
        return "";
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}
