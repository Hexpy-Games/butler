import { createHash } from "crypto";
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { readJsonFile, writeJsonFileAtomic } from "../persistence/atomic-json-store.ts";
import { TodoListStore, type TodoItemInput, type TodoListRecord } from "./todo-list.ts";
import {
  commitWorkStreamMutation,
  withWorkStreamMutationAuthority,
  workStreamRecordFingerprint,
} from "./work-stream-mutation-authority.ts";
import type { WorkStreamRecord } from "./work-stream.ts";

export type ReportingCompletionFault = "after_prepare" | "after_todo_write" | "after_workstream_write";

export interface ReportingCompletionJournal {
  schema_version: "butler.workstream-reporting-transaction.v1";
  transaction_id: string;
  state: "prepared" | "committed" | "conflict";
  before_workstream: WorkStreamRecord;
  after_workstream: WorkStreamRecord;
  before_workstream_fingerprint: string;
  after_workstream_fingerprint: string;
  before_todo: TodoListRecord | null;
  after_todo: TodoListRecord | null;
  before_todo_fingerprint: string;
  after_todo_fingerprint: string;
  prepared_at: string;
  updated_at: string;
}

const ACTIVE_REPORTING_CANDIDATE_STATES = new Set([
  "routing",
  "conception",
  "planning",
  "executing",
  "reviewing",
  "consolidating",
  "reporting",
]);

export function completeReportingWorkStreamForSessionWithAuthority(input: {
  butlerData: string;
  sessionId: string;
  statusNote?: string | null;
  now?: Date;
  faultAt?: ReportingCompletionFault;
}): WorkStreamRecord | null {
  const dir = join(input.butlerData, "work-streams");
  if (!existsSync(dir)) return null;
  const candidates: WorkStreamRecord[] = [];
  for (const entry of readdirSync(dir).filter((name) => name.endsWith(".json")).sort()) {
    const workstreamId = entry.slice(0, -".json".length);
    const snapshot = withWorkStreamMutationAuthority({
      butlerData: input.butlerData,
      workstreamId,
      operation: "reporting_completion",
      ownerId: `reporting-select:${workstreamId}`,
      action: () => ({ record: readWorkStream(input.butlerData, workstreamId) }),
    });
    if (!snapshot) return null;
    if (snapshot.record?.owner_session_id === input.sessionId && ACTIVE_REPORTING_CANDIDATE_STATES.has(snapshot.record.state)) {
      candidates.push(snapshot.record);
    }
  }
  const selected = candidates.sort((left, right) => right.updated_at.localeCompare(left.updated_at)).at(0);
  if (selected?.state !== "reporting") return null;
  return completeReportingWorkStream({ ...input, workstreamId: selected.id });
}

export function completeReportingWorkStream(input: {
  butlerData: string;
  workstreamId: string;
  sessionId: string;
  statusNote?: string | null;
  now?: Date;
  faultAt?: ReportingCompletionFault;
}): WorkStreamRecord | null {
  const result = withWorkStreamMutationAuthority({
    butlerData: input.butlerData,
    workstreamId: input.workstreamId,
    operation: "reporting_completion",
    ownerId: `reporting:${input.workstreamId}`,
    action: (context) => {
      const beforeWorkstream = readWorkStream(input.butlerData, input.workstreamId);
      if (!beforeWorkstream || beforeWorkstream.owner_session_id !== input.sessionId || beforeWorkstream.state !== "reporting") {
        return { record: null };
      }
      const now = (input.now ?? new Date()).toISOString();
      const todoStore = new TodoListStore(input.butlerData, { autoRecover: false });
      const beforeTodo = beforeWorkstream.todo_list_id ? todoStore.read(beforeWorkstream.todo_list_id) : null;
      const afterTodo = prepareCompletedReportingTodo({
        store: todoStore,
        before: beforeTodo,
        activeStepId: beforeWorkstream.active_step_id,
        statusNote: input.statusNote,
        now: new Date(now),
      });
      const afterWorkstream: WorkStreamRecord = {
        ...beforeWorkstream,
        state: "complete",
        current_phase: null,
        active_step_id: null,
        status_note: normalizeStatus(input.statusNote) ?? "Final answer delivered.",
        record_generation: (beforeWorkstream.record_generation ?? 1) + 1,
        updated_at: now,
      };
      const journal = reportingJournal(beforeWorkstream, afterWorkstream, beforeTodo, afterTodo, now);
      writeJsonFileAtomic(reportingTransactionPath(input.butlerData, journal.transaction_id), journal);
      injectFault(input.faultAt, "after_prepare");
      if (afterTodo && todoFingerprint(afterTodo) !== todoFingerprint(beforeTodo)) todoStore.replacePrepared(afterTodo);
      injectFault(input.faultAt, "after_todo_write");
      commitWorkStreamMutation({
        butlerData: input.butlerData,
        context,
        record: afterWorkstream,
        expectedGeneration: beforeWorkstream.record_generation ?? 1,
      });
      injectFault(input.faultAt, "after_workstream_write");
      writeJsonFileAtomic(reportingTransactionPath(input.butlerData, journal.transaction_id), {
        ...journal,
        state: "committed",
        updated_at: now,
      });
      return { record: afterWorkstream };
    },
  });
  return result?.record ?? null;
}

