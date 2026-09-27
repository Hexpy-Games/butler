/** Message, session, navigation, activity, and event wire contracts. */
import type {
  InterfaceContentReferences,
  InterfaceTextReference,
} from "../../../butler-i18n/src/index.ts";

/** App wire contracts shared by the UI, Electron declarations, and server. */

export const APP_PROTOCOL_VERSION = "butler.app.v1";

export type ChatKind = "chat" | "project";
export type ProjectStatus = "active" | "archived";
export type TurnState =
  | "queued"
  | "accepted"
  | "thinking"
  | "streaming"
  | "waiting_for_form"
  | "waiting_for_tool"
  | "cancelling"
  | "cancelled"
  | "delivered"
  | "runtime_fault"
  | "failed"
  | "retrying";

export interface SessionBranchRequest {
  requestId: string;
  sourceSessionId: string;
  sourceMessageId: string;
  title: string;
  followUp?: string;
  destination:
    | { kind: "chat" }
    | { kind: "project"; projectId: string }
    | { kind: "new_project"; name: string };
}

export interface SessionBranchSeed {
  summary: string;
  sourceSessionId: string;
  sourceMessageId: string;
  canonicalSessionId: string | null;
  canonicalMessageId: string | null;
  sourceThroughMessageId: string;
  excerptTruncated: boolean;
}

export interface ProjectSourceReference {
  kind: "work" | "task" | "plan" | "spec" | "report" | "message" | "reference";
  id: string;
  revision: string;
}

export interface ProjectSourceContentPart {
  type: "project_source_ref";
  projectId: string;
  source: ProjectSourceReference;
  titleSnapshot: string;
  /** Quoted subject selected by the user; never a status mutation or instruction. */
  topic?: string;
}

export type MessageContentPart =
  | { type: "text"; text: string }
  | { type: "session_ref"; sessionId: string; titleSnapshot: string }
  | ProjectSourceContentPart;

export interface MessageContent {
  version: 1;
  parts: MessageContentPart[];
}

export function isMessageContent(value: unknown): value is MessageContent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const doc = value as Partial<MessageContent>;
  return (
    doc.version === 1 &&
    Array.isArray(doc.parts) &&
    doc.parts.length <= 1000 &&
    doc.parts.every((part) =>
      part && typeof part === "object" && part.type === "text"
        ? typeof part.text === "string"
        : part && typeof part === "object" && part.type === "session_ref"
          ? typeof part.sessionId === "string" &&
            part.sessionId.trim().length > 0 &&
            typeof part.titleSnapshot === "string"
          : isProjectSourceContentPart(part),
    )
  );
}

export function isProjectSourceContentPart(
  value: unknown,
): value is ProjectSourceContentPart {
  if (!value || typeof value !== "object") return false;
  const part = value as Partial<ProjectSourceContentPart>;
  return (
    part.type === "project_source_ref" &&
    typeof part.projectId === "string" &&
    part.projectId.length > 0 &&
    part.projectId.length <= 256 &&
    typeof part.titleSnapshot === "string" &&
    part.titleSnapshot.length <= 500 &&
    (part.topic === undefined ||
      (typeof part.topic === "string" &&
        part.topic.trim().length > 0 &&
        part.topic.length <= 80)) &&
    !!part.source &&
    ["work", "task", "plan", "spec", "report", "message", "reference"].includes(
      part.source.kind,
    ) &&
    typeof part.source.id === "string" &&
    part.source.id.length > 0 &&
    part.source.id.length <= 256 &&
    typeof part.source.revision === "string" &&
    /^[a-f0-9]{64}$/u.test(part.source.revision)
  );
}

export function messageContentText(content: MessageContent): string {
  return content.parts
    .map((part) => (part.type === "text" ? part.text : `@${part.titleSnapshot}`))
    .join("");
}

export interface ChatSummary {
  id: string;
  title: string;
  kind: ChatKind;
  project_id?: string;
  created_at: string;
  updated_at: string;
}

