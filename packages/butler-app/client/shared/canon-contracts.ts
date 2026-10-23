/** Canon gateway wire contracts. Entity revisions are numeric CAS tokens. */
export type CanonStatus = "planned" | "in_progress" | "in_review" | "blocked" | "done" | "cancelled";
export type WorkTaskStatus = "draft" | "waiting" | "pending" | "running" | "in_review" | "held" | "failed" | "completed" | "blocked" | "paused" | "stopped" | "cancelled";
export type TaskCounts = { total: number } & Partial<Record<WorkTaskStatus, number>>;
export interface CanonWork {
  id: string;
  scope_kind: "session" | "project";
  scope_ref: string;
  plan_id: string | null;
  home_session_id: string | null;
  title: string;
  description: string;
  kind: string | null;
  run_state: "idle" | "running" | "in_review" | "blocked" | "failed" | "paused" | "stopped" | "done" | "cancelled";
  canon_status: CanonStatus;
  canon_status_source: "runtime" | "person";
  assignee: string | null;
  plan_rank: string | null;
  task_graph_revision: number;
  visibility: "canon";
  origin: "chat" | "dialog" | "board" | "mcp" | "migration";
  revision: number;
  draft: boolean;
}
export interface EpicCard extends CanonWork { task_counts: TaskCounts }
export interface CanonPlan {
  id: string;
  project_id: string;
  title: string;
  description: string;
  due_on: string | null;
  status: "open" | "closed";
  visibility: "canon";
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
  node_id: string;
  revision: number;
  criterion_id: string;
  part_id: string;
  text: string;
}
export interface SpecNode {
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
export interface EpicDetail extends EpicCard { specs: SpecNode[]; tasks: WorkTask[] }
export interface WorkTasks {
  work_id: string;
  task_graph_revision: number;
  chains: Array<{
    id: string;
    work_id: string;
    created_at: number;
    state: "active" | "held" | "done";
    steps: Array<{ index: number; tasks: WorkTask[] }>;
    hold_questions: Array<{ id: string; chain_id: string; question_message_id: string; revision: number }>;
    ready_task_ids: string[];
  }>;
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
  expected_task_graph_revision?: number;
  title?: string;
  description?: string;
  status?: CanonStatus;
  assignee?: string | null;
  plan_id?: string | null;
  before_id?: string;
}
export interface CanonOrderInput { work_ids: string[]; expected_revision: number }
export interface CanonChanged {
  project_id: string;
  kind: "plan" | "backlog" | "work" | "spec_node";
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
export function isCanonConflict(error: unknown): error is CanonConflict {
  return error instanceof Error && "code" in error && error.code === "conflict" &&
    "current" in error && typeof (error.current as { revision?: unknown })?.revision === "number";
}
export type WorkTaskEdit =
  | { op: "move_to_new_step"; chain_id: string; task_id: string; index: number }
  | { op: "join_stack"; chain_id: string; task_id: string; target: string }
  | { op: "move_to_chain"; chain_id: string; task_id: string; target_chain_id: string; index?: number; target?: string }
  | { op: "start_now" | "delete"; chain_id: string; task_id: string }
  | { op: "split_stack"; chain_id: string; index: number }
  | { op: "decide_hold"; chain_id: string; id: string; decision: "run_anyway" | "delete" };
export interface WorkTasksEditInput { ops: WorkTaskEdit[]; expected_task_graph_revision: number }
