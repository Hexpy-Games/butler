import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { TodoListStore, type TodoItem } from "../work/todo-list.ts";
import type { WorkStreamRecord } from "../work/work-stream.ts";
import {
  readTurnContextAtom,
  type TurnContextAtom,
  type TurnContextObservationRef,
} from "./turn-continuation-context.ts";
import type {
  WorkStreamResumeBlocker,
  WorkStreamResumeCheckpoint,
  WorkStreamResumeIssue,
  WorkStreamResumeRef,
} from "./workstream-checkpoint-resume-types.ts";

export function checkpointForRecord(input: {
  butlerData: string;
  record: WorkStreamRecord;
}): { ok: true; value: WorkStreamResumeCheckpoint } | { ok: false; code: WorkStreamResumeIssue["code"] } {
  const record = input.record;
  if (!record.todo_list_id) return { ok: false, code: "missing_todo_list" };

  const ledgerIssue = validateLinkedLedgerRecords({
    butlerData: input.butlerData,
    record,
  });
  if (ledgerIssue) return { ok: false, code: ledgerIssue };

  const todo = new TodoListStore(input.butlerData).read(record.todo_list_id);
  if (!todo) return { ok: false, code: "missing_todo_record" };
  const activeItems = activeCheckpointItems(todo.items);
  if (activeItems.length === 0 && record.state !== "reporting") {
    return { ok: false, code: "no_active_todo_items" };
  }

  const atom = originTurnAtom({
    butlerData: input.butlerData,
    sessionId: record.owner_session_id,
    turnId: record.last_user_turn_id,
  });

  return {
    ok: true,
    value: {
      checkpointId: `workstream:${record.id}:${record.updated_at}`,
      workStreamId: record.id,
      sessionId: record.owner_session_id ?? "",
      chatId: safeCheckpointId(record.origin_chat_id),
      originatingTurnId: safeCheckpointId(record.last_user_turn_id),
      userMessageId: safeCheckpointId(atom?.userRequest.id),
      projectId: record.project_id,
      todoListId: record.todo_list_id,
      state: record.state,
      currentPhase: record.current_phase,
      activeStepId: record.active_step_id,
      updatedAt: record.updated_at,
      title: record.title,
      statusNote: record.status_note,
      linkedPlannedTaskIds: record.linked_planned_task_ids,
      linkedOrchestrationIds: record.linked_orchestration_ids,
      linkedWorkerTaskIds: record.linked_worker_task_ids,
      evidenceRefs: evidenceRefsFor(record, atom),
      validationRefs: validationRefsFor(atom),
      blocker: blockerFor(record, atom),
      budgetSnapshot: atom?.budgetSnapshot ?? null,
      latestCompletionReview: atom?.latestCompletionReview ?? null,
      activeItems,
    },
  };
}

function activeCheckpointItems(items: TodoItem[]): WorkStreamResumeCheckpoint["activeItems"] {
  return items
    .filter((item) => item.status === "pending" || item.status === "in_progress")
    .slice(0, 8)
    .map((item) => ({
      id: item.id,
      label: item.status === "in_progress" ? item.active_form : item.content,
      status: item.status,
      phase: item.phase,
    }));
}

function validateLinkedLedgerRecords(input: {
  butlerData: string;
  record: WorkStreamRecord;
}): WorkStreamResumeIssue["code"] | null {
  const wanted = input.record.linked_planned_task_ids
    .map((id) => id.trim())
    .filter(Boolean);
  if (wanted.length === 0) return null;
  const projectId = input.record.project_id?.trim();
  if (!projectId || !/^[A-Za-z0-9._:-]{1,120}$/.test(projectId)) {
    return "ledger_index_missing";
  }
  const indexPath = join(input.butlerData, "project-ledger", "projects", projectId, "index", "project.json");
  if (!existsSync(indexPath)) return "ledger_index_missing";
  try {
    const parsed = JSON.parse(readFileSync(indexPath, "utf8")) as { records?: unknown };
    if (!Array.isArray(parsed.records)) return "ledger_index_invalid";
    const present = new Set(parsed.records
      .map((record) => safeRecordId(record))
      .filter((id): id is string => Boolean(id)));
    return wanted.every((id) => present.has(id))
      ? null
      : "ledger_linked_record_missing";
  } catch {
    return "ledger_index_invalid";
  }
}

