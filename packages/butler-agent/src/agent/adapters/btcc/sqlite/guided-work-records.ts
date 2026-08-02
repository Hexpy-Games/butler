import type {
  DurableWorkCheckpoint,
  DurableWorkReview,
  DurableWorkToolResultRef,
  DurableWorkView,
} from "../../../btcc/durable-work/index.ts";

export type GuidedWorkRow = {
  work_id: string;
  session_id: string;
  scope_kind: "session" | "project";
  scope_ref: string;
  origin_turn_id: string;
  origin_message_id: string;
  objective: string;
  status: DurableWorkView["status"];
  current_plan_revision_id: string | null;
  created_at: string;
  updated_at: string;
};

export type GuidedWorkTurn = {
  turn_id: string;
  session_id: string;
  original_message_id: string;
  original_message: string;
};

export type GuidedWorkPlanRow = {
  plan_revision_id: string;
  revision: number;
  objective: string;
  governing_refs_json: string;
  actions_json: string;
  checks_json: string;
  origin_turn_id: string;
  created_at: string;
};

export type GuidedWorkCheckpointRow = {
  checkpoint_revision_id: string;
  revision: number;
  plan_revision_id: string | null;
  stage: DurableWorkCheckpoint["stage"];
  public_summary: string;
  next_step: string;
  action_states_json: string;
  result_sequence: number;
  origin_turn_id: string;
  created_at: string;
};

export type GuidedWorkReviewRow = {
  review_revision_id: string;
  revision: number;
  subject: DurableWorkReview["subject"];
  verdict: DurableWorkReview["verdict"];
  summary: string;
  corrections_json: string;
  bound_plan_revision_id: string | null;
  bound_result_sequence: number | null;
  origin_turn_id: string;
  created_at: string;
};

export type GuidedWorkResultRow = {
  result_ref: string;
  sequence: number;
  tool_call_id: string;
  tool_name: string;
  status: DurableWorkToolResultRef["status"];
  result_json: string | null;
  result_sha256: string | null;
  error_code: string | null;
  origin_turn_id: string;
  attached_at: string;
};
