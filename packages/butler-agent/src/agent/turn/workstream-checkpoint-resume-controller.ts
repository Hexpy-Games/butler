import {
  WorkStreamStore,
  type WorkStreamRecord,
  type WorkStreamState,
  workStreamResumable,
} from "../work/work-stream.ts";
import { checkpointForRecord } from "./workstream-checkpoint-hydration.ts";
import type {
  WorkStreamResumeCandidate,
  WorkStreamResumeIssue,
  WorkStreamResumeSelection,
  WorkStreamResumeSelectionReason,
  WorkStreamResumeSelectionState,
} from "./workstream-checkpoint-resume-types.ts";

interface StructuredResumeControl {
  action: "resume" | "cancel" | "new_objective" | "user_action_supplied";
  workStreamId?: string;
  userActionSupplied: boolean;
}

const ACTIVE_SELECTION_STATES = new Set<WorkStreamState>([
  "routing",
  "conception",
  "planning",
  "executing",
  "reviewing",
  "consolidating",
  "reporting",
]);

export function selectWorkStreamCheckpointResume(input: {
  butlerData: string;
  sessionId: string;
  chatId?: string | null;
  projectId?: string | null;
  currentTurnId?: string | null;
  turnMetadata?: Record<string, unknown>;
  userText?: string;
}): WorkStreamResumeSelection {
  void input.userText;
  void input.currentTurnId;
  const control = structuredResumeControl(input.turnMetadata);
  if (control?.action === "cancel") {
    return emptySelection("cancel_selected", "explicit_cancel");
  }
  if (control?.action === "new_objective") {
    return emptySelection("cancel_selected", "explicit_new_objective");
  }
  const forceRuntimeResume = shouldForceRuntimeResume(input.turnMetadata, control);

  const scanned = scanCandidates({
    butlerData: input.butlerData,
    sessionId: input.sessionId,
    chatId: input.chatId,
    projectId: input.projectId,
    includeWaitingUser: forceRuntimeResume ? control?.userActionSupplied === true : true,
  });
  const candidates = scanned.candidates;

  if (control?.workStreamId) {
    const selected = candidates.find((candidate) => candidate.id === control.workStreamId);
    if (selected) return selectedSelection(selected, candidates, scanned, "explicit_target");
    const blocked = scanned.blockers.find((candidate) => candidate.id === control.workStreamId);
    if (blocked) {
      return {
        state: "resume_blocked_user_action",
        reason: "waiting_user_action_required",
        candidates,
        blockers: [blocked],
        issues: scanned.issues,
      };
    }
    const explicitIssue = scanned.issues.find((issue) => issue.workStreamId === control.workStreamId);
    if (explicitIssue) {
      return {
        state: "resume_blocked_system",
        reason: "explicit_target_corrupted",
        candidates,
        blockers: scanned.blockers,
        issues: [explicitIssue],
      };
    }
    return {
      state: "resume_conflict",
      reason: "explicit_target_missing",
      candidates,
      blockers: scanned.blockers,
      issues: scanned.issues,
    };
  }

  if (candidates.length === 0) {
    if (scanned.blockers.length > 0) {
      return {
        state: "resume_blocked_user_action",
        reason: "waiting_user_action_required",
        candidates,
        blockers: scanned.blockers,
        issues: scanned.issues,
      };
    }
    if (scanned.issues.length > 0) {
      return {
        state: "resume_blocked_system",
        reason: "no_valid_checkpoint",
        candidates,
        blockers: [],
        issues: scanned.issues,
      };
    }
    return {
      state: "fresh_turn",
      reason: "no_candidates",
      candidates,
      blockers: [],
      issues: scanned.issues,
    };
  }

  if (!forceRuntimeResume) {
    return candidateSelection(candidates, scanned);
  }

  if (candidates.length === 1) {
    return selectedSelection(candidates[0]!, candidates, scanned, "sole_candidate");
  }

  const active = candidates.filter((candidate) => ACTIVE_SELECTION_STATES.has(candidate.state));
  if (active.length === 1) {
    return selectedSelection(active[0]!, candidates, scanned, "current_active_workstream");
  }

  const sorted = sortCandidates(candidates);
  const first = sorted[0]!;
  const second = sorted[1];
  if (second && first.updatedAt === second.updatedAt) {
    return {
      state: "resume_conflict",
      reason: "equal_priority_candidates",
      candidates,
      blockers: scanned.blockers,
      issues: scanned.issues,
    };
  }
  return selectedSelection(first, candidates, scanned, "latest_updated_at");
}

