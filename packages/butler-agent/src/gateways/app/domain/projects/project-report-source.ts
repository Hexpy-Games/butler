import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { visibleMessageSqlPredicate } from "../sessions/visible-message-sql.ts";
import { AppStoreOperationError } from "../../infrastructure/core/app-store-errors.ts";

export function projectReportLocatorRevision(row: { id: string; chat_id: string; updated_at: string; excerpt: string; chars: number }) {
  return createHash("sha256").update(JSON.stringify([row.id, row.chat_id, row.updated_at, row.chars, row.excerpt])).digest("hex");
}

export function readProjectReportSource(db: Database, projectId: string, messageId: string, expected: string) {
  const row = db.query<{ id: string; chat_id: string; title: string; body: string; updated_at: string; chars: number; excerpt: string }, [string, string]>(`
    SELECT m.id, m.chat_id, c.title, m.text AS body, m.updated_at, length(m.text) AS chars, substr(m.text,1,1200) AS excerpt
    FROM chats c JOIN messages m ON m.chat_id = c.id WHERE c.project_id = ? AND m.id = ?
      AND m.role = 'assistant' AND m.status = 'delivered' AND ${visibleMessageSqlPredicate("m")}
  `).get(projectId, messageId);
  if (!row) throw new AppStoreOperationError(404, "source_unavailable", "Source unavailable.");
  const revision = createHash("sha256").update(row.body).digest("hex");
  if (expected !== projectReportLocatorRevision(row) && expected !== revision) throw new AppStoreOperationError(409, "source_changed", "Source changed. Reload it.");
  return { title: row.title, body: row.body, revision, updatedAt: row.updated_at, status: "delivered" };
}
