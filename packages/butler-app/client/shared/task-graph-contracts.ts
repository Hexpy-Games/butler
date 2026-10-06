import type { ProjectDashboardDocument } from "./dashboard-space-contracts.ts";

export type TaskGraphStatus = "pending" | "running" | "in_review" | "completed" | "failed" | "blocked" | "paused" | "cancelled";
export type TaskGraphState = "running" | "failed" | "waiting" | "done" | "cancelled";
export interface TaskGraphCounts {
  total: number;
  completed: number;
  running: number;
  failed: number;
  blocked: number;
  cancelled: number;
}
export interface TaskDocumentRef {
  id: string;
  revision: string;
  title: string;
  status: TaskGraphStatus;
  source_label: string;
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
  document: TaskDocumentRef;
}
export interface TaskGraphSummary {
  graph_id: string;
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
export interface TaskGraphChanged {
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
}
export interface TaskGraphDocument extends ProjectDashboardDocument {
  kind: "plan";
  document_type: "task";
  source_label: string;
  spec_ref: string | null;
}