export interface SessionSummary {
  work_progress?: { completed: number; total: number };
  branch_seed?: SessionBranchSeed;
  id: string;
  kind: ChatKind;
  title: string;
  project_id?: string;
  project?: { id: string; display_name: string };
  session_hint: string;
  created_at: string;
  updated_at: string;
  last_activity_at: string;
  last_message_preview?: string;
  active_turn_state?: TurnState;
  safe_status_label?: string;
  safe_status_label_key?: string;
  safe_status_label_parameters?: { attempt: number; maxAttempts: number };
  safe_status_content?: InterfaceContentReferences;
  unread_count: number;
  pinned: boolean;
  archived: boolean;
  automation_target_count: number;
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

export interface SessionArtifactSummary {
  id: string;
  session_id?: string;
  project_id?: string;
  message_id?: string;
  turn_id?: string;
  file_id?: string;
  kind:
    | "csv_file"
    | "table_file"
    | "chart_file"
    | "image"
    | "document"
    | "code"
    | "report"
    | "file"
    | "unknown";
  title: string;
  safe_path_label?: string;
  url?: string;
  size_bytes?: number;
  created_at: string;
  open_action?: "route" | "unsupported";
}

export interface ProgressDetailRow {
  id: string;
  kind?: string;
  safe_label: string;
  safe_value?: string;
  state?: string;
}

export interface ProgressSummaryRow {
  interface_label_key?: string;
  interface_content?: InterfaceContentReferences;
  interface_label_parameters?: { attempt: number; maxAttempts: number };
  id: string;
  kind:
    | "explored"
    | "searched"
    | "read"
    | "ran_command"
    | "edited"
    | "dispatch"
    | "used_tool"
    | "context"
    | "model"
    | "thinking"
    | "worked_duration"
    | "message"
    | "turn"
    | "automation"
    | "worker"
    | "system"
    | string;
  safe_label: string;
  state: string;
  created_at: string;
  turn_event_sequence?: number;
  safe_tool_name?: string;
  safe_input_label?: string;
  tool_call_id?: string;
  tool_result_id?: string;
  tool_result_byte_length?: number;
  bridge_phase?: string;
  receipt_kind?: string;
  public_decision_role?: string;
  public_decision_summary?: string;
  public_decision_rationale?: string;
  public_decision_next_step?: string;
  public_decision_source?: string;
  public_decision_model_call_id?: string;
  public_decision_latency_ms?: number;
  public_decision_evidence_refs?: string[];
  work_contract_id?: string;
  work_stream_id?: string;
  semantic_block_id?: string;
  activity_stage?: string;
  work_block_id?: string;
  work_block_label?: string;
  work_block_phase?: "started" | "updated" | "completed";
  work_block_sequence?: number;
  work_decision_id?: string;
  work_decision_title?: string;
  work_decision_summary?: string;
  work_decision_rationale?: string;
  work_decision_next_step?: string;
  work_decision_source?: string;
  work_decision_evidence_refs?: string[];
  runtime_fault_id?: string;
  runtime_fault_kind?: string;
  runtime_fault_retryable?: boolean;
  runtime_fault_public_summary?: string;
  runtime_fault_safe_error_code?: string;
  runtime_fault_safe_cause?: string;
  safe_count?: number;
  safe_path_labels?: string[];
  safe_detail_rows?: ProgressDetailRow[];
  safe_order?: number;
}

export interface WorkerActivityWorkBlock {
  id: string;
  label: string;
  state: string;
  rows: ProgressSummaryRow[];
  decision_title?: string;
  decision_summary?: string;
  decision_rationale?: string;
  decision_next_step?: string;
  decision_source?: string;
  decision_evidence_refs?: string[];
  created_at?: string;
}

export type WorkerActivityPhase =
  | "orienting"
  | "planning"
  | "inspecting"
  | "executing"
  | "verifying"
  | "committing"
  | "consolidating"
  | "reporting"
  | "complete"
  | "blocked"
  | "failed"
  | "cancelled"
  | "recoverable";

export interface WorkerActivitySummary {
  worker_id: string;
  activity_kind: "planned" | "worker";
  worker_label: string;
  worker_display_name: string;
  worker_ordinal_label: string;
  objective: string;
  phase: WorkerActivityPhase;
  status_line: string;
  status_reference?: InterfaceTextReference;
  current_activity_reference?: InterfaceTextReference;
  current_activity_title?: string;
  work_blocks?: WorkerActivityWorkBlock[];
  session_id?: string;
  parent_turn_id?: string;
  source_tool_call_id?: string;
  approved_plan_total?: number;
  approved_plan_completed?: number;
  project_id?: string;
  task_id?: string;
  orchestration_id?: string;
  terminal: boolean;
  created_at?: string;
  updated_at: string;
  supported_controls: Array<"cancel" | "resume">;
}

export interface AppEventEnvelope {
  protocol_version: typeof APP_PROTOCOL_VERSION;
  id: number;
  type:
    | "message.created"
    | "message.deleted"
    | "chat.created"
    | "server.status"
    | "turn.state_changed"
    | "context.compaction.started"
    | "context.compaction.completed"
    | string;
  created_at: string;
  payload: Record<string, unknown>;
}

export const WORKER_PROFILE_ID_PATTERN = /^(?:default|w[1-9]\d*)$/u;
