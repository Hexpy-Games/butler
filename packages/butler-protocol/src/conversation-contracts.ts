import type { InterfaceTextReference } from "../../butler-i18n/src/index.ts";
import type { AnswerBlockSet } from "./app-contracts.ts";
import type { ChatKind, SessionArtifactSummary, MessageContent, MessageFileRef, ProgressSummaryRow, SessionSummary, TurnState, WorkerActivityWorkBlock } from "./message-session-contracts.ts";

export type RuntimeDeliveryState =
  | "running"
  | "waiting_user"
  | "system_error"
  | "cancelled"
  | "delivered"
  | "delivered_with_limitations"
  | "delivered_with_continuation"
  | "failed_system";

export type SessionViewStatus =
  | "idle"
  | "active"
  | "delivered"
  | "failed"
  | "cancelled";

export interface SessionTurnProgress {
  summary?: string;
  summary_reference?: InterfaceTextReference;
  started_at?: string;
  safe_progress_rows: ProgressSummaryRow[];
}

export interface SessionRelation {
  relation_id: string;
  parent_session_id: string;
  parent_turn_id: string;
  child_session_id: string;
  anchor_message_id: string;
  created_at: string;
}

export interface WorkPlanAction {
  action_key: string; order: number; title: string; purpose: string;
  status: "pending" | "active" | "done" | "blocked" | "skipped";
  started_at?: string; finished_at?: string; added_in_revision: number;
}
export interface WorkPlanRevision { revision: number; at: string; added: string[]; removed: string[]; reason?: string }
export interface WorkPlan { revision: number; actions: WorkPlanAction[]; revisions: WorkPlanRevision[] }
export interface ActivityHistoryEntry { turn_id: string; created_at: string; rows: ProgressSummaryRow[] }

export interface StewardChild {
  plan?: WorkPlan;
  approved_plan_revision?: number;
  relation: SessionRelation;
  session_id: string;
  title: string;
  status: string;
  active_turn: SessionViewTurn | null;
  latest_turn: SessionViewTurn | null;
  waiting_for_children?: boolean;
  approved_plan_total?: number;
  approved_plan_completed?: number;
  result: { status: "success" | "blocked" | "failed" | "cancelled" } | null;
  terminal: boolean;
  updated_at: string;
}

export interface SessionViewTurn {
  progress?: SessionTurnProgress;
  id: string;
  state: TurnState;
  safe_status_label?: string;
  cancellable: boolean;
  retryable: boolean;
  delivery_state?: RuntimeDeliveryState;
  created_at: string;
  updated_at: string;
}

export interface SessionViewMessageWindow {
  next_cursor: number;
  complete: boolean;
  previous_cursor?: number;
  previous_cursor_token?: string;
  requested_cursor?: number;
  requested_cursor_token?: string;
  requested_before_cursor?: number;
  requested_before_cursor_token?: string;
  next_cursor_token?: string;
  has_more?: boolean;
}

export interface SessionViewCursors {
  messages: number;
  events: number;
}

export type MessageRole = "user" | "assistant" | "system" | "system_event" | "tool_summary" | "automation";

export interface ConversationMessage {
  artifacts?: SessionArtifactSummary[];
  turn_activity_rows?: ProgressSummaryRow[];
  content_parts?: MessageContent;
  id: string;
  chat_id?: string;
  turn_id?: string;
  role: MessageRole;
  text: string;
  answer_blocks?: AnswerBlockSet[];
  work_blocks?: WorkerActivityWorkBlock[];
  /** Set when Butler started the turn (schedule, canon step, delegated result); its request is not in the chat. */
  initiated?: { kind: string; work_session_id?: string; work_title?: string };
  attachments?: MessageFileRef[];
  status?: string;
  delivery_state?: RuntimeDeliveryState;
  safe_error_code?: string;
  retryable?: boolean;
  cursor?: number;
  created_at?: string;
  updated_at?: string;
}

export interface SessionView {
  artifacts?: SessionArtifactSummary[];
  plan?: WorkPlan;
  activity_history?: ActivityHistoryEntry[];
  relation?: { safe_title?: string };
  workers?: Array<StewardChild & { action_key?: string }>;
  waiting_for_children?: boolean;
  approved_plan_total?: number;
  approved_plan_completed?: number;
  steward_children?: StewardChild[];
  session_id: string;
  kind: ChatKind;
  project_id?: string;
  status: SessionViewStatus;
  context?: ContextDetails | null;
  branch?: SessionBranch | null;
  authority_requests?: AuthorityRequestRecord[];
  pending_questions?: PendingUserQuestions[];
  question_answers?: AnsweredUserQuestions[];
  active_turn: SessionViewTurn | null;
  latest_turn: SessionViewTurn | null;
  messages: ConversationMessage[];
  message_window: SessionViewMessageWindow;
  cursors: SessionViewCursors;
  updated_at: string;
}

export interface MessageSendRequest {
  content_parts?: MessageContent;
  chat_id: string;
  text: string;
  client_message_id: string;
  attachments: { file_id: string }[];
  queue_policy: "send_now" | "enqueue_if_busy";
}

