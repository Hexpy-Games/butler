import { createHash } from "crypto";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { TodoListStore, type TodoItem, type TodoItemInput, type TodoPhase, type TodoStatus } from "./todo-list.ts";
import {
  commitWorkStreamMutation,
  type WorkStreamMutationOperation,
  withWorkStreamMutationAuthority,
} from "./work-stream-mutation-authority.ts";
import {
  deferredWorkStreamProjection,
  hasDeferredWorkStreamRecovery,
  reconcilePendingWorkStreamTransactions,
} from "./work-stream-transaction-recovery.ts";
import {
  completeReportingWorkStreamForSessionWithAuthority,
  type ReportingCompletionFault,
} from "./work-stream-reporting-store.ts";

export type WorkStreamState =
  | "routing"
  | "conception"
  | "planning"
  | "executing"
  | "reviewing"
  | "consolidating"
  | "reporting"
  | "waiting_user"
  | "paused"
  | "complete"
  | "failed"
  | "recoverable"
  | "cancelled";

export type WorkStreamPhase =
  | "conception"
  | "planning"
  | "execution"
  | "review"
  | "consolidation"
  | "reporting";

export type TurnLocalWorkOutcome =
  | "completed"
  | "failed"
  | "cancelled"
  | "recoverable"
  | "waiting_user";

export interface WorkStreamRecord {
  version: 1;
  id: string;
  title: string;
  owner_session_id: string | null;
  origin_chat_id?: string | null;
  project_id: string | null;
  intent_summary: string | null;
  role_hint: string | null;
  expected_deliverable: string | null;
  state: WorkStreamState;
  current_phase: WorkStreamPhase | null;
  active_step_id: string | null;
  todo_list_id: string | null;
  linked_planned_task_ids: string[];
  linked_orchestration_ids: string[];
  linked_worker_task_ids: string[];
  created_at: string;
  updated_at: string;
  last_user_turn_id: string | null;
  status_note: string | null;
  /** Optional v1 additions; absent fields are normalized for historical records. */
  record_generation?: number;
  active_contract_id?: string | null;
  claim_generation?: number | null;
  claim_lease_expires_at?: string | null;
  active_claim_receipt_id?: string | null;
  original_claim_receipt_id?: string | null;
  active_blocker_id?: string | null;
  active_blocker_evidence_id?: string | null;
  plan_revision?: number;
  plan_revision_receipt_id?: string | null;
  superseded_todo_ids?: string[];
}

export interface WorkStreamSummary {
  id: string;
  title: string;
  owner_session_id: string | null;
  project_id: string | null;
  state: WorkStreamState;
  current_phase: WorkStreamPhase | null;
  active_step_id: string | null;
  todo_list_id: string | null;
  terminal: boolean;
  updated_at: string;
}

const STATE_VALUES: WorkStreamState[] = [
  "routing",
  "conception",
  "planning",
  "executing",
  "reviewing",
  "consolidating",
  "reporting",
  "waiting_user",
  "paused",
  "complete",
  "failed",
  "recoverable",
  "cancelled",
];

const TERMINAL_STATES = new Set<WorkStreamState>(["complete", "failed", "cancelled"]);
const ACTIVE_STATES = new Set<WorkStreamState>([
  "routing",
  "conception",
  "planning",
  "executing",
  "reviewing",
  "consolidating",
  "reporting",
]);
const RESUMABLE_STATES = new Set<WorkStreamState>([
  ...ACTIVE_STATES,
  "waiting_user",
  "paused",
  "recoverable",
]);

const TRANSITIONS: Record<WorkStreamState, WorkStreamState[]> = {
  routing: ["conception", "planning", "waiting_user", "recoverable", "failed", "cancelled"],
  conception: ["planning", "waiting_user", "paused", "recoverable", "failed", "cancelled"],
  planning: ["executing", "waiting_user", "paused", "recoverable", "failed", "cancelled"],
  executing: ["reviewing", "waiting_user", "paused", "recoverable", "failed", "cancelled"],
  reviewing: ["executing", "consolidating", "waiting_user", "paused", "recoverable", "failed", "cancelled"],
  consolidating: ["reporting", "reviewing", "recoverable", "failed", "cancelled"],
  reporting: ["complete", "reviewing", "recoverable", "failed", "cancelled"],
  waiting_user: ["planning", "executing", "reviewing", "paused", "failed", "cancelled"],
  paused: ["planning", "executing", "reviewing", "failed", "cancelled"],
  complete: [],
  failed: ["recoverable"],
  recoverable: ["executing", "reviewing", "failed", "cancelled"],
  cancelled: [],
};

