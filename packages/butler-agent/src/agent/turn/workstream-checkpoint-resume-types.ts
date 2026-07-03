import type { WorkStreamState } from "../work/work-stream.ts";
import type { DirectTurnBudgetSnapshot } from "./direct-turn-budget.ts";

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
  chatId: string | null;
  originatingTurnId: string | null;
  userMessageId: string | null;
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
  evidenceRefs: WorkStreamResumeRef[];
  validationRefs: WorkStreamResumeRef[];
  blocker: WorkStreamResumeBlocker | null;
  budgetSnapshot: DirectTurnBudgetSnapshot | null;
  latestCompletionReview: {
    status: string;
    observationId?: string;
  } | null;
  activeItems: Array<{
    id: string;
    label: string;
    status: string;
    phase: string | null;
  }>;
}

export interface WorkStreamResumeRef {
  kind: string;
  id: string;
  path?: string;
}

export interface WorkStreamResumeBlocker {
  kind: "user_action" | "system" | "completion_gap" | "budget";
  reason: string;
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
  code:
    | "missing_todo_list"
    | "missing_todo_record"
    | "no_active_todo_items"
    | "ledger_index_missing"
    | "ledger_index_invalid"
    | "ledger_linked_record_missing";
}

export interface WorkStreamResumeSelection {
  state: WorkStreamResumeSelectionState;
  reason: WorkStreamResumeSelectionReason;
  selected?: WorkStreamResumeCandidate;
  candidates: WorkStreamResumeCandidate[];
  blockers: WorkStreamResumeCandidate[];
  issues: WorkStreamResumeIssue[];
}
