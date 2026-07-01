import type { ProjectSummary } from "./navigation-contract.ts";

export interface ProjectDashboardActivityDay {
  date: string;
  count: number;
}

export type ProjectDashboardDocumentType =
  | "spec"
  | "plan"
  | "roadmap"
  | "work"
  | "task";

export interface ProjectDashboardDocument {
  id: string;
  kind: "spec" | "plan";
  document_type?: ProjectDashboardDocumentType;
  title: string;
  category?: string;
  status?: string;
  safe_path_label: string;
  markdown: string;
  updated_at: string;
}

export interface ProjectDashboardView {
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
