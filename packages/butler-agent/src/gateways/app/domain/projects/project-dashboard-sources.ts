import { createProjectDashboardLedgerReader, readProjectDashboardSource, createProjectDashboardHistoryReader, createProjectDashboardWorkHistoryReader } from "../../../../agent/adapters/btcc/project-ledger/index.ts";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { sanitizePublicText } from "../../../../agent/events/public-text.ts";
import type { ProjectRow } from "../../infrastructure/core/records.ts";
import { AppStoreOperationError } from "../../infrastructure/core/app-store-errors.ts";
import type { DashboardMaterialsPage, ProjectDashboardDocument, DashboardHistoryPage } from "../../interface/protocol/session-dashboard-contract.ts";
import type { Database } from "bun:sqlite";
import { readProjectReportSource } from "./project-report-source.ts";
import { compareHistory, projectPublicHistory, type ProjectHistoryQuery } from "./project-public-history.ts";
import { conversationSessionIdForDurableSession } from "../../../../agent/conversation/index.ts";
import { projectMessageArtifact } from "../sessions/project-message-artifacts.ts";
import { projectDashboardFacts } from "./project-dashboard-facts.ts";
import { projectWorkSessionResolver } from "./project-dashboard-session-links.ts";
import type { SessionSummary } from "../../interface/protocol/app-protocol.ts";

export class ProjectDashboardSources {
  private readonly readHistory = createProjectDashboardHistoryReader();
  private readonly readWorkHistory: ReturnType<typeof createProjectDashboardWorkHistoryReader>;
  constructor(private readonly input: {
    butlerData: string; getProjectRow(id: string): ProjectRow | null;
    readLedger: ReturnType<typeof createProjectDashboardLedgerReader>;
    db: Database;
    projectSessions?: (id: string) => SessionSummary[];
  }) { this.readWorkHistory = createProjectDashboardWorkHistoryReader(input.butlerData); }

