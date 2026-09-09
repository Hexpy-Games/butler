import { Database } from "bun:sqlite";
import { AppStoreOperationError } from "../../infrastructure/core/app-store-errors.ts";
import type { ProjectRow } from "../../infrastructure/core/records.ts";
import { projectFromRow } from "../sessions/session-read-model.ts";
import { startOfUtcDay } from "../settings/personalization-file-storage.ts";
import type { ProjectDashboardView, SessionSummary } from "../../interface/protocol/app-protocol.ts";
import { createProjectDashboardLedgerReader } from "../../../../agent/adapters/btcc/project-ledger/index.ts";
import type { DashboardLedgerRecord } from "../../../../agent/adapters/btcc/project-ledger/index.ts";
import { projectDashboardFacts } from "./project-dashboard-facts.ts";
import { projectDashboardBoard, interleaveDashboardLanes } from "./project-dashboard-board.ts";
import type { DashboardBoardCard, DashboardBoardPage } from "../../interface/protocol/session-dashboard-contract.ts";
import { projectWorkSessionResolver } from "./project-dashboard-session-links.ts";
import { ProjectDashboardSources } from "./project-dashboard-sources.ts";
import { ProjectBriefingStore } from "./project-briefing-store.ts";
import { buildProjectBriefingPack } from "./project-briefing-facts.ts";
import { resolveRuntimeMessageLanguage } from "../../../../agent/output/messages.ts";
import { resolveRuntimeModelMetadata } from "../../../../integrations/providers/model-catalog.ts";
import type { SettingsView } from "../../interface/protocol/app-protocol.ts";
import { readProjectActivityStatistics } from "./project-statistics.ts";
import type { DashboardStatisticsView } from "../../interface/protocol/session-dashboard-contract.ts";
import { sanitizePublicText } from "../../../../agent/events/public-text.ts";

export class AppProjectDashboardStore {
  private readonly readLedger: ReturnType<typeof createProjectDashboardLedgerReader>;
  readonly sources: ProjectDashboardSources;
  readonly briefing: ProjectBriefingStore;
  constructor(
    private readonly db: Database,
    private readonly butlerData: string,
    private readonly getProjectRow: (projectId: string) => ProjectRow | null,
    private readonly projectSessions: (projectId: string) => SessionSummary[],
    getSettings: () => SettingsView,
    publish: (projectId: string) => void,
  ) {
    this.readLedger = createProjectDashboardLedgerReader(butlerData);
    this.sources = new ProjectDashboardSources({ db, butlerData, getProjectRow, projectSessions, readLedger: this.readLedger });
    this.briefing = new ProjectBriefingStore({ db, butlerData, publish, readPack: async (projectId) => {
      const row = getProjectRow(projectId);
      if (!row) throw new AppStoreOperationError(404, "project_not_found", "Project not found.");
      const settings = getSettings();
      const model = settings.effective_consolidation_model;
      const reasoningEffort = settings.consolidation_reasoning_effort;
      let snapshot = null;
      if (row.ledger_project_id) {
        try { snapshot = await this.readLedger(projectId, row.ledger_project_id); } catch { /* Explicit unavailable facts, no guessed binding. */ }
      }
      return { reasoningEffort, pack: buildProjectBriefingPack({ db, projectId, binding: row.ledger_project_id ?? null,
        description: row.description ?? null, snapshot, model, reasoningEffort,
        language: resolveRuntimeMessageLanguage({ butlerData }),
        contextTokens: resolveRuntimeModelMetadata(model).context_window_tokens ?? settings.context_window_tokens,
      }) };
    } });
  }

