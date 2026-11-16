import type { ProjectDashboardDocument } from "./dashboard-space-contracts.ts";

export type TaskGraphStatus = "pending" | "running" | "review" | "done" | "skipped" | "failed" | "blocked" | "paused" | "cancelled";
export type TaskGraphState = "running" | "failed" | "waiting" | "done" | "cancelled";
export interface TaskGraphCounts {
  total: number;
  completed: number;
  running: number;
  failed: number;
  blocked: number;
  cancelled: number;
  skipped: number;
}
export interface TaskDocumentRef {
  id: string;
  revision: string;
  title: string;
  status: TaskGraphStatus;
  source_label: string;
}
export type TaskGraphPhase = "conception" | "planning" | "execution" | "review" | "validation" | "reporting";
export interface TaskGraphReview {
  subject: "plan" | "result" | "completion";
  verdict: "accept" | "revise" | "partial";
  summary: string;
  created_at: string;
}
export interface TaskGraphAttempt {
  task_id: string;
  session_id: string;
  ordinal: number;
  status: "running" | "success" | "blocked" | "failed" | "cancelled" | "pending";
  summary: string | null;
  model_display_name: string | null;
  started_at: string | null;
  finished_at: string | null;
}
export interface TaskGraphNode {
  task_id: string;
  title: string;
  status: TaskGraphStatus;
  kind: "task";
  rank: number;
  assignee_ordinal: number | null;
  model_display_name: string | null;
  session_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  current_step: string | null;
  blocked_reason: string | null;
  reason_code: "action_blocked" | "attempt_failed" | "result_received" | "review_revised" | "work_abandoned" | null;
  handled_directly: boolean;
  attempts: TaskGraphAttempt[];
  review?: TaskGraphReview;
  document: TaskDocumentRef;
}
export interface TaskGraphSummary {
  graph_id: string;
  phase: TaskGraphPhase;
  work_state: "open" | "blocked" | "completed" | "abandoned";
  title: string;
  state: TaskGraphState;
  counts: TaskGraphCounts;
  graph_revision: string;
  updated_at: string;
}
export interface TaskGraphsPage {
  graphs: TaskGraphSummary[];
  cursor: string | null;
  graph_revision: string;
  total: number;
  event_seq: number;
}
export interface TaskGraphSnapshot extends TaskGraphSummary {
  nodes: TaskGraphNode[];
  /** All edges at this revision; node pages have exact totals. */
  edges: Array<{ from: string; to: string }>;
  totals: { nodes: number; edges: number };
  cursor: string | null;
  event_seq: number;
}
export interface TaskGraphReadOptions {
  revision?: string;
  cursor?: string;
  limit?: number;
}
export interface TaskGraphPatch {
  session_id: string;
  plan_id: string;
  graph_revision: string;
  previous_graph_revision: string | null;
  entity_changes: Array<
    | { type: "upsert"; task_id: string; node: TaskGraphNode }
    | { type: "remove"; task_id: string }
  >;
  edges: Array<{ from: string; to: string }>;
  title: string;
  state: TaskGraphState;
  updated_at: string;
  counts: TaskGraphCounts;
  event_seq: number;
  /** First snapshot or reconciliation; otherwise patch when previous revision matches. */
  refetch: boolean;
  phase: TaskGraphPhase;
  work_state: TaskGraphSummary["work_state"];
  node_order: string[];
  removed?: false;
}
export interface TaskGraphRemoved {
  session_id: string;
  plan_id: string;
  graph_revision: string;
  previous_graph_revision: string;
  event_seq: number;
  removed: true;
  refetch: false;
}
export type TaskGraphChanged = TaskGraphPatch | TaskGraphRemoved;
export interface TaskGraphDocument extends ProjectDashboardDocument {
  kind: "plan";
  document_type: "task";
  source_label: string;
  spec_ref: string | null;
}