const PHASE_TO_STATE: Record<WorkStreamPhase, WorkStreamState> = {
  conception: "conception",
  planning: "planning",
  execution: "executing",
  review: "reviewing",
  consolidation: "consolidating",
  reporting: "reporting",
};

const TODO_PHASE_TO_WORK_PHASE: Record<TodoPhase, WorkStreamPhase> = {
  conception: "conception",
  planning: "planning",
  execution: "execution",
  review: "review",
  consolidation: "consolidation",
  reporting: "reporting",
};

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function safeId(value: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(trimmed)) {
    throw new Error("work stream id must be 1-120 safe characters");
  }
  return trimmed;
}

function safeOptionalId(value?: string | null): string | null {
  if (!value?.trim()) return null;
  return safeId(value);
}

function safeText(value: string | null | undefined, limit: number): string | null {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length > limit ? normalized.slice(0, limit) : normalized;
}

function stableStreamId(input: {
  ownerSessionId?: string | null;
  originChatId?: string | null;
  projectId?: string | null;
  listId?: string | null;
}): string {
  const digest = createHash("sha1")
    .update(`${input.ownerSessionId ?? ""}\n${input.originChatId ?? ""}\n${input.projectId ?? ""}\n${input.listId ?? "main"}`)
    .digest("hex")
    .slice(0, 16);
  return `ws-${digest}`;
}

function revisionStreamId(baseId: string, now: string): string {
  const suffix = createHash("sha1")
    .update(`${baseId}\n${now}`)
    .digest("hex")
    .slice(0, 8);
  return `${baseId.slice(0, 111)}-${suffix}`;
}

function normalizeState(value: unknown): WorkStreamState {
  if (STATE_VALUES.includes(value as WorkStreamState)) return value as WorkStreamState;
  throw new Error(`unsupported work stream state: ${String(value)}`);
}

function phaseForState(state: WorkStreamState, prior: WorkStreamPhase | null): WorkStreamPhase | null {
  if (state === "conception") return "conception";
  if (state === "planning") return "planning";
  if (state === "executing") return "execution";
  if (state === "reviewing") return "review";
  if (state === "consolidating") return "consolidation";
  if (state === "reporting") return "reporting";
  if (state === "routing" || state === "complete" || state === "failed" || state === "cancelled") return null;
  return prior;
}

export function workStreamTerminal(state: WorkStreamState): boolean {
  return TERMINAL_STATES.has(state);
}

export function workStreamActive(
  record: Pick<WorkStreamRecord, "state" | "last_user_turn_id">,
  options: { currentTurnId?: string | null } = {},
): boolean {
  if (ACTIVE_STATES.has(record.state)) return true;
  const currentTurnId = options.currentTurnId?.trim();
  return Boolean(
    currentTurnId &&
    record.state === "waiting_user" &&
    record.last_user_turn_id === currentTurnId,
  );
}

export function workStreamResumable(
  record: Pick<WorkStreamRecord, "state">,
): boolean {
  return RESUMABLE_STATES.has(record.state);
}

export function completeReportingWorkStreamForSession(input: {
  butlerData: string;
  sessionId: string;
  statusNote?: string | null;
  now?: Date;
  faultAt?: ReportingCompletionFault;
}): WorkStreamRecord | null {
  reconcilePendingWorkStreamTransactions({ butlerData: input.butlerData });
  return completeReportingWorkStreamForSessionWithAuthority(input);
}

export function completeTurnLocalWorkStreamForSession(input: {
  butlerData: string;
  sessionId: string;
  statusNote?: string | null;
  now?: Date;
}): WorkStreamRecord | null {
  const store = new WorkStreamStore(input.butlerData);
  return store.completeTurnLocalActive({
    sessionId: input.sessionId,
    statusNote: input.statusNote ?? "Final answer delivered.",
    now: input.now,
  });
}

export function applyTurnLocalWorkOutcomeForSession(input: {
  butlerData: string;
  sessionId: string;
  turnId?: string | null;
  outcome: TurnLocalWorkOutcome;
  statusNote?: string | null;
  now?: Date;
}): WorkStreamRecord[] {
  return new WorkStreamStore(input.butlerData).applyTurnLocalOutcome({
    sessionId: input.sessionId,
    turnId: input.turnId,
    outcome: input.outcome,
    statusNote: input.statusNote,
    now: input.now,
  });
}

function todoItemInput(item: TodoItem): TodoItemInput {
  return {
    id: item.id,
    content: item.content,
    active_form: item.active_form,
    status: item.status,
    phase: item.phase ?? undefined,
    priority: item.priority,
    blocked_by: item.blocked_by,
    note: item.note ?? undefined,
  };
}