function originTurnAtom(input: {
  butlerData: string;
  sessionId: string | null;
  turnId: string | null;
}): TurnContextAtom | null {
  if (!input.sessionId || !input.turnId) return null;
  return readTurnContextAtom({
    butlerData: input.butlerData,
    sessionId: input.sessionId,
    turnId: input.turnId,
  });
}

function evidenceRefsFor(
  record: WorkStreamRecord,
  atom: TurnContextAtom | null,
): WorkStreamResumeRef[] {
  return uniqueRefs([
    ref("workstream", record.id),
    ref("todo_list", record.todo_list_id),
    ...record.linked_planned_task_ids.map((id) => ref("project_ledger_task", id)),
    ...record.linked_orchestration_ids.map((id) => ref("orchestration", id)),
    ...record.linked_worker_task_ids.map((id) => ref("worker_task", id)),
    ...(atom?.openToolPairs ?? []).map(refFromObservation),
    ...(atom?.currentTurnWork ?? []).map(refFromObservation),
    ...(atom?.currentTurnTodos ?? []).map(refFromObservation),
    atom?.latestAssistantDecision ? ref("assistant_decision", atom.latestAssistantDecision.id) : null,
  ]);
}

function validationRefsFor(atom: TurnContextAtom | null): WorkStreamResumeRef[] {
  if (!atom) return [];
  return uniqueRefs([
    atom.latestCompletionReview?.observationId
      ? ref("completion_review", atom.latestCompletionReview.observationId)
      : null,
    ...atom.unresolvedObservations
      .filter((observation) =>
        /validation|completion|review|test|budget|blocker/u.test(observation.kind),
      )
      .map(refFromObservation),
  ]);
}

function blockerFor(
  record: WorkStreamRecord,
  atom: TurnContextAtom | null,
): WorkStreamResumeBlocker | null {
  if (record.state === "waiting_user") {
    return {
      kind: "user_action",
      reason: safeReason(record.status_note) ?? "waiting_user",
    };
  }
  if (atom?.sourceErrorCode === "prompt_usage_model_call_budget_exhausted") {
    return { kind: "budget", reason: atom.sourceErrorCode };
  }
  if (atom?.latestCompletionReview && atom.latestCompletionReview.status !== "complete") {
    return {
      kind: "completion_gap",
      reason: safeReason(atom.latestCompletionReview.status) ?? "completion_gap",
    };
  }
  return null;
}

function ref(kind: string, id: string | null | undefined): WorkStreamResumeRef | null {
  const safeKind = safeRefPart(kind);
  const safeId = safeCheckpointId(id);
  if (!safeKind || !safeId) return null;
  return { kind: safeKind, id: safeId };
}

function refFromObservation(observation: TurnContextObservationRef): WorkStreamResumeRef | null {
  const next = ref(observation.kind, observation.id);
  if (!next) return null;
  const path = safeObservationPath(observation.path);
  return path ? { ...next, path } : next;
}

function uniqueRefs(values: Array<WorkStreamResumeRef | null>): WorkStreamResumeRef[] {
  const seen = new Set<string>();
  const refs: WorkStreamResumeRef[] = [];
  for (const value of values) {
    if (!value) continue;
    const key = `${value.kind}:${value.id}:${value.path ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(value);
    if (refs.length >= 24) break;
  }
  return refs;
}

function safeRecordId(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return safeCheckpointId((value as { id?: unknown }).id);
}

function safeCheckpointId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/gu, " ").trim();
  return /^[A-Za-z0-9._:/-]{1,180}$/u.test(trimmed) ? trimmed : null;
}

function safeRefPart(value: string): string | null {
  const trimmed = value.trim();
  return /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/u.test(trimmed) ? trimmed : null;
}

function safeObservationPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 240) return undefined;
  return /^[A-Za-z0-9._~:/ -]+$/u.test(trimmed) ? trimmed : undefined;
}

function safeReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/gu, " ").trim();
  return /^[A-Za-z0-9_.:/ -]{1,160}$/u.test(trimmed) ? trimmed : null;
}
