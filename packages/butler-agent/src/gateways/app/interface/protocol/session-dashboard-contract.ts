import type { ProjectSummary } from "./navigation-contract.ts";
import type { SessionArtifactSummary } from "./attachment-contract.ts";

export interface DashboardArtifactPage {
  items: Array<SessionArtifactSummary & { session_title: string; revision: string; mime_type: string }>;
  nextCursor: string | null;
}

export interface DashboardBriefingSource {
  sourceId: string; kind: "work" | "plan" | "spec" | "report" | "message";
  id: string; revision: string; title: string; sessionId?: string;
}
export interface DashboardBriefingContent {
  introduction: string;
  position: { title: string; body: string; sourceIds: string[] };
  suggestions: Array<{ candidateId: string; title: string; reason: string; sourceIds: string[] }>;
}
export interface DashboardBriefingView {
  status: "needed" | "generating" | "ready" | "unavailable";
  sourceRevision: string; language: string;
  coverage: { totalWorks: number; includedWorks: number; includedDocuments: number; includedReports: number; excludedUnits: number };
  sources: DashboardBriefingSource[];
  candidates: Array<{ id: string; sourceId: string; text: string }>;
  content?: DashboardBriefingContent; generatedAt?: string;
}
export interface DashboardStatisticsView {
  timezone: string; period: 7 | 30 | 90; observedAt: string;
  days: Array<{ date: string; start: string; end: string; partial: boolean }>;
  sources: Record<string, DashboardStatisticSource>;
  work: null | {
    work: DashboardStatisticSeries; task: DashboardStatisticSeries;
    cards: Record<"work" | "task", Array<DashboardBoardCard & { sourceKey: string; ageDays: number | null }>>;
    excluded: number;
    activity: Array<{ sourceKey: string; dates: string[]; changes: number }>;
  };
  activity: DashboardStatisticSeries;
  materials: DashboardStatisticSeries;
  materialTypes: DashboardStatisticSeries;
  ledgerHistoryAvailable: boolean;
  sessionHistoryAvailable: boolean;
  execution: { outcomes: DashboardStatisticSeries; duration: DashboardStatisticSeries; excluded: number };
  usage: { status: "unavailable"; reason: "project_usage_not_collected" };
}
export interface DashboardStatisticSource {
  title: string; at: string;
  source?: { id: string; kind: string; revision: string };
  session?: { id: string; title: string };
  durationMs?: number;
}
export interface DashboardStatisticSeries {
  keys: string[];
  buckets: Array<{ label: string; values: Record<string, string[]> }>;
}

export interface DashboardWorkCard {
  id: string; title: string; revision: string | null;
  authorityKind: "managed_work" | "ledger_record";
  executionStatus: "open" | "blocked" | "completed" | "abandoned" | "unknown";
  ledgerStatus: string; updatedAt: string; priority: number;
  taskProgress: { done: number; total: number } | null;
}

export type DashboardOverview = {
  status: "ready"; sourceRevision: string; observedAt: string; totalWorks: number;
  progress: Record<DashboardWorkCard["executionStatus"], number>;
  remaining: DashboardWorkCard[]; remainingCount: number;
} | { status: "unavailable"; reason: "unbound" | "source_unavailable" };

export interface DashboardBoardCard {
  id: string; kind: "work" | "plan" | "task"; title: string;
  parentId: string | null; status: string; lane: "planned" | "active" | "review" | "blocked" | "done" | "other";
  updatedAt: string; taskProgress: { done: number; total: number } | null;
  actionProgress: { done: number; total: number } | null;
  session: { id: string; title: string; running: boolean } | null;
}
export type DashboardBoardPage = {
  status: "ready"; sourceRevision: string; items: DashboardBoardCard[]; total: number; nextCursor: string | null;
  laneCounts: Record<DashboardBoardCard["lane"], number>;
  parents: Array<{ id: string; title: string }>;
} | { status: "unavailable"; reason: "unbound" | "source_unavailable" };

export interface ProjectDashboardActivityDay {
  date: string;
  count: number;
}

export type ProjectDashboardDocumentType =
  | "artifact"
  | "reference"
  | "message"
  | "report"
  | "spec"
  | "plan"
  | "roadmap"
  | "work"
  | "task";

export interface ProjectDashboardDocument {
  artifact?: SessionArtifactSummary;
  unavailable?: boolean;
  revision?: string;
  project_id?: string;
  truncated?: boolean;
  nextCursor?: string | null;
  id: string;
  kind: "spec" | "plan" | "report";
  document_type?: ProjectDashboardDocumentType;
  title: string;
  category?: string;
  status?: string;
  safe_path_label: string;
  markdown: string;
  updated_at: string;
}

export type DashboardMaterialsPage = {
  status: "ready"; documents: ProjectDashboardDocument[]; total: number; nextCursor: string | null;
} | { status: "unavailable"; reason: "unbound" | "source_unavailable" };

export type DashboardHistoryPage = {
  status: "ready"; nextCursor: string | null; ledgerUnavailable?: boolean;
  events: Array<{ id: string; at: string; action: "created" | "updated" | "completed" | "reported" | "reviewed" | "disposition" | "result";
    workId?: string;
    session?: { id: string; title: string }; artifactCount?: number;
    title: string; source: { kind: string; id: string; revision: string } }>;
} | { status: "unavailable"; reason: "unbound" | "source_unavailable" };

export interface ProjectDashboardView {
  briefing?: DashboardBriefingView;
  description?: string | null;
  preferences?: { revision: number; pinnedSourceRefs: Array<{ kind: string; id: string; revision: string }> };
  overview?: DashboardOverview;
  project: ProjectSummary;
  stats: {
    active_sessions: number;
    archived_sessions: number;
    recent_messages_7d: number;
    recent_messages_30d: number;
    specs: number;
    plans: number;
  };
  activity: {
    days: ProjectDashboardActivityDay[];
  };
  documents: ProjectDashboardDocument[];
  generated_at: string;
}