export function reportingTransactionDirectory(butlerData: string): string {
  return join(butlerData, "workstream-reporting-transactions");
}

export function reportingTransactionPath(butlerData: string, transactionId: string): string {
  return join(reportingTransactionDirectory(butlerData), `${safeId(transactionId)}.json`);
}

export function todoFingerprint(record: TodoListRecord | null): string {
  return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

function reportingJournal(
  beforeWorkstream: WorkStreamRecord,
  afterWorkstream: WorkStreamRecord,
  beforeTodo: TodoListRecord | null,
  afterTodo: TodoListRecord | null,
  now: string,
): ReportingCompletionJournal {
  const beforeWorkstreamFingerprint = workStreamRecordFingerprint(beforeWorkstream);
  const afterWorkstreamFingerprint = workStreamRecordFingerprint(afterWorkstream);
  const transactionId = `report-${createHash("sha256")
    .update(`${beforeWorkstream.id}\n${beforeWorkstreamFingerprint}\n${afterWorkstreamFingerprint}`)
    .digest("hex").slice(0, 24)}`;
  return {
    schema_version: "butler.workstream-reporting-transaction.v1",
    transaction_id: transactionId,
    state: "prepared",
    before_workstream: beforeWorkstream,
    after_workstream: afterWorkstream,
    before_workstream_fingerprint: beforeWorkstreamFingerprint,
    after_workstream_fingerprint: afterWorkstreamFingerprint,
    before_todo: beforeTodo,
    after_todo: afterTodo,
    before_todo_fingerprint: todoFingerprint(beforeTodo),
    after_todo_fingerprint: todoFingerprint(afterTodo),
    prepared_at: now,
    updated_at: now,
  };
}

function prepareCompletedReportingTodo(input: {
  store: TodoListStore;
  before: TodoListRecord | null;
  activeStepId: string | null;
  statusNote?: string | null;
  now: Date;
}): TodoListRecord | null {
  if (!input.before) return null;
  let changed = false;
  const items: TodoItemInput[] = input.before.items.map((item) => {
    const reporting = item.status === "in_progress" && item.phase === "reporting" &&
      (!input.activeStepId || item.id === input.activeStepId);
    if (reporting) changed = true;
    return {
      id: item.id,
      content: item.content,
      active_form: item.active_form,
      status: reporting ? "completed" : item.status,
      phase: item.phase ?? undefined,
      priority: item.priority,
      blocked_by: item.blocked_by,
      note: item.note ?? (reporting ? input.statusNote ?? undefined : undefined),
    };
  });
  if (!changed) return input.before;
  return input.store.prepareUpdate({
    listId: input.before.list_id,
    title: input.before.title,
    items,
    now: input.now,
  });
}

function readWorkStream(butlerData: string, workstreamId: string): WorkStreamRecord | null {
  return readJsonFile<WorkStreamRecord>(join(butlerData, "work-streams", `${safeId(workstreamId)}.json`));
}

function normalizeStatus(value: string | null | undefined): string | null {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length > 600 ? normalized.slice(0, 600) : normalized;
}

function injectFault(actual: ReportingCompletionFault | undefined, expected: ReportingCompletionFault): void {
  if (actual === expected) throw new Error(`injected_reporting_completion_fault:${expected}`);
}

function safeId(value: string): string {
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(value)) throw new Error("workstream_reporting_unsafe_id");
  return value;
}
