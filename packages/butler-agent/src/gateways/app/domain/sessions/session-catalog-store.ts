import { Database } from "bun:sqlite";
import type {
  ChatRow,
  ProjectRow,
  SessionSummaryRow,
} from "../../infrastructure/core/records.ts";
import {
  chatFromRow,
  paginationInput,
  projectFromRow,
  sessionFromRow,
} from "./session-read-model.ts";
import type {
  ArchiveListView,
  ChatKind,
  ChatSummary,
  ProjectSessionListView,
  ProjectSummary,
  SessionListView,
  SessionSummary,
} from "../../interface/protocol/app-protocol.ts";
import { visibleMessageSqlPredicate } from "../sessions/visible-message-sql.ts";

export class AppSessionCatalogStore {
  constructor(private readonly db: Database) {}

  listChats(): ChatSummary[] {
    const rows = this.db
      .query<ChatRow, []>(
        `
      SELECT id, title, kind, project_id, created_at, updated_at
      FROM chats
      WHERE archived = 0
      ORDER BY updated_at DESC, created_at DESC
    `,
      )
      .all();
    return rows.map(chatFromRow);
  }

  listSessions(
    options: { kind?: ChatKind; projectId?: string } = {},
  ): SessionListView {
    const clauses = ["c.archived = 0"];
    const params: string[] = [];
    if (options.kind) {
      clauses.push("c.kind = ?");
      params.push(options.kind);
    }
    if (options.projectId) {
      clauses.push("c.project_id = ?");
      params.push(options.projectId);
    }
    const rows = this.db
      .query<SessionSummaryRow, string[]>(
        `
      SELECT
        c.id,
        c.kind,
        c.title,
        c.project_id,
        c.created_at,
        c.updated_at,
        (
          SELECT m.text
          FROM messages m
          WHERE m.chat_id = c.id
            AND ${visibleMessageSqlPredicate("m")}
          ORDER BY m.rowid DESC
          LIMIT 1
        ) AS last_message_preview,
        (
          SELECT t.state
          FROM turns t
          WHERE t.chat_id = c.id
          ORDER BY t.rowid DESC
          LIMIT 1
        ) AS active_turn_state,
        (
          SELECT t.safe_status_label
          FROM turns t
          WHERE t.chat_id = c.id
          ORDER BY t.rowid DESC
          LIMIT 1
        ) AS safe_status_label,
        (
          SELECT t.safe_error_code
          FROM turns t
          WHERE t.chat_id = c.id
          ORDER BY t.rowid DESC
          LIMIT 1
        ) AS active_turn_safe_error_code,
        c.pinned,
        c.archived
      FROM chats c
      WHERE ${clauses.join(" AND ")}
      ORDER BY c.pinned DESC, c.updated_at DESC, c.created_at DESC
      LIMIT 200
    `,
      )
      .all(...params);
    return {
      sessions: rows.map(sessionFromRow),
    };
  }

  listProjectSessions(projectId?: string): ProjectSessionListView {
    return {
      project_id: projectId,
      sessions: this.listSessions({ kind: "project", projectId }).sessions,
    };
  }

  /**
   * Internal read for project lifecycle authority close: every chat id bound to
   * an existing project, including already archived chats, without pagination.
   * An absent project yields no close targets.
   */
  projectSessionIdsForLifecycle(projectId: string): string[] {
    return this.db
      .query<{ id: string }, [string]>(
        `
      SELECT c.id
      FROM chats c
      JOIN projects p ON p.id = c.project_id
      WHERE c.project_id = ?
      ORDER BY c.created_at ASC, c.rowid ASC
    `,
      )
      .all(projectId)
      .map((row) => row.id);
  }

  listArchives(options: { limit?: number; offset?: number } = {}): ArchiveListView {
    const page = paginationInput(options);
    const projectRows = this.db
      .query<ProjectRow, []>(
        `
      SELECT id, display_name, status, workspace_path, workspace_label, safe_path_label,
        pinned, archived, error_summary, created_at, updated_at
      FROM projects
      WHERE archived = 1
      ORDER BY updated_at DESC, created_at DESC
    `,
      )
      .all();
    const sessionRows = this.db
      .query<SessionSummaryRow, []>(
        `
      SELECT
        c.id,
        c.kind,
        c.title,
        c.project_id,
        p.display_name AS project_display_name,
        c.created_at,
        c.updated_at,
        (
          SELECT m.text
          FROM messages m
          WHERE m.chat_id = c.id
            AND ${visibleMessageSqlPredicate("m")}
          ORDER BY m.rowid DESC
          LIMIT 1
        ) AS last_message_preview,
        (
          SELECT t.state
          FROM turns t
          WHERE t.chat_id = c.id
          ORDER BY t.rowid DESC
          LIMIT 1
        ) AS active_turn_state,
        (
          SELECT t.safe_status_label
          FROM turns t
          WHERE t.chat_id = c.id
          ORDER BY t.rowid DESC
          LIMIT 1
        ) AS safe_status_label,
        (
          SELECT t.safe_error_code
          FROM turns t
          WHERE t.chat_id = c.id
          ORDER BY t.rowid DESC
          LIMIT 1
        ) AS active_turn_safe_error_code,
        c.pinned,
        c.archived
      FROM chats c
      LEFT JOIN projects p ON p.id = c.project_id
      WHERE c.archived = 1
      ORDER BY c.updated_at DESC, c.created_at DESC
    `,
      )
      .all();
    const items = [
      ...projectRows.map((row) => ({
        kind: "project" as const,
        sort: `${row.updated_at}:${row.created_at}`,
        item: projectFromRow(row),
      })),
      ...sessionRows.map((row) => ({
        kind: "session" as const,
        sort: `${row.updated_at}:${row.created_at}`,
        item: sessionFromRow(row),
      })),
    ].sort((left, right) => right.sort.localeCompare(left.sort));
    const visibleItems = items.slice(page.offset, page.offset + page.limit);
    return {
      projects: visibleItems
        .filter((entry) => entry.kind === "project")
        .map((entry) => entry.item as ProjectSummary),
      sessions: visibleItems
        .filter((entry) => entry.kind === "session")
        .map((entry) => entry.item as SessionSummary),
      pagination: {
        ...page,
        total: items.length,
        has_more: page.offset + page.limit < items.length,
      },
    };
  }
}
