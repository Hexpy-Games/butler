import { Database } from "bun:sqlite";
import { loadProjectDocumentCatalog } from "./project-document-catalog.ts";
import { AppStoreOperationError } from "../../infrastructure/core/app-store-errors.ts";
import type { ProjectRow } from "../../infrastructure/core/records.ts";
import { projectFromRow } from "../sessions/session-read-model.ts";
import { startOfUtcDay } from "../settings/personalization-file-storage.ts";
import type { ProjectDashboardView, SessionSummary } from "../../interface/protocol/app-protocol.ts";

export class AppProjectDashboardStore {
  constructor(
    private readonly db: Database,
    private readonly butlerData: string,
    private readonly getProjectRow: (projectId: string) => ProjectRow | null,
    private readonly projectSessions: (projectId: string) => SessionSummary[],
  ) {}

  getProjectDashboard(projectId: string): ProjectDashboardView {
    const row = this.getProjectRow(projectId);
    if (!row) {
      throw new AppStoreOperationError(
        404,
        "project_not_found",
        "Project not found.",
      );
    }
    const sessions = this.projectSessions(projectId);
    const project = projectFromRow(row, sessions);
    const now = new Date();
    const dayStart = startOfUtcDay(now);
    const days = Array.from({ length: 30 }, (_, offset) => {
      const date = new Date(dayStart.getTime() - (29 - offset) * 86_400_000);
      return {
        date: date.toISOString().slice(0, 10),
        count: 0,
      };
    });
    const firstDay = `${days[0]!.date}T00:00:00.000Z`;
    const activityRows = this.db
      .query<{ day: string; count: number }, [string, string]>(
        `
      SELECT substr(m.created_at, 1, 10) AS day, COUNT(*) AS count
      FROM messages m
      JOIN chats c ON c.id = m.chat_id
      WHERE c.project_id = ? AND m.created_at >= ?
      GROUP BY day
      ORDER BY day ASC
    `,
      )
      .all(projectId, firstDay);
    const countByDay = new Map(
      activityRows.map((item) => [item.day, item.count]),
    );
    const activityDays = days.map((day) => ({
      ...day,
      count: countByDay.get(day.date) ?? 0,
    }));
    const recent7Start = new Date(
      dayStart.getTime() - 6 * 86_400_000,
    ).toISOString();
    const recentMessages7d = this.projectMessageCountSince(
      projectId,
      recent7Start,
    );
    const recentMessages30d = this.projectMessageCountSince(
      projectId,
      firstDay,
    );
    const projectDocumentCatalog = loadProjectDocumentCatalog({
      butlerDataRoot: this.butlerData,
      project: row,
    });
    return {
      project,
      stats: {
        active_sessions: sessions.filter((session) => !session.archived).length,
        archived_sessions: sessions.filter((session) => session.archived)
          .length,
        recent_messages_7d: recentMessages7d,
        recent_messages_30d: recentMessages30d,
        specs: projectDocumentCatalog.stats.specs,
        plans: projectDocumentCatalog.stats.plans,
      },
      activity: {
        days: activityDays,
      },
      documents: projectDocumentCatalog.documents,
      generated_at: new Date().toISOString(),
    };
  }

  private projectMessageCountSince(projectId: string, sinceIso: string): number {
    const row = this.db
      .query<{ count: number }, [string, string]>(
        `
      SELECT COUNT(*) AS count
      FROM messages m
      JOIN chats c ON c.id = m.chat_id
      WHERE c.project_id = ? AND m.created_at >= ?
    `,
      )
      .get(projectId, sinceIso);
    return Math.max(0, Number(row?.count ?? 0));
  }
}
