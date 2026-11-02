import type { CanonStatus, EpicProgressSnapshot, CanonQueueMoveSelection } from "./canon-contracts";

export type CanonQueueOrigin = "user_message" | "schedule" | "detach";
export interface CanonQueueItem {
  epic_id: string;
  title: string;
  canon_status: CanonStatus;
  state: "waiting" | "running" | "held" | "done";
  hold_reason?: string;
  held_by_epic_id?: string;
  progress: EpicProgressSnapshot;
}
export interface CanonQueueView {
  session_id: string;
  graph_revision: number;
  plan: { id: string; title: string } | null;
  counts: { running: number; failed: number; held: number; waiting: number };
  chains: Array<{ chain_id: string; origin: CanonQueueOrigin; steps: Array<{ index: number; items: CanonQueueItem[] }> }>;
}
export type CanonQueueEdit = {
  expected_graph_revision: number;
  target_epic_id?: string;
  index?: number;
  target_chain_id?: string;
} & (
  | ({ op: "move_to_new_step" | "join_stack" | "move_between" } & CanonQueueMoveSelection)
  | { op: "split_stack" | "start_now" | "delete"; epic_id: string; epic_ids?: never }
);
export interface CanonQueueChanged { session_id: string; graph_revision: number }
export interface CanonQueueConflict { graph_revision: number }
export type CanonHoldDecision = "delete" | "continue";
export interface CanonHoldPanel {
  kind: "canon_hold";
  session_id: string;
  epic_id: string;
  epic_title: string;
  /** `resolved`: the reply to an unfinished step closed its Work. */
  state: "pending" | "deleted" | "continued" | "resolved";
}
export interface CanonTakeHerePanel {
  kind: "canon_take_here";
  session_id: string;
  epic_id: string;
  epic_title: string;
  other_session_id: string;
  state: "pending" | "taken" | "deleted";
}
export interface CanonStepOrigin {
  kind: "canon_step";
  plan_title: string;
  epic_title: string;
  epic_id: string;
}
