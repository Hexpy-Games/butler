export type { CanonQueueView, CanonQueueItem, CanonQueueEdit, CanonQueueChanged, CanonQueueConflict, CanonHoldDecision, CanonHoldPanel, CanonTakeHerePanel, CanonStepOrigin } from "./canon-queue-contracts";

/** Canon gateway wire contracts. Entity revisions are numeric CAS tokens. */
export type CanonStatus = "planned" | "in_progress" | "in_review" | "blocked" | "done" | "cancelled";
export type WorkTaskStatus = "draft" | "waiting" | "pending" | "running" | "in_review" | "held" | "failed" | "completed" | "blocked" | "paused" | "stopped" | "cancelled";
export type TaskCounts = { total: number } & Partial<Record<WorkTaskStatus, number>>;
export type CanonTagColor = "gray" | "red" | "orange" | "yellow" | "green" | "teal" | "blue" | "purple";
export interface EpicTag { id: string; name: string; color: CanonTagColor }
export interface CanonTag extends EpicTag {
  project_id: string;
  name_key: string;
  revision: number;
  created_at: number;
  updated_at: number;
  created_by: string;
}
export interface CanonTagCreateInput { name: string; color: CanonTagColor }
export interface CanonTagEditInput { expected_revision: number; name?: string; color?: CanonTagColor }
export interface CanonTagExists extends Error { code: "tag_exists"; status: 409; existing: CanonTag }
export interface CanonAgent { person: string; via: string }
export interface CanonActor { person?: string | null; via?: string | null; origin?: string; client?: string }
export interface CanonActivity { seq: number; entity_id: string; kind: string; from?: CanonStatus; to?: CanonStatus; summary: string; body: string | null; actor: CanonActor; at: number }
export interface CanonActivityPage { activity: CanonActivity[]; activity_before: number | null }
export interface CanonMcpProposal { id: string; spec_id: string; summary: string; current_body: string | null; proposed_body: string; actor: CanonActor; base_revision: number; created_at: string }
export interface CriteriaCount { confirmed: number; total: number }
export interface CanonWork {
  criteria?: CriteriaCount | null;
  agent?: CanonAgent | null;
  tags: EpicTag[];
  id: string;
  project_id: string;
  plan_id: string | null;
  home_session_id: string | null;
  session_ids: string[];
  sessions: Array<{ session_id: string; bound_at: number; origin: "user" | "butler" }>;
  title: string;
  description: string;
  kind: string | null;
  canon_status: CanonStatus;
  canon_status_source: "runtime" | "person" | null;
  assignee: string | null;
  plan_rank: string | null;
  origin: "chat" | "dialog" | "board" | "mcp";
  revision: number;
}
export interface EpicCard extends CanonWork {
  task_counts: TaskCounts;
  running?: boolean;
  /** Its place in its home conversation's queue; `hold` marks a step waiting on a decision. */
  queue?: { state: "waiting" | "running" | "held" | "done"; hold: boolean; finished_at: number | null } | null;
}
export interface CanonPlan {
  updated_at?: number;
  id: string;
  project_id: string;
  title: string;
  description: string;
  due_on: string | null;
  status: "open" | "closed";
  revision: number;
}
export interface PlanCards extends CanonPlan { works: EpicCard[] }
export interface CanonOverview {
  project_id: string;
  backlog_revision: number;
  backlog: EpicCard[];
  plans: PlanCards[];
}
export interface PlanDetail extends PlanCards { progress: { total: number; done: number } }
export interface SpecCriterion {
  confirmed: boolean;
  node_id: string;
  revision: number;
  criterion_id: string;
  part_id: string;
  text: string;
}
export interface SpecNode {
  revision: number;
  latest_revision?: number | null;
  node_id: string;
  parent_node_id: string | null;
  concern_id: string;
  active_revision: number | null;
  lifecycle: "draft" | "active" | "retired";
  active: { node_id: string; revision: number; body_hash: string; parser_version: string; state: string } | null;
  criteria: SpecCriterion[];
  children: SpecNode[];
}
export interface WorkTask {
  id: string;
  work_id: string;
  title: string;
  description: string;
  status: WorkTaskStatus;
  assignee_session_id: string | null;
  blocked_reason: string | null;
  chain_id: string | null;
  step_index: number | null;
  stack_position: number | null;
  hold_reason: "predecessor_failed" | "predecessor_stopped" | null;
  failure_reason: string | null;
  revision: number;
}
export interface CanonAttachment {
  file_id: string; kind: "image" | "text" | "generic"; mime_type: string; safe_name: string;
  size_bytes: number; sha256: string; url: string; signed_url?: string; created_at: string;
  width?: number | null; height?: number | null;
}
export interface EpicDetail extends EpicCard { activity?: CanonActivity[]; activity_before?: number | null; proposals?: CanonMcpProposal[]; attachments?: CanonAttachment[]; specs: SpecNode[]; tasks: WorkTask[] }
export interface EpicProgressSnapshot {
  epic_id: string;
  running: boolean;
  stage: "conception" | "planning" | "execution" | "review" | "validation" | "reporting" | null;
  stage_history: Array<{ work_id: string; revision: number; stage: NonNullable<EpicProgressSnapshot["stage"]>; summary: string; created_at: string }>;
  actions: Array<{ work_id: string; actionKey: string; description: string; dependencyKeys: string[]; status: "pending" | "active" | "done" | "blocked" | "skipped"; note?: string }>;
  disposition: "open" | "blocked" | "completed" | null;
  counts: { completed: number; total: number };
}
export interface PlanInput {
  expected_revision?: number;
  title?: string;
  description?: string;
  due_on?: string | null;
  status?: "open" | "closed";
}
export interface EpicInput {
  expected_revision?: number;
  title?: string;
  description?: string;
  status?: CanonStatus;
  assignee?: string | null;
  plan_id?: string | null;
  before_id?: string;
  tags?: string[];
}
export interface CanonOrderInput { work_ids: string[]; expected_revision: number }
export interface CanonProgressChanged { project_id: string; epic_id: string }
export interface CanonChanged {
  project_id: string;
  kind: "plan" | "backlog" | "work" | "spec_node" | "tag";
  id: string;
  revision: number;
  origin: "local" | "remote" | "mcp" | "butler";
  event_seq: number;
}
export interface CanonConflict extends Error {
  code: "conflict";
  status: 409;
  current: { revision: number };
}
export interface CanonSidebarGroup {
  key: string;
  kind: "backlog" | "plan";
  title: string;
  plan_revision?: number;
  rows: EpicCard[];
}
export interface CanonSidebar { project_id: string; groups: CanonSidebarGroup[] }
export interface CanonSidebarOrderInput { group_key: string; work_ids: string[] }
export interface CanonConversation { session_id: string; work: EpicDetail }

export interface CanonConversationInput { sessionId?: string }

/** Ordered selection for an atomic queue move; supply exactly one form. */
export type CanonQueueMoveSelection =
  | { epic_id: string; epic_ids?: never }
  | { epic_ids: string[]; epic_id?: never };