function completeReportingTodoStep(input: {
  butlerData: string;
  listId?: string | null;
  activeStepId?: string | null;
  statusNote?: string | null;
  now?: Date;
}): void {
  if (!input.listId) return;
  const todoStore = new TodoListStore(input.butlerData, { autoRecover: false });
  const record = todoStore.read(input.listId);
  if (!record) return;
  let changed = false;
  const items = record.items.map((item) => {
    const isActiveReporting =
      item.status === "in_progress" &&
      item.phase === "reporting" &&
      (!input.activeStepId || item.id === input.activeStepId);
    if (!isActiveReporting) return todoItemInput(item);
    changed = true;
    return {
      ...todoItemInput(item),
      status: "completed" as const,
      note: item.note ?? input.statusNote ?? undefined,
    };
  });
  if (!changed) return;
  todoStore.update({
    listId: record.list_id,
    title: record.title,
    items,
    now: input.now,
  });
}

export function assertWorkStreamTransition(from: WorkStreamState, to: WorkStreamState): void {
  if (from === to) return;
  normalizeState(to);
  if (!TRANSITIONS[from].includes(to)) {
    throw new Error(`invalid work stream transition ${from} -> ${to}`);
  }
}

function transitionPath(from: WorkStreamState, to: WorkStreamState): WorkStreamState[] | null {
  if (from === to) return [from];
  const queue: Array<{ state: WorkStreamState; path: WorkStreamState[] }> = [{ state: from, path: [from] }];
  const visited = new Set<WorkStreamState>([from]);
  for (const item of queue) {
    for (const next of TRANSITIONS[item.state]) {
      if (visited.has(next)) continue;
      const path = [...item.path, next];
      if (next === to) return path;
      visited.add(next);
      queue.push({ state: next, path });
    }
  }
  return null;
}

function lastCompletedPhase(items: TodoItem[]): WorkStreamPhase | null {
  const phases = items
    .filter((item) => item.status === "completed" && item.phase)
    .map((item) => TODO_PHASE_TO_WORK_PHASE[item.phase!]);
  return phases.at(-1) ?? null;
}

function targetFromTodos(items: TodoItem[], prior?: WorkStreamRecord | null): {
  state: WorkStreamState;
  phase: WorkStreamPhase | null;
  activeStepId: string | null;
} {
  const active = items.find((item) => item.status === "in_progress");
  if (active?.phase) {
    const phase = TODO_PHASE_TO_WORK_PHASE[active.phase];
    return {
      state: PHASE_TO_STATE[phase],
      phase,
      activeStepId: active.id,
    };
  }

  if (items.length > 0 && items.every((item) => item.status === "completed" || item.status === "cancelled")) {
    const completedPhase = lastCompletedPhase(items);
    return {
      state: completedPhase === "reporting" ? "complete" : "reviewing",
      phase: completedPhase,
      activeStepId: null,
    };
  }

  return {
    state: prior?.state ?? "routing",
    phase: prior?.current_phase ?? null,
    activeStepId: prior?.active_step_id ?? null,
  };
}

function validateTodoEvidenceForTarget(items: TodoItem[], target: WorkStreamState): void {
  if (target === "complete" && !items.some((item) => item.phase === "reporting" && item.status === "completed")) {
    throw new Error("work stream completion requires a completed reporting step");
  }
}

function summary(record: WorkStreamRecord): WorkStreamSummary {
  return {
    id: record.id,
    title: record.title,
    owner_session_id: record.owner_session_id,
    project_id: record.project_id,
    state: record.state,
    current_phase: record.current_phase,
    active_step_id: record.active_step_id,
    todo_list_id: record.todo_list_id,
    terminal: workStreamTerminal(record.state),
    updated_at: record.updated_at,
  };
}

function uniqueAppend(existing: string[], values: string[] | undefined): string[] {
  const next = new Set(existing);
  for (const value of values ?? []) {
    const safe = safeOptionalId(value);
    if (safe) next.add(safe);
  }
  return Array.from(next).sort();
}

export class WorkStreamStore {
  readonly dir: string;
  private readonly autoRecover: boolean;

  constructor(readonly butlerData: string, options: { autoRecover?: boolean } = {}) {
    this.dir = join(butlerData, "work-streams");
    this.autoRecover = options.autoRecover !== false;
    if (this.autoRecover) reconcilePendingWorkStreamTransactions({ butlerData });
  }

  pathFor(id: string): string {
    return join(this.dir, `${safeId(id)}.json`);
  }

  read(id: string): WorkStreamRecord | null {
    if (this.autoRecover) {
      const recovery = reconcilePendingWorkStreamTransactions({ butlerData: this.butlerData, workstreamId: id });
      const projection = deferredWorkStreamProjection(recovery, id);
      if (projection) return normalizeContractFields(projection);
    }
    return this.readRaw(id);
  }