  async list(projectId: string, query: { all?: boolean; important?: boolean; cursor?: string; limit: number }): Promise<DashboardMaterialsPage> {
    const row = this.requireProject(projectId);
    if (!row.ledger_project_id) return { status: "unavailable", reason: "unbound" };
    let snapshot;
    try { snapshot = await this.input.readLedger(projectId, row.ledger_project_id); }
    catch { return { status: "unavailable", reason: "source_unavailable" }; }
    const preferences = row.dashboard_preferences_json ? JSON.parse(row.dashboard_preferences_json) : {};
    const pins = (preferences.pinnedSourceRefs ?? []) as Array<{ kind: string; id: string; revision: string }>;
    const kinds = query.all ? ["spec", "plan", "report", "work", "task", "artifact"] : ["spec", "plan", "report", "artifact", ...pins.map((pin) => pin.kind)];
    const artifacts = new Map(pins.filter((pin) => pin.kind === "artifact").flatMap((pin) => {
      const artifact = projectMessageArtifact(this.input.db, projectId, pin.id);
      return artifact && artifact.revision === pin.revision ? [[pin.id, artifact] as const] : [];
    }));
    const pinOrder = new Map(pins.map((ref, index) => [`${ref.kind}:${ref.id}`, index]));
    const missing = pins.filter((pin) => kinds.includes(pin.kind) && !artifacts.has(pin.id) && !snapshot.records.some((record) => record.kind === pin.kind && record.id === pin.id));
    const managedPlans = new Map(snapshot.works.filter((work) => work.managed)
      .map((work) => [work.record.id, work.managed!.currentPlan?.planRevisionId]));
    const publicTitles = new Map(snapshot.works.flatMap((work) => work.managed ? [
      [`work:${work.record.id}`, work.managed.objective],
      ...(work.managed.currentPlan ? [[`plan:${work.managed.currentPlan.planRevisionId}`, work.managed.currentPlan.objective]] : []),
    ] as [string, string][] : []));
    const sessionForWork = this.input.projectSessions ? projectWorkSessionResolver(this.input.db, projectId, this.input.projectSessions(projectId)) : undefined;
    const relevantWorks = new Set(projectDashboardFacts(snapshot, sessionForWork).remaining.map((work) => work.id));
    const relatedIds = new Set(snapshot.works.filter((work) => relevantWorks.has(work.record.id)).flatMap((work) =>
      [work.record.spec && snapshot.records.some((record) => record.kind === "spec" && record.id === work.record.spec && ["active", "approved"].includes(record.status))
        ? `spec:${work.record.spec}` : null, work.managed?.currentPlan ? `plan:${work.managed.currentPlan.planRevisionId}` : null]
        .filter((id): id is string => Boolean(id))));
    const latestReportByWork = new Map<string, string>();
    for (const record of [...snapshot.records].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))) {
      if (record.kind === "report" && record.parentId && relevantWorks.has(record.parentId) && !latestReportByWork.has(record.parentId)) {
        latestReportByWork.set(record.parentId, record.id); relatedIds.add(`report:${record.id}`);
      }
      if (["spec", "plan"].includes(record.kind) && record.parentId && relevantWorks.has(record.parentId) &&
          ["active", "approved", "in_progress"].includes(record.status)) relatedIds.add(`${record.kind}:${record.id}`);
    }
    const records = [...snapshot.records.filter((record) => kinds.includes(record.kind) &&
      (!query.important || pinOrder.has(`${record.kind}:${record.id}`) || relatedIds.has(`${record.kind}:${record.id}`)) &&
      !(record.kind === "plan" && !pinOrder.has(`plan:${record.id}`) && managedPlans.has(record.parentId ?? "") && managedPlans.get(record.parentId!) !== record.id))
      , ...[...artifacts.values()].map((artifact) => ({ id: artifact.id, kind: "artifact", title: artifact.title,
        path: artifact.safe_path_label ?? artifact.title, updatedAt: artifact.created_at, status: "published" })),
      ...missing.map((pin) => ({ ...pin, title: "", path: "", updatedAt: "", status: "unavailable" }))]
      .sort((a, b) => (pinOrder.get(`${a.kind}:${a.id}`) ?? Infinity) - (pinOrder.get(`${b.kind}:${b.id}`) ?? Infinity) ||
        (query.important ? Number(a.kind === "report") - Number(b.kind === "report") : 0) ||
        b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    const artifactRevision = createHash("sha256").update(JSON.stringify([...artifacts.values()])).digest("hex");
    const pageRevision = `${snapshot.revision}:${row.dashboard_preferences_revision ?? 0}:${Boolean(query.all)}:${Boolean(query.important)}:${artifactRevision}`;
    let offset = 0;
    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
      if (cursor.revision !== pageRevision) changed();
      offset = cursor.offset;
    }
    const selected = records.slice(offset, offset + query.limit);
    return { status: "ready", total: records.length,
      nextCursor: offset + selected.length < records.length ? encodeCursor(pageRevision, offset + selected.length) : null,
      documents: selected.map((record) => ({ id: record.id, project_id: projectId, revision: snapshot.revision,
        ...(artifacts.has(record.id) ? { artifact: artifacts.get(record.id), revision: artifacts.get(record.id)!.revision } : {}),
        kind: record.kind === "spec" ? "spec" : record.kind === "report" ? "report" : "plan",
        document_type: record.kind as ProjectDashboardDocument["document_type"],
        title: sanitizePublicText(publicTitles.get(`${record.kind}:${record.id}`) ?? record.title, ""), status: record.status, safe_path_label: record.path,
        unavailable: record.status === "unavailable" || ("unavailable" in record && record.unavailable === true),
        markdown: "", updated_at: record.updatedAt })),
    };
  }

  async read(projectId: string, query: { kind: string; id: string; revision: string; cursor?: string }): Promise<ProjectDashboardDocument> {
    const row = this.requireProject(projectId);
    if (query.kind === "artifact") {
      const artifact = projectMessageArtifact(this.input.db, projectId, query.id);
      if (!artifact) throw new AppStoreOperationError(404, "source_unavailable", "Source unavailable.");
      if (query.revision !== artifact.revision) changed();
      return { id: artifact.id, project_id: projectId, kind: "report", document_type: "artifact", artifact,
        title: artifact.title, markdown: "", safe_path_label: artifact.safe_path_label ?? artifact.title, updated_at: artifact.created_at,
        revision: artifact.revision };
    }
    if (query.kind === "message") {
      const source = readProjectReportSource(this.input.db, projectId, query.id, query.revision);
      return this.sourcePage(row, query, source);
    }
    if (!row.ledger_project_id) throw new AppStoreOperationError(404, "source_unavailable", "Source unavailable.");
    const snapshot = await this.input.readLedger(projectId, row.ledger_project_id);
    if (query.kind === "reference") {
      const workId = query.id.split("|")[0]!;
      const entries = await this.readWorkHistory(projectId, row.ledger_project_id, snapshot, workId);
      const entry = entries.find((entry) => entry.id === query.id);
      if (!entry) throw new AppStoreOperationError(404, "source_unavailable", "Source unavailable.");
      if (query.revision !== entry.revision) changed();
      return this.sourcePage(row, query, { ...entry, body: `\`\`\`json\n${entry.body}\n\`\`\``, updatedAt: entry.at });
    }
    let source;
    try { source = await readProjectDashboardSource({ butlerData: this.input.butlerData,
      appProjectId: projectId, ledgerProjectId: row.ledger_project_id, snapshot, kind: query.kind, id: query.id }); }
    catch { throw new AppStoreOperationError(404, "source_unavailable", "Source unavailable."); }
    if (query.revision !== snapshot.revision && query.revision !== source.revision) changed();
    return this.sourcePage(row, query, source);
  }

  private sourcePage(row: ProjectRow, query: { kind: string; id: string; cursor?: string },
    source: { revision: string; body: string; title: string; status: string; updatedAt: string }): ProjectDashboardDocument {
    const cursor = query.cursor ? decodeCursor(query.cursor) : { revision: source.revision, offset: 0 };
    if (cursor.revision !== source.revision) changed();
    const body = safeDocument(source.body, [this.input.butlerData, row.workspace_path]);
    if (cursor.offset > body.length) throw new AppStoreOperationError(400, "invalid_cursor", "Invalid cursor.");
    const end = Math.min(body.length, cursor.offset + 24_000);
    return { id: query.id, project_id: row.id, revision: source.revision,
      kind: query.kind === "spec" ? "spec" : query.kind === "report" ? "report" : "plan",
      document_type: query.kind as ProjectDashboardDocument["document_type"],
      title: sanitizePublicText(source.title, "").slice(0, 500), status: source.status, safe_path_label: query.id,
      markdown: body.slice(cursor.offset, end), updated_at: source.updatedAt, truncated: end < body.length,
      nextCursor: end < body.length ? encodeCursor(source.revision, end) : null };
  }

  private requireProject(id: string): ProjectRow {
    const row = this.input.getProjectRow(id);
    if (!row) throw new AppStoreOperationError(404, "project_not_found", "Project not found.");
    return row;
  }

  /** Whole metadata inputs for statistics; never reuse a paginated UI history. */
  async statistics(projectId: string) {
    const row = this.requireProject(projectId);
    if (!row.ledger_project_id) return null;
    try {
      const snapshot = await this.input.readLedger(projectId, row.ledger_project_id);
      let history = null;
      try {
        const ledger = this.readHistory(resolve(this.input.butlerData, "project-ledger/projects", row.ledger_project_id));
        if (ledger.revision === "absent") throw new Error("dashboard_history_unavailable");
        const managed = await this.readWorkHistory(projectId, row.ledger_project_id, snapshot);
        history = { ledger: ledger.events, managed };
      } catch { /* A current snapshot remains useful when history is unavailable. */ }
      return { snapshot, history };
    } catch { return null; }
  }

  async history(projectId: string, query: ProjectHistoryQuery): Promise<DashboardHistoryPage> {
    const row = this.requireProject(projectId);
    let events: Extract<DashboardHistoryPage, { status: "ready" }>["events"];
    let revision: string;
    let ledgerUnavailable = true;
    try {
      if (!row.ledger_project_id) throw new Error("unbound");
      const snapshot = await this.input.readLedger(projectId, row.ledger_project_id);
      const history = this.readHistory(resolve(this.input.butlerData, "project-ledger/projects", row.ledger_project_id));
      revision = `${snapshot.revision}:${history.revision}`;
      const workTitles = new Map(snapshot.works.filter((work) => work.managed).map((work) => [work.record.id, work.managed!.objective]));
      events = history.events.flatMap((event) => {
        const record = snapshot.records.find((record) => record.id === event.recordId && record.kind === event.kind);
        if (!record) return [];
        return [{ id: `ledger:${event.id}`, at: event.at, action: event.action as "created" | "updated" | "completed",
          title: sanitizePublicText(event.kind === "work" ? workTitles.get(record.id) ?? record.title : record.title, ""), source: { kind: event.kind, id: record.id, revision: snapshot.revision } }];
      }).sort(compareHistory);
      const managed = await this.readWorkHistory(projectId, row.ledger_project_id, snapshot);
      const links = this.input.db.query<{ id: string; title: string; conversation_session_id: string }, [string]>(
        "SELECT id,title,conversation_session_id FROM chats WHERE project_id=? AND conversation_session_id IS NOT NULL",
      ).all(projectId);
      events.push(...managed.map((entry) => {
        const matches = links.filter((link) => link.conversation_session_id === conversationSessionIdForDurableSession(entry.sessionId));
        return { id: `managed:${entry.id}`, workId: entry.workId, at: entry.at, action: entry.action,
          title: sanitizePublicText(entry.title, ""), source: { kind: "reference", id: entry.id, revision: entry.revision },
          ...(matches.length === 1 ? { session: { id: matches[0]!.id, title: sanitizePublicText(matches[0]!.title, "") } } : {}) };
      }));
      events.sort(compareHistory);
      ledgerUnavailable = false;
    } catch { events = []; revision = "unavailable"; /* Never present a partial Ledger stream as complete. */ }
    return projectPublicHistory(this.input.db, projectId, revision, events, query, ledgerUnavailable);
  }
}

function safeDocument(markdown: string, roots: string[]): string {
  let text = markdown;
  for (const root of roots.filter((value) => value.length > 1)) text = text.split(root).join("[local]");
  return text.split("\n").map((line) => {
    const safe = sanitizePublicText(line, "");
    return safe === line.trim() ? line : safe;
  }).join("\n");
}
function changed(): never { throw new AppStoreOperationError(409, "source_changed", "Source changed. Reload it."); }
function encodeCursor(revision: string, offset: number): string {
  return Buffer.from(JSON.stringify({ revision, offset })).toString("base64url");
}
function decodeCursor(value: string): { revision: string; offset: number } {
  try {
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (typeof cursor.revision !== "string" || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw new Error();
    return cursor;
  } catch { throw new AppStoreOperationError(400, "invalid_cursor", "Invalid cursor."); }
}