function scanCandidates(input: {
  butlerData: string;
  sessionId: string;
  chatId?: string | null;
  projectId?: string | null;
  includeWaitingUser: boolean;
}): {
  candidates: WorkStreamResumeCandidate[];
  blockers: WorkStreamResumeCandidate[];
  issues: WorkStreamResumeIssue[];
} {
  const store = new WorkStreamStore(input.butlerData);
  const records = store.list({
    sessionId: input.sessionId,
    projectId: input.projectId,
  }).map((summary) => store.read(summary.id))
    .filter((record): record is WorkStreamRecord => Boolean(record))
    .filter((record) => workStreamChatMatches(record, input.chatId))
    .filter((record) => workStreamResumable(record));
  const candidates: WorkStreamResumeCandidate[] = [];
  const blockers: WorkStreamResumeCandidate[] = [];
  const issues: WorkStreamResumeIssue[] = [];
  for (const record of records) {
    const checkpoint = checkpointForRecord({
      butlerData: input.butlerData,
      record,
    });
    if (!checkpoint.ok) {
      issues.push({
        workStreamId: record.id,
        code: checkpoint.code,
      });
      continue;
    }
    const candidate = {
      id: record.id,
      state: record.state,
      projectId: record.project_id,
      todoListId: record.todo_list_id,
      updatedAt: record.updated_at,
      checkpoint: checkpoint.value,
    };
    if (record.state === "waiting_user" && !input.includeWaitingUser) {
      blockers.push(candidate);
      continue;
    }
    candidates.push(candidate);
  }
  return {
    candidates: sortCandidates(candidates),
    blockers: sortCandidates(blockers),
    issues,
  };
}

function workStreamChatMatches(
  record: WorkStreamRecord,
  chatId?: string | null,
): boolean {
  const currentChatId = chatId?.trim();
  const originChatId = record.origin_chat_id?.trim();
  if (!currentChatId) return true;
  return originChatId === currentChatId;
}

function structuredResumeControl(
  metadata?: Record<string, unknown>,
): StructuredResumeControl | null {
  const raw = metadata?.workstreamResume;
  if (!raw || typeof raw !== "object") return null;
  const action = (raw as { action?: unknown }).action;
  if (
    action !== "resume" &&
    action !== "cancel" &&
    action !== "new_objective" &&
    action !== "user_action_supplied"
  ) {
    return null;
  }
  const workStreamId = safeStructuredId((raw as { workStreamId?: unknown }).workStreamId);
  return {
    action,
    ...(workStreamId ? { workStreamId } : {}),
    userActionSupplied: action === "user_action_supplied" ||
      (raw as { userActionSupplied?: unknown }).userActionSupplied === true,
  };
}

function shouldForceRuntimeResume(
  metadata: Record<string, unknown> | undefined,
  control: StructuredResumeControl | null,
): boolean {
  if (control?.action === "resume" || control?.action === "user_action_supplied") {
    return true;
  }
  const schedulerContinuation = metadata?.schedulerContinuation;
  return Boolean(schedulerContinuation && typeof schedulerContinuation === "object");
}

function safeStructuredId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return /^[A-Za-z0-9._:-]{1,120}$/.test(trimmed) ? trimmed : undefined;
}

function sortCandidates<T extends { updatedAt: string; id: string }>(candidates: T[]): T[] {
  return [...candidates].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
  );
}

function selectedSelection(
  selected: WorkStreamResumeCandidate,
  candidates: WorkStreamResumeCandidate[],
  scanned: { blockers: WorkStreamResumeCandidate[]; issues: WorkStreamResumeIssue[] },
  reason: WorkStreamResumeSelectionReason,
): WorkStreamResumeSelection {
  return {
    state: "resume_selected",
    reason,
    selected,
    candidates,
    blockers: scanned.blockers,
    issues: scanned.issues,
  };
}

function candidateSelection(
  candidates: WorkStreamResumeCandidate[],
  scanned: { blockers: WorkStreamResumeCandidate[]; issues: WorkStreamResumeIssue[] },
): WorkStreamResumeSelection {
  return {
    state: "resume_candidate_presented",
    reason: "model_decision_required",
    candidates,
    blockers: scanned.blockers,
    issues: scanned.issues,
  };
}

function emptySelection(
  state: WorkStreamResumeSelectionState,
  reason: WorkStreamResumeSelectionReason,
): WorkStreamResumeSelection {
  return {
    state,
    reason,
    candidates: [],
    blockers: [],
    issues: [],
  };
}