  private readRaw(id: string): WorkStreamRecord | null {
    const record = readJson<WorkStreamRecord>(this.pathFor(id));
    return record ? normalizeContractFields(record) : null;
  }

  private records(): WorkStreamRecord[] {
    const recovery = this.autoRecover
      ? reconcilePendingWorkStreamTransactions({ butlerData: this.butlerData })
      : [];
    const deferred = new Map<string, WorkStreamRecord>();
    for (const result of recovery) {
      if (result.status !== "deferred" || !result.projection) continue;
      const record = result.projection.workstream;
      const prior = deferred.get(record.id);
      if (!prior || (record.record_generation ?? 1) < (prior.record_generation ?? 1)) {
        deferred.set(record.id, record);
      }
    }
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => readJson<WorkStreamRecord>(join(this.dir, entry)))
      .filter((record): record is WorkStreamRecord => Boolean(record?.version === 1 && record.id))
      .map((record) => deferred.get(record.id) ?? record)
      .map(normalizeContractFields);
  }

  private activeForScope(input: {
    ownerSessionId?: string | null;
    originChatId?: string | null;
    projectId?: string | null;
    listId?: string | null;
    excludeId?: string | null;
    currentTurnId?: string | null;
  }): WorkStreamRecord | null {
    const ownerSessionId = input.ownerSessionId?.trim() || null;
    const originChatId = input.originChatId?.trim() || null;
    const projectId = input.projectId?.trim() || null;
    const listId = input.listId?.trim() || null;
    return this.records()
      .filter((record) => record.id !== input.excludeId)
      .filter((record) => workStreamActive(record, { currentTurnId: input.currentTurnId }))
      .filter((record) => !ownerSessionId || record.owner_session_id === ownerSessionId)
      .filter((record) => !originChatId || !record.origin_chat_id || record.origin_chat_id === originChatId)
      .filter((record) => !projectId || record.project_id === projectId)
      .filter((record) => !listId || record.todo_list_id === listId)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .at(0) ?? null;
  }

  list(options: {
    sessionId?: string | null;
    originChatId?: string | null;
    projectId?: string | null;
    includeTerminal?: boolean;
  } = {}): WorkStreamSummary[] {
    const originChatId = options.originChatId?.trim();
    return this.records()
      .filter((record) => !options.sessionId || record.owner_session_id === options.sessionId)
      .filter((record) => !originChatId || !record.origin_chat_id || record.origin_chat_id === originChatId)
      .filter((record) => !options.projectId || record.project_id === options.projectId)
      .filter((record) => options.includeTerminal === true || !workStreamTerminal(record.state))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .map(summary);
  }

  listActive(options: {
    sessionId?: string | null;
    projectId?: string | null;
    currentTurnId?: string | null;
  } = {}): WorkStreamSummary[] {
    return this.records()
      .filter((record) => !options.sessionId || record.owner_session_id === options.sessionId)
      .filter((record) => !options.projectId || record.project_id === options.projectId)
      .filter((record) => workStreamActive(record, { currentTurnId: options.currentTurnId }))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .map(summary);
  }

  recordsForTurn(turnId: string): WorkStreamRecord[] {
    const normalizedTurnId = turnId.trim();
    if (!normalizedTurnId) return [];
    return this.records()
      .filter((record) => record.last_user_turn_id === normalizedTurnId)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  linkedTo(input: {
    plannedTaskIds?: string[];
    orchestrationIds?: string[];
    workerTaskIds?: string[];
    includeTerminal?: boolean;
  }): WorkStreamRecord[] {
    const plannedTaskIds = new Set((input.plannedTaskIds ?? []).map(safeOptionalId).filter((id): id is string => Boolean(id)));
    const orchestrationIds = new Set((input.orchestrationIds ?? []).map(safeOptionalId).filter((id): id is string => Boolean(id)));
    const workerTaskIds = new Set((input.workerTaskIds ?? []).map(safeOptionalId).filter((id): id is string => Boolean(id)));
    if (plannedTaskIds.size === 0 && orchestrationIds.size === 0 && workerTaskIds.size === 0) return [];
    return this.records()
      .filter((record) => input.includeTerminal === true || !workStreamTerminal(record.state))
      .filter((record) =>
        record.linked_planned_task_ids.some((id) => plannedTaskIds.has(id)) ||
        record.linked_orchestration_ids.some((id) => orchestrationIds.has(id)) ||
        record.linked_worker_task_ids.some((id) => workerTaskIds.has(id)),
      )
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  applyTurnLocalOutcome(input: {
    sessionId?: string | null;
    turnId?: string | null;
    outcome: TurnLocalWorkOutcome;
    statusNote?: string | null;
    now?: Date;
  }): WorkStreamRecord[] {
    const sessionId = input.sessionId?.trim();
    if (!sessionId) return [];
    const turnId = input.turnId?.trim();
    const now = input.now ?? new Date();
    const todoStore = new TodoListStore(this.butlerData, { autoRecover: false });
    return this.records()
      .filter((record) => record.owner_session_id === sessionId)
      .filter((record) => !workStreamTerminal(record.state))
      .filter((record) => turnId ? record.last_user_turn_id === turnId : workStreamActive(record))
      .filter((record) => turnLocalOutcomeCanApply(record, input.outcome))
      .filter((record) => turnLocalOutcomeEligible(record))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .map((candidate) => this.withMutation(candidate.id, "legacy_outcome", (context, record) => {
        if (!record || workStreamTerminal(record.state) || record.owner_session_id !== sessionId) return null;
        if (turnId ? record.last_user_turn_id !== turnId : !workStreamActive(record)) return null;
        if (!turnLocalOutcomeCanApply(record, input.outcome) || !turnLocalOutcomeEligible(record)) return null;
        const todoRecord = record.todo_list_id ? todoStore.read(record.todo_list_id) : null;
        if (todoRecord) {
          todoStore.update({
            listId: todoRecord.list_id,
            title: todoRecord.title,
            items: todoRecord.items.map((item) => turnLocalOutcomeTodoItem(item, input.outcome)),
            now,
          });
        }
        const updated: WorkStreamRecord = {
          ...record,
          state: workStreamStateForTurnLocalOutcome(input.outcome),
          current_phase: turnLocalOutcomeCurrentPhase(record, input.outcome),
          active_step_id: turnLocalOutcomeActiveStepId(record, input.outcome),
          status_note: safeText(input.statusNote, 600) ?? turnLocalOutcomeStatusNote(input.outcome),
          record_generation: (record.record_generation ?? 1) + 1,
          updated_at: now.toISOString(),
        };
        return commitWorkStreamMutation({ butlerData: this.butlerData, context, record: updated, expectedGeneration: record.record_generation ?? 1 });
      }))
      .filter((record): record is WorkStreamRecord => Boolean(record));
  }

  cancelLinked(input: {
    workStreamIds?: string[];
    plannedTaskIds?: string[];
    orchestrationIds?: string[];
    workerTaskIds?: string[];
    statusNote?: string | null;
    now?: Date;
  }): WorkStreamRecord[] {
    const workStreamIds = new Set((input.workStreamIds ?? []).map(safeOptionalId).filter((id): id is string => Boolean(id)));
    const linked = this.linkedTo({
      plannedTaskIds: input.plannedTaskIds,
      orchestrationIds: input.orchestrationIds,
      workerTaskIds: input.workerTaskIds,
    });
    const records = new Map<string, WorkStreamRecord>();
    for (const id of workStreamIds) {
      const record = this.read(id);
      if (record && !workStreamTerminal(record.state)) records.set(record.id, record);
    }
    for (const record of linked) records.set(record.id, record);
    const now = (input.now ?? new Date()).toISOString();
    const statusNote = safeText(input.statusNote, 600) ?? "Cancelled by user request.";
    return Array.from(records.values()).flatMap((candidate) => {
      const committed = this.withMutation(candidate.id, "legacy_cancel", (context, record) => {
        if (!record || workStreamTerminal(record.state)) return null;
      const updated: WorkStreamRecord = {
        ...record,
        state: "cancelled",
        current_phase: null,
        active_step_id: null,
        status_note: statusNote,
        record_generation: (record.record_generation ?? 1) + 1,
        updated_at: now,
      };
        return commitWorkStreamMutation({ butlerData: this.butlerData, context, record: updated, expectedGeneration: record.record_generation ?? 1 });
      });
      return committed ? [committed] : [];
    });
  }

  activeForSession(
    sessionId?: string | null,
    options: { currentTurnId?: string | null } = {},
  ): WorkStreamRecord | null {
    if (!sessionId) return null;
    const active = this.listActive({ sessionId, currentTurnId: options.currentTurnId }).at(0);
    return active ? this.read(active.id) : null;
  }

  latestResumableForSession(
    sessionId?: string | null,
    options: { originChatId?: string | null; projectId?: string | null; excludeTodoListIds?: string[] } = {},
  ): WorkStreamRecord | null {
    if (!sessionId) return null;
    const originChatId = options.originChatId?.trim();
    const projectId = options.projectId?.trim();
    const excludedTodoListIds = new Set(options.excludeTodoListIds ?? []);
    const resumable = this.records()
      .filter((record) => record.owner_session_id === sessionId)
      .filter((record) => !originChatId || !record.origin_chat_id || record.origin_chat_id === originChatId)
      .filter((record) => !projectId || record.project_id === projectId)
      .filter((record) => workStreamResumable(record))
      .filter((record) => !record.todo_list_id || !excludedTodoListIds.has(record.todo_list_id))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .at(0);
    return resumable ? this.read(resumable.id) : null;
  }

  completeTurnLocalActive(input: {
    sessionId?: string | null;
    statusNote?: string | null;
    now?: Date;
  }): WorkStreamRecord | null {
    const selected = this.activeForSession(input.sessionId);
    if (!selected) return null;
    return this.withMutation(selected.id, "legacy_transition", (context, record) => {
      if (!record || workStreamTerminal(record.state)) return record;
      if (record.state === "waiting_user" || record.state === "paused" || record.state === "recoverable") return record;
      if (record.linked_planned_task_ids.length > 0 || record.linked_orchestration_ids.length > 0 || record.linked_worker_task_ids.length > 0) return record;
      const todoRecord = record.todo_list_id ? new TodoListStore(this.butlerData, { autoRecover: false }).read(record.todo_list_id) : null;
      if (!todoRecord && record.state !== "reporting") return record;
      const unfinishedCount = todoRecord?.items.filter((item) => item.status === "pending" || item.status === "in_progress").length ?? 0;
      const onlyReportingRemains = todoRecord?.items.every((item) =>
        item.status === "completed" || item.status === "cancelled" || (item.status === "in_progress" && item.phase === "reporting"),
      ) ?? record.state === "reporting";
      if (unfinishedCount > 0 && !onlyReportingRemains) return record;
      if (!transitionPath(record.state, "complete")) return record;
      completeReportingTodoStep({ butlerData: this.butlerData, listId: record.todo_list_id, activeStepId: record.active_step_id, statusNote: input.statusNote, now: input.now });
      const updated: WorkStreamRecord = {
        ...record,
        state: "complete",
        current_phase: null,
        active_step_id: null,
        status_note: safeText(input.statusNote, 600) ?? record.status_note,
        record_generation: (record.record_generation ?? 1) + 1,
        updated_at: (input.now ?? new Date()).toISOString(),
      };
      return commitWorkStreamMutation({ butlerData: this.butlerData, context, record: updated, expectedGeneration: record.record_generation ?? 1 });
    });
  }

  updateFromTodoList(input: {
    id?: string;
    ownerSessionId?: string | null;
    originChatId?: string | null;
    projectId?: string | null;
    listId?: string | null;
    title?: string | null;
    intentSummary?: string | null;
    roleHint?: string | null;
    expectedDeliverable?: string | null;
    lastUserTurnId?: string | null;
    items: TodoItem[];
    now?: Date;
  }): WorkStreamRecord {
    const now = (input.now ?? new Date()).toISOString();
    const baseId = safeId(input.id?.trim() || stableStreamId({
      ownerSessionId: input.ownerSessionId,
      originChatId: input.originChatId,
      projectId: input.projectId,
      listId: input.listId,
    }));
    const base = this.withMutation(baseId, "legacy_todo_update", (context, current) => {
      const target = targetFromTodos(input.items, current);
      if (current && workStreamTerminal(current.state) && !workStreamTerminal(target.state) && !input.id?.trim()) {
        return { terminal: current } as const;
      }
      return { record: this.commitTodoDerived(input, now, baseId, current, current, context) } as const;
    });
    if ("record" in base && base.record) return base.record;
    const active = this.activeForScope({
      ownerSessionId: input.ownerSessionId ?? base.terminal.owner_session_id,
      originChatId: input.originChatId ?? base.terminal.origin_chat_id,
      projectId: input.projectId ?? base.terminal.project_id,
      listId: input.listId ?? base.terminal.todo_list_id,
      excludeId: baseId,
      currentTurnId: input.lastUserTurnId,
    });
    const id = active?.id ?? revisionStreamId(baseId, now);
    return this.withMutation(id, "legacy_todo_update", (context, current) =>
      this.commitTodoDerived(input, now, id, current, base.terminal, context));
  }

  transition(input: {
    id: string;
    state: WorkStreamState;
    statusNote?: string | null;
    activeStepId?: string | null;
    now?: Date;
  }): WorkStreamRecord {
    return this.withMutation(input.id, "legacy_transition", (context, record) => {
      if (!record) throw new Error(`work stream ${input.id} not found`);
      const state = normalizeState(input.state);
      assertWorkStreamTransition(record.state, state);
      const updated: WorkStreamRecord = {
        ...record,
        state,
        current_phase: phaseForState(state, record.current_phase),
        active_step_id: input.activeStepId === undefined ? record.active_step_id : safeOptionalId(input.activeStepId),
        status_note: safeText(input.statusNote, 600) ?? record.status_note,
        record_generation: (record.record_generation ?? 1) + 1,
        updated_at: (input.now ?? new Date()).toISOString(),
      };
      return commitWorkStreamMutation({ butlerData: this.butlerData, context, record: updated, expectedGeneration: record.record_generation ?? 1 });
    });
  }

  link(input: {
    id?: string | null;
    sessionId?: string | null;
    plannedTaskIds?: string[];
    orchestrationIds?: string[];
    workerTaskIds?: string[];
    now?: Date;
  }): WorkStreamRecord | null {
    const selected = input.id ? this.read(input.id) : this.activeForSession(input.sessionId);
    if (!selected) return null;
    return this.withMutation(selected.id, "legacy_link", (context, record) => {
      if (!record) return null;
      const updated: WorkStreamRecord = {
        ...record,
        linked_planned_task_ids: uniqueAppend(record.linked_planned_task_ids, input.plannedTaskIds),
        linked_orchestration_ids: uniqueAppend(record.linked_orchestration_ids, input.orchestrationIds),
        linked_worker_task_ids: uniqueAppend(record.linked_worker_task_ids, input.workerTaskIds),
        record_generation: (record.record_generation ?? 1) + 1,
        updated_at: (input.now ?? new Date()).toISOString(),
      };
      return commitWorkStreamMutation({ butlerData: this.butlerData, context, record: updated, expectedGeneration: record.record_generation ?? 1 });
    });
  }

  private withMutation<T>(
    id: string,
    operation: WorkStreamMutationOperation,
    action: (context: Parameters<typeof commitWorkStreamMutation>[0]["context"], record: WorkStreamRecord | null) => T,
  ): T {
    if (this.autoRecover) {
      const recovery = reconcilePendingWorkStreamTransactions({ butlerData: this.butlerData, workstreamId: id });
      if (hasDeferredWorkStreamRecovery(recovery, id)) throw new Error("workstream_recovery_deferred");
    }
    const result = withWorkStreamMutationAuthority({
      butlerData: this.butlerData,
      workstreamId: id,
      operation,
      ownerId: `${operation}:${id}`,
      action: (context) => ({ value: action(context, this.readRaw(id)) }),
    });
    if (!result) throw new Error("workstream_mutation_conflict");
    return result.value;
  }

  private commitTodoDerived(
    input: Parameters<WorkStreamStore["updateFromTodoList"]>[0],
    now: string,
    id: string,
    current: WorkStreamRecord | null,
    fallback: WorkStreamRecord | null,
    context: Parameters<typeof commitWorkStreamMutation>[0]["context"],
  ): WorkStreamRecord {
    const target = targetFromTodos(input.items, current);
    validateTodoEvidenceForTarget(input.items, target.state);
    if (current) {
      const path = transitionPath(current.state, target.state);
      if (!path) assertWorkStreamTransition(current.state, target.state);
    }
    const source = current ?? fallback;
    const record: WorkStreamRecord = {
      version: 1,
      id,
      title: safeText(input.title, 120) ?? source?.title ?? "Butler work stream",
      owner_session_id: input.ownerSessionId?.trim() || source?.owner_session_id || null,
      origin_chat_id: input.originChatId?.trim() || source?.origin_chat_id || null,
      project_id: input.projectId?.trim() || source?.project_id || null,
      intent_summary: safeText(input.intentSummary, 600) ?? source?.intent_summary ?? null,
      role_hint: safeText(input.roleHint, 240) ?? source?.role_hint ?? null,
      expected_deliverable: safeText(input.expectedDeliverable, 600) ?? source?.expected_deliverable ?? null,
      state: target.state,
      current_phase: target.phase ?? phaseForState(target.state, current?.current_phase ?? null),
      active_step_id: target.activeStepId,
      todo_list_id: input.listId?.trim() || source?.todo_list_id || null,
      linked_planned_task_ids: source?.linked_planned_task_ids ?? [],
      linked_orchestration_ids: source?.linked_orchestration_ids ?? [],
      linked_worker_task_ids: source?.linked_worker_task_ids ?? [],
      created_at: current?.created_at ?? now,
      updated_at: now,
      last_user_turn_id: input.lastUserTurnId?.trim() || source?.last_user_turn_id || null,
      status_note: target.state === "complete" ? null : current?.status_note ?? null,
      record_generation: (current?.record_generation ?? 0) + 1,
      active_contract_id: current?.active_contract_id ?? null,
      claim_generation: current?.claim_generation ?? null,
      claim_lease_expires_at: current?.claim_lease_expires_at ?? null,
      active_claim_receipt_id: current?.active_claim_receipt_id ?? null,
      original_claim_receipt_id: current?.original_claim_receipt_id ?? null,
      active_blocker_id: current?.active_blocker_id ?? null,
      active_blocker_evidence_id: current?.active_blocker_evidence_id ?? null,
      plan_revision: current?.plan_revision ?? 1,
      plan_revision_receipt_id: current?.plan_revision_receipt_id ?? null,
      superseded_todo_ids: current?.superseded_todo_ids ?? [],
    };
    return commitWorkStreamMutation({ butlerData: this.butlerData, context, record, expectedGeneration: current?.record_generation ?? null });
  }

}

function normalizeContractFields(record: WorkStreamRecord): WorkStreamRecord {
  return {
    ...record,
    record_generation: record.record_generation ?? 1,
    active_contract_id: record.active_contract_id ?? null,
    claim_generation: record.claim_generation ?? null,
    claim_lease_expires_at: record.claim_lease_expires_at ?? null,
    active_claim_receipt_id: record.active_claim_receipt_id ?? null,
    original_claim_receipt_id: record.original_claim_receipt_id ?? null,
    active_blocker_id: record.active_blocker_id ?? null,
    active_blocker_evidence_id: record.active_blocker_evidence_id ?? null,
    plan_revision: record.plan_revision ?? 1,
    plan_revision_receipt_id: record.plan_revision_receipt_id ?? null,
    superseded_todo_ids: record.superseded_todo_ids ?? [],
  };
}

function turnLocalOutcomeEligible(record: WorkStreamRecord): boolean {
  return record.linked_planned_task_ids.length === 0 &&
    record.linked_orchestration_ids.length === 0 &&
    record.linked_worker_task_ids.length === 0;
}

function turnLocalOutcomeCanApply(
  record: WorkStreamRecord,
  outcome: TurnLocalWorkOutcome,
): boolean {
  if (outcome === "failed" && record.state === "recoverable") return false;
  if (outcome === "completed") {
    return record.state !== "recoverable" && record.state !== "paused";
  }
  return true;
}

function workStreamStateForTurnLocalOutcome(outcome: TurnLocalWorkOutcome): WorkStreamState {
  if (outcome === "completed") return "complete";
  if (outcome === "failed") return "failed";
  if (outcome === "cancelled") return "cancelled";
  if (outcome === "waiting_user") return "waiting_user";
  return "recoverable";
}

function turnLocalOutcomeCurrentPhase(
  record: WorkStreamRecord,
  outcome: TurnLocalWorkOutcome,
): WorkStreamPhase | null {
  if (outcome === "completed" || outcome === "failed" || outcome === "cancelled") return null;
  return record.current_phase;
}

function turnLocalOutcomeActiveStepId(
  record: WorkStreamRecord,
  outcome: TurnLocalWorkOutcome,
): string | null {
  if (outcome === "completed" || outcome === "failed" || outcome === "cancelled") return null;
  return record.active_step_id;
}

function turnLocalOutcomeStatusNote(outcome: TurnLocalWorkOutcome): string {
  if (outcome === "completed") return "Turn outcome completed; local work is no longer active.";
  if (outcome === "failed") return "Turn outcome failed; local work is no longer active.";
  if (outcome === "cancelled") return "Turn outcome cancelled; local work is no longer active.";
  if (outcome === "waiting_user") return "Turn is waiting for a user decision.";
  return "Turn interrupted before final delivery; durable work can be resumed.";
}

function turnLocalOutcomeTodoItem(
  item: TodoItem,
  outcome: TurnLocalWorkOutcome,
): TodoItemInput {
  return {
    id: item.id,
    content: item.content,
    active_form: item.active_form,
    status: turnLocalOutcomeTodoStatus(item, outcome),
    phase: item.phase ?? undefined,
    priority: item.priority,
    blocked_by: item.blocked_by,
    note: item.note ?? turnLocalOutcomeTodoNote(outcome),
  };
}

function turnLocalOutcomeTodoStatus(
  item: TodoItem,
  outcome: TurnLocalWorkOutcome,
): TodoStatus {
  if (item.status === "completed" || item.status === "cancelled") return item.status;
  if (outcome === "completed" && item.phase === "reporting") return "completed";
  if (outcome === "recoverable" || outcome === "waiting_user") return "pending";
  return "cancelled";
}

function turnLocalOutcomeTodoNote(outcome: TurnLocalWorkOutcome): string {
  if (outcome === "completed") return "No longer applicable after the turn completed.";
  if (outcome === "failed") return "Cancelled because the turn failed.";
  if (outcome === "cancelled") return "Cancelled with the turn.";
  if (outcome === "waiting_user") return "Paused until the user decision is available.";
  return "Paused in the active projection; resume from the recoverable WorkStream.";
}
