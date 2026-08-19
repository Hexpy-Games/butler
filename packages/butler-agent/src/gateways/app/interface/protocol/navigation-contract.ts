import type { ChatKind, ProjectStatus, TurnState } from "./base-contract.ts";

export interface ChatSummary {
  id: string;
  title: string;
  kind: ChatKind;
  project_id?: string;
  created_at: string;
  updated_at: string;
}

export interface SessionSummary {
  id: string;
  kind: ChatKind;
  title: string;
  project_id?: string;
  project?: {
    id: string;
    display_name: string;
  };
  session_hint: string;
  created_at: string;
  updated_at: string;
  last_activity_at: string;
  last_message_preview?: string;
  active_turn_state?: TurnState;
  safe_status_label?: string;
  unread_count: number;
  pinned: boolean;
  archived: boolean;
  automation_target_count: number;
  parent_session_id?: string;
  is_steward_child?: boolean;
  steward_children?: SessionSummary[];
}

export interface ProjectSummary {
  id: string;
  display_name: string;
  status: ProjectStatus;
  last_activity_at: string;
  active_session_count: number;
  pinned: boolean;
  archived: boolean;
  error_summary?: string;
  workspace_label: string;
  safe_path_label: string;
  sessions?: SessionSummary[];
}

export interface NavigationView {
  chats: SessionSummary[];
  projects: ProjectSummary[];
  automations_summary: {
    total_count: number;
    enabled_count: number;
  };
  settings_summary: {
    profile_label: string;
  };
  generated_at: string;
}

export interface ProjectListView {
  projects: ProjectSummary[];
}

export interface SessionListView {
  sessions: SessionSummary[];
}

export interface ArchiveListView {
  projects: ProjectSummary[];
  sessions: SessionSummary[];
  pagination: PaginationView;
}

export interface NewChatBriefingSuggestion {
  id: string;
  title: string;
  description: string;
  text: string;
}

export interface NewChatBriefingView {
  moment: string;
  title: string;
  description?: string;
  suggestions: NewChatBriefingSuggestion[];
  source: {
    scope: "general" | "project" | "onboarding";
    content_origin: "generated" | "heuristic_fallback";
    consolidation_run_id: string | null;
    generated_at: string;
    locale: "ko" | "en";
    project_id?: string;
    project_name?: string;
    persona_applied: boolean;
    profile_projection_applied: boolean;
  };
  raw_text_included: false;
}

export interface PaginationView {
  limit: number;
  offset: number;
  total: number;
  has_more: boolean;
}

export interface ProjectSessionListView {
  project_id?: string;
  sessions: SessionSummary[];
}

export type CreateProjectSource = "scratch" | "existing_folder";

export interface CreateProjectRequest {
  source: CreateProjectSource;
  display_name?: string;
  folder_selection_token?: string;
  idempotency_key?: string;
}

export interface CreateProjectResult {
  project: ProjectSummary;
}

export interface UpdateProjectRequest {
  display_name?: string;
  pinned?: boolean;
  archived?: boolean;
}

export interface ProjectActionResult {
  project: ProjectSummary;
}

export interface CreateSessionRequest {
  kind: ChatKind;
  title?: string;
  initial_message?: string;
  project_id?: string;
  session_hint?: string;
  idempotency_key?: string;
}

export interface CreateSessionResult {
  session: SessionSummary;
}

export interface UpdateSessionRequest {
  title?: string;
  archived?: boolean;
}

export interface SessionActionResult {
  session: SessionSummary;
}