  async getProjectDashboard(projectId: string): Promise<ProjectDashboardView> {
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
    let overview: ProjectDashboardView["overview"] = { status: "unavailable", reason: "unbound" };
    let records: DashboardLedgerRecord[] = [];
    if (row.ledger_project_id) {
      try {
        const snapshot = await this.readLedger(projectId, row.ledger_project_id);
        overview = projectDashboardFacts(snapshot, projectWorkSessionResolver(this.db, projectId, sessions)); records = snapshot.records;
      }
      catch { overview = { status: "unavailable", reason: "source_unavailable" }; }
    }
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
    return {
      project,
      description: row.description ?? null,
      preferences: { revision: row.dashboard_preferences_revision ?? 0,
        pinnedSourceRefs: row.dashboard_preferences_json ? JSON.parse(row.dashboard_preferences_json).pinnedSourceRefs ?? [] : [] },
      overview,
      briefing: await this.briefing.read(projectId),
      stats: {
        active_sessions: sessions.filter((session) => !session.archived).length,
        archived_sessions: sessions.filter((session) => session.archived)
          .length,
        recent_messages_7d: recentMessages7d,
        recent_messages_30d: recentMessages30d,
        specs: records.filter((record) => record.kind === "spec").length,
        plans: records.filter((record) => record.kind === "plan").length,
      },
      activity: {
        days: activityDays,
      },
      documents: [], // Documents are fetched lazily from /dashboard/materials and /dashboard/source.
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

  async getStatistics(projectId: string, period: 7 | 30 | 90, timezone: string): Promise<DashboardStatisticsView> {
    if (!this.getProjectRow(projectId)) throw new AppStoreOperationError(404, "project_not_found", "Project not found.");
    const activity = readProjectActivityStatistics(this.db, projectId, period, timezone);
    const history = await this.sources.history(projectId, { limit: 100,
      workRange: { from: activity.days[0]!.start, to: activity.observedAt } });
    const timeline: DashboardStatisticsView["timeline"] = history.status !== "ready" || history.ledgerUnavailable ? { status: "unavailable" } : {
      status: "ready", truncated: Boolean(history.nextCursor), events: history.events
        .map((event) => ({ id: event.id, at: event.at, action: event.action, title: event.title, kind: event.source.kind, workId: event.workId ?? event.source.id })),
    };
    return { ...activity, timeline };
  }

  async getBoard(projectId: string, input: {
    kind: DashboardBoardCard["kind"]; parent?: string; cursor?: string; limit: number;
  }): Promise<DashboardBoardPage> {
    const row = this.getProjectRow(projectId);
    if (!row) throw new AppStoreOperationError(404, "project_not_found", "Project not found.");
    if (!row.ledger_project_id) return { status: "unavailable", reason: "unbound" };
    let snapshot;
    try { snapshot = await this.readLedger(projectId, row.ledger_project_id); }
    catch { return { status: "unavailable", reason: "source_unavailable" }; }
    const records = interleaveDashboardLanes(projectDashboardBoard(snapshot, input.kind, projectWorkSessionResolver(this.db, projectId, this.projectSessions(projectId)))
      .filter((record) => !input.parent || record.parentId === input.parent)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)));
    let offset = 0;
    if (input.cursor) {
      let cursor: { revision: string; id: string; kind: string; parent: string | null };
      try { cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")); }
      catch { throw new AppStoreOperationError(400, "invalid_cursor", "Invalid cursor."); }
      if (cursor.revision !== snapshot.revision) throw new AppStoreOperationError(409, "source_changed", "Reload the board.");
      if (cursor.kind !== input.kind || cursor.parent !== (input.parent ?? null)) throw new AppStoreOperationError(400, "invalid_cursor", "Invalid cursor.");
      const index = records.findIndex((record) => record.id === cursor.id);
      if (index < 0) throw new AppStoreOperationError(400, "invalid_cursor", "Invalid cursor.");
      offset = index + 1;
    }
    const items = records.slice(offset, offset + input.limit);
    const last = items.at(-1);
    const laneCounts = { planned: 0, active: 0, review: 0, blocked: 0, done: 0, other: 0 };
    for (const record of records) laneCounts[record.lane]++;
    return { status: "ready", sourceRevision: snapshot.revision, items, total: records.length,
      laneCounts,
      parents: snapshot.works.map((work) => ({ id: work.record.id, title: sanitizePublicText(work.managed?.objective ?? work.record.title, "") })),
      nextCursor: last && offset + items.length < records.length
        ? Buffer.from(JSON.stringify({ revision: snapshot.revision, id: last.id, kind: input.kind, parent: input.parent ?? null })).toString("base64url") : null };
  }
}
