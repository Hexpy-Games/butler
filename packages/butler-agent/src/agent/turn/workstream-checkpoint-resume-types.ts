import type { WorkStreamState } from "../work/work-stream.ts";

export type WorkStreamResumeSelectionState =
  | "fresh_turn"
  | "resume_selected"
  | "resume_conflict"
  | "resume_blocked_user_action"
  | "resume_blocked_system"
  | "cancel_selected";

export type WorkStreamResumeSelectionReason =
  | "no_candidates"
  | "no_valid_checkpoint"
  | "explicit_cancel"
  | "explicit_new_objective"
  | "explicit_target"
  | "sole_candidate"
  | "current_active_workstream"
  | "latest_updated_at"
  | "equal_priority_candidates"
  | "waiting_user_action_required"
  | "explicit_target_missing"
  | "explicit_target_corrupted";

export interface WorkStreamResumeCheckpoint {
  checkpointId: string;
  workStreamId: string;
  sessionId: string;
  projectId: string | null;
  todoListId: string;
  state: WorkStreamState;
  currentPhase: string | null;
  activeStepId: string | null;
  updatedAt: string;
  title: string;
  statusNote: string | null;
  linkedPlannedTaskIds: string[];
  linkedOrchestrationIds: string[];
  linkedWorkerTaskIds: string[];
  activeItems: Array<{
    id: string;
    label: string;
    status: string;
    phase: string | null;
  }>;
}

export interface WorkStreamResumeCandidate {
  id: string;
  state: WorkStreamState;
  projectId: string | null;
  todoListId: string | null;
  updatedAt: string;
  checkpoint: WorkStreamResumeCheckpoint;
}

export interface WorkStreamResumeIssue {
  workStreamId: string;
  code: "missing_todo_list" | "missing_todo_record" | "no_active_todo_items";
}

export interface WorkStreamResumeSelection {
  state: WorkStreamResumeSelectionState;
  reason: WorkStreamResumeSelectionReason;
  selected?: WorkStreamResumeCandidate;
  candidates: WorkStreamResumeCandidate[];
  blockers: WorkStreamResumeCandidate[];
  issues: WorkStreamResumeIssue[];
}