export interface QueuedMessageRecord {
  content_parts?: MessageContent;
  id: string;
  chat_id: string;
  text: string;
  /** Transport id of the send; the delivered user message reuses it. */
  client_message_id?: string;
  plan_id?: string;
  attachments?: MessageFileRef[];
  controls: {
    model: string;
    reasoning_effort: ReasoningEffort;
    access_mode: "read_only" | "ask_first" | "ask_except_reads" | "auto" | "full_access";
    plan_mode: boolean;
  };
  state: "queued" | "dispatching" | "dispatched" | "deleted" | "failed";
  safe_error_code?: string;
  dispatched_message_id?: string;
  turn_id?: string;
  cursor: number;
  created_at: string;
  updated_at: string;
}

export interface SessionQueueView {
  session_id: string;
  queued_messages: QueuedMessageRecord[];
  /** Stopped turn: queued messages wait for the next user input. */
  paused?: boolean;
}

export type CreateSessionRequest = {
  kind: "chat" | "project";
  project_id?: string;
  group_id?: string;
  workspace_mode: "local";
  title: string;
};
export type CreateSessionResult = { session: SessionSummary };
export type MessageSendResult = { accepted?: boolean; queued?: QueuedMessageRecord };

export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelSummary {
  /** Local server kind; only models on a local server have it. */
  platform?: "llama_cpp" | "ollama" | "lm_studio" | "custom";
  /** How the model's provider is signed in. */
  auth_type?: "api_key" | "chatgpt_oauth";
  provider_id: string;
  provider_label: string;
  model_id: string;
  model_ref: string;
  display_name: string;
  default_reasoning_effort: ReasoningEffort;
  reasoning_efforts: ReasoningEffort[];
  reasoning_budget_tokens?: Partial<Record<ReasoningEffort, number>>;
  availability?: "ready" | "sign_in_required" | "plan_off" | "not_in_plan";
  /** Catalog image capability; absent means unknown. */
  image_input_support?: "supported" | "unsupported" | "unknown";
}

export interface ModelCatalog {
  generation: string;
  default_model_ref: string;
  default_reasoning_effort: ReasoningEffort;
  models: ModelSummary[];
  registered_models?: ModelSummary[];
}

export interface SessionControls {
  model: string;
  reasoning_effort: ReasoningEffort;
  access_mode: string;
  plan_mode: boolean;
}

export interface SessionControlsView {
  session_id: string;
  controls: SessionControls;
  revision: number;
  catalog_generation: string;
}

export interface ContextDetails {
  provider_id?: string;
  updated_at?: string;
  used_tokens: number;
  budget_tokens: number;
  ratio: number;
  auto_compact_at_tokens?: number;
  model_ref?: string;
}

export interface SessionBranch {
  available: boolean;
  workspace_label?: string;
  workspace_path?: string;
  branch_name?: string;
  safe_status?: string;
}

export interface AuthorityRequestRecord {
  request_ref: string; category: string; reason: string; executable: string; command_count: number;
  scope?: { title: string; description: string };
  source_turn_id?: string; source_session_id?: string; source_call_id?: string;
  approval?: ApprovalSummaryWire;
}

export interface ApprovalSummaryWire {
  operation?: {
    image?: unknown; tool: string; access: "read_only" | "change"; targets: string[]; command?: string;
    rule_prefixes?: string[];
    permission_rule?: { effect: "allow" | "deny"; kind: "command_prefix" | "folder"; scope: "conversation" | "always"; reason: string };
    allow_conversation?: boolean; allow_site?: "signed_in" | "payment";
    browser_tab?: string; browser_mode?: "signed_out" | "signed_in"; sign_in_step?: string; wait_reason?: string;
    browser_steps?: { action: string; role: string; name: string; frame: string; value_preview?: string | null; addons: string[] }[];
  };
  command_access?: "read_only_unisolated";
  schedule?: {
    title: string; schedule_type: "once" | "interval" | "daily" | "weekdays" | "update";
    browser_signin?: boolean; browser_payment?: boolean; time?: string; run_at?: string; start_at?: string;
    interval_seconds?: number; access_mode?: "auto" | "read_only" | "ask_first" | "ask_except_reads" | "full_access";
  };
  action_kind: string; targets: { kind: string; path: string; label?: string }[];
  count: number; examples: string[]; examples_truncated?: boolean[]; risk?: "low" | "medium" | "high";
}

export interface AuthorityDecisionResult {
  request_ref: string; decision: "allowed" | "denied" | "modified"; scheduled: boolean;
}

export interface UserQuestion {
  /** `text`: a free-text answer with no options. */
  id: string; eyebrow: string; title: string; kind: "single" | "multi" | "text"; allow_custom: boolean;
  /** `skip` and `input` duplicate the card's own Skip and free input; the runtime drops them. */
  options: { id: string; label: string; description?: string; recommended?: boolean; kind?: "answer" | "skip" | "input" }[];
}
export interface PendingUserQuestions {
  request_ref: string; source_turn_id: string; source_session_id: string;
  question_state: "pending" | "deferred";
  category: "ask_user"; questions: { questions: UserQuestion[] };
}
export interface UserQuestionAnswer { id: string; selected: string[]; custom: string | null; skipped: boolean }
export type UserQuestionResponse = { status: "answered"; answers: UserQuestionAnswer[] } | { status: "deferred" };
export interface AnsweredUserQuestions {
  request_ref: string; followup_message_id: string; source_turn_id: string; updated_at: string;
  questions: { questions: UserQuestion[] }; response: UserQuestionResponse;
}

export interface OperationOutputView {
  turn_id: string;
  request_id: string;
  result_id: string;
  content: string;
  byte_start: number;
  byte_end: number;
  byte_length: number;
  complete: boolean;
}
