export type WorkStatusState =
  | "running"
  | "completed"
  | "attention"
  | "operational_action"
  | "operational_interruption";

export type WorkStatusStage =
  | "conception"
  | "planning"
  | "execution"
  | "review"
  | "validation"
  | "reporting";

export interface WorkStatusItemView {
  /** Navigation identity only. The UI must not render this value. */
  session_id: string;
  safe_title: string;
  safe_summary: string;
  state: WorkStatusState;
  stage?: WorkStatusStage;
  completed_actions: number;
  total_actions: number;
  effect_count: number;
  updated_at: string;
}

export interface WorkStatusView {
  items: WorkStatusItemView[];
  counts: Record<WorkStatusState, number>;
}
