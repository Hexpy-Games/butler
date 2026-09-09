import type { Database } from "bun:sqlite";
import type { DashboardHistoryPage } from "../../interface/protocol/session-dashboard-contract.ts";
import { visibleMessageSqlPredicate } from "../sessions/visible-message-sql.ts";
import { projectReportLocatorRevision } from "./project-report-source.ts";
import { sanitizePublicText } from "../../../../agent/events/public-text.ts";
import { AppStoreOperationError } from "../../infrastructure/core/app-store-errors.ts";

type Event = Extract<DashboardHistoryPage, { status: "ready" }>["events"][number];
type Cursor = { projectId: string; revision: string; rowid: number; at: string; id: string };
export type ProjectHistoryQuery = { cursor?: string; limit: number; workRange?: { from: string; to: string } };

/** Merge authoritative metadata and delivered public messages, never tool payloads.
 * A cursor freezes the message insertion watermark and rejects a changed Ledger.
 * Both inputs use the same (timestamp,id) ordering; unconsumed rows are not lost.
 */
export function projectPublicHistory(db: Database, projectId: string, revision: string,
  ledgerEvents: Event[], query: ProjectHistoryQuery, ledgerUnavailable: boolean): DashboardHistoryPage {
  // The timeline is paginated after selecting Work events, not after unrelated reports.
  if (query.workRange) revision += `:work:${query.workRange.from}:${query.workRange.to}`;
  let cursor: Cursor | undefined;
  if (query.cursor) {
    try {
      cursor = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"));
      if (!cursor || cursor.projectId !== projectId || !Number.isSafeInteger(cursor.rowid) || cursor.rowid < 0 ||
          typeof cursor.revision !== "string" || typeof cursor.id !== "string" ||
          typeof cursor.at !== "string" || !Number.isFinite(Date.parse(cursor.at))) throw new Error();
    } catch { throw new AppStoreOperationError(400, "invalid_cursor", "Invalid cursor."); }
    if (cursor.revision !== revision) throw new AppStoreOperationError(409, "source_changed", "Reload the history.");
  }
  const watermark = cursor?.rowid ?? db.query<{ id: number }, []>("SELECT coalesce(max(rowid),0) AS id FROM messages").get()!.id;
  const before = cursor?.at ?? "9999-12-31T23:59:59.999Z";
  const beforeId = cursor?.id ?? "\uffff";
  const rows = query.workRange ? [] : db.query<{ id: string; chat_id: string; title: string; at: string; updated_at: string; excerpt: string; chars: number; artifacts: number }, [string, number, string, string, string, number]>(`
    SELECT m.id,m.chat_id,c.title,m.created_at AS at,m.updated_at,
      substr(m.text,1,1200) AS excerpt,length(m.text) AS chars,
      (SELECT count(*) FROM message_attachments a WHERE a.message_id=m.id) AS artifacts
    FROM chats c JOIN messages m ON m.chat_id=c.id
    WHERE c.project_id=? AND m.rowid<=? AND m.role='assistant' AND m.status='delivered'
      AND ${visibleMessageSqlPredicate("m")}
      AND (m.created_at<? OR (m.created_at=? AND ('message:'||m.id)<?))
    ORDER BY m.created_at DESC,m.id DESC LIMIT ?
  `).all(projectId, watermark, before, before, beforeId, query.limit + 1);
  const messages: Event[] = rows.map((row) => ({ id: `message:${row.id}`, at: row.at, action: "reported",
    title: sanitizePublicText(row.title, ""), session: { id: row.chat_id, title: sanitizePublicText(row.title, "") },
    artifactCount: row.artifacts, source: { kind: "message", id: row.id, revision: projectReportLocatorRevision(row) } }));
  const ledger = ledgerEvents.filter((event) => (!query.workRange ||
    (event.at >= query.workRange.from && event.at < query.workRange.to &&
      (event.source.kind === "work" || (event.workId && event.action !== "result")))))
    .filter((event) => event.at < before || (event.at === before && event.id < beforeId)).slice(0, query.limit + 1);
  const combined = [...messages, ...ledger].sort(compareHistory);
  const selected = combined.slice(0, query.limit);
  const last = selected.at(-1);
  return { status: "ready", ledgerUnavailable, events: selected,
    nextCursor: combined.length > query.limit && last ? Buffer.from(JSON.stringify({ projectId, revision,
      rowid: watermark, at: last.at, id: last.id } satisfies Cursor)).toString("base64url") : null };
}

export function compareHistory(a: { at: string; id: string }, b: { at: string; id: string }): number {
  return a.at === b.at ? a.id === b.id ? 0 : a.id < b.id ? 1 : -1 : a.at < b.at ? 1 : -1;
}
