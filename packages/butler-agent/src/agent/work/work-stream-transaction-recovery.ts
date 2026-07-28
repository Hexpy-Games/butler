import { existsSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { readJsonFile, writeJsonFileAtomic } from "../persistence/atomic-json-store.ts";
import type { TodoListRecord } from "./todo-list.ts";
import type { WorkStreamRecord } from "./work-stream.ts";
import type { AmendmentJournal } from "./work-stream-plan-store.ts";
import {
  type ReportingCompletionJournal,
  reportingTransactionDirectory,
  reportingTransactionPath,
  todoFingerprint,
} from "./work-stream-reporting-store.ts";
import { commitWorkStreamMutation, withWorkStreamMutationAuthority, workStreamRecordFingerprint } from "./work-stream-mutation-authority.ts";

export const STORE_RECOVERY_DEADLINE_MS = 8;
export const BOOTSTRAP_RECOVERY_DEADLINE_MS = 40;
export const ASYNC_RECOVERY_DEADLINE_MS = 20;
export const ASYNC_RECOVERY_RETRY_DELAY_MS = 50;

export interface WorkStreamRecoveryResult {
  transactionId: string;
  kind: "plan" | "reporting";
  status: "committed" | "conflict" | "deferred";
  projection?: {
    workstream: WorkStreamRecord;
    todo: TodoListRecord | null;
  };
}

interface RecoveryInput {
  butlerData: string;
  workstreamId?: string;
  todoListId?: string;
  maxDurationMs?: number;
  scheduleRetry?: boolean;
}

const scheduledRoots = new Set<string>();
const scanCursorByDirectory = new Map<string, number>();

export function reconcilePendingWorkStreamTransactions(input: RecoveryInput): WorkStreamRecoveryResult[] {
  const deadline = performance.now() + Math.max(0, input.maxDurationMs ?? STORE_RECOVERY_DEADLINE_MS);
  const results: WorkStreamRecoveryResult[] = [];
  let needsRetry = false;
  const scans = [
    scanJournals<AmendmentJournal>({
      dir: join(input.butlerData, "workstream-plan-transactions"),
      deadline,
      pending: (journal) => journal.state === "prepared",
      matches: (journal) => (!input.workstreamId || journal.before_workstream.id === input.workstreamId) &&
        (!input.todoListId || journal.before_todo.list_id === input.todoListId),
      recover: (journal) => recoverPlan(input.butlerData, journal),
    }),
    scanJournals<ReportingCompletionJournal>({
      dir: reportingTransactionDirectory(input.butlerData),
      deadline,
      pending: (journal) => journal.state === "prepared",
      matches: (journal) => (!input.workstreamId || journal.before_workstream.id === input.workstreamId) &&
        (!input.todoListId || journal.before_todo?.list_id === input.todoListId),
      recover: (journal) => recoverReporting(input.butlerData, journal),
    }),
  ];
  for (const scan of scans) {
    results.push(...scan.results);
    needsRetry ||= scan.needsRetry;
  }
  if (needsRetry && input.scheduleRetry !== false) scheduleRecovery(input.butlerData);
  return results;
}

function recoverPlan(butlerData: string, journal: AmendmentJournal): WorkStreamRecoveryResult {
  const result = withWorkStreamMutationAuthority({
    butlerData,
    workstreamId: journal.before_workstream.id,
    operation: "plan_recovery",
    ownerId: `recover:${journal.transaction_id}`,
    action: (context) => {
      const current = readWorkStream(butlerData, journal.before_workstream.id);
      const todo = readTodo(butlerData, journal.before_todo.list_id);
      if (!current || terminal(current)) return markPlanConflict(butlerData, journal);
      const fingerprint = workStreamRecordFingerprint(current);
      const before = fingerprint === journal.before_fingerprint;
      const after = fingerprint === journal.after_fingerprint;
      const todoValue = todo ? JSON.stringify(todo) : null;
      const todoCompatible = todoValue === JSON.stringify(journal.before_todo) || todoValue === JSON.stringify(journal.after_todo);
      if ((!before && !after) || !todoCompatible) return markPlanConflict(butlerData, journal);
      writeJsonFileAtomic(todoPath(butlerData, journal.after_todo.list_id), journal.after_todo);
      if (before) {
        commitWorkStreamMutation({
          butlerData,
          context,
          record: journal.after_workstream,
          expectedGeneration: journal.before_workstream.record_generation ?? 1,
        });
      }
      writeJsonFileAtomic(planReceiptPath(butlerData, journal.receipt.receipt_id), journal.receipt);
      writeJsonFileAtomic(planTransactionPath(butlerData, journal.transaction_id), { ...journal, state: "committed", updated_at: new Date().toISOString() });
      return resultFor(journal.transaction_id, "plan", "committed");
    },
  });
  return result ?? deferredResult(journal.transaction_id, "plan", journal.before_workstream, journal.before_todo);
}

function recoverReporting(butlerData: string, journal: ReportingCompletionJournal): WorkStreamRecoveryResult {
  const result = withWorkStreamMutationAuthority({
    butlerData,
    workstreamId: journal.before_workstream.id,
    operation: "reporting_recovery",
    ownerId: `recover-reporting:${journal.transaction_id}`,
    action: (context) => {
      const current = readWorkStream(butlerData, journal.before_workstream.id);
      const todo = journal.before_todo ? readTodo(butlerData, journal.before_todo.list_id) : null;
      const currentFingerprint = current ? workStreamRecordFingerprint(current) : null;
      const before = currentFingerprint === journal.before_workstream_fingerprint;
      const after = currentFingerprint === journal.after_workstream_fingerprint;
      const todoCompatible = todoFingerprint(todo) === journal.before_todo_fingerprint ||
        todoFingerprint(todo) === journal.after_todo_fingerprint;
      if (!current || (!before && !after) || !todoCompatible || (terminal(current) && !after)) {
        return markReportingConflict(butlerData, journal);
      }
      if (journal.after_todo && todoFingerprint(todo) !== journal.after_todo_fingerprint) {
        writeJsonFileAtomic(todoPath(butlerData, journal.after_todo.list_id), journal.after_todo);
      }
      if (before) {
        commitWorkStreamMutation({
          butlerData,
          context,
          record: journal.after_workstream,
          expectedGeneration: journal.before_workstream.record_generation ?? 1,
        });
      }
      writeJsonFileAtomic(reportingTransactionPath(butlerData, journal.transaction_id), {
        ...journal,
        state: "committed",
        updated_at: new Date().toISOString(),
      });
      return resultFor(journal.transaction_id, "reporting", "committed");
    },
  });
  return result ?? deferredResult(journal.transaction_id, "reporting", journal.before_workstream, journal.before_todo);
}

export function deferredWorkStreamProjection(
  results: readonly WorkStreamRecoveryResult[],
  workstreamId: string,
): WorkStreamRecord | undefined {
  return earliestDeferredProjection(results, (projection) => projection.workstream.id === workstreamId)
    ?.workstream;
}

export function deferredTodoProjection(
  results: readonly WorkStreamRecoveryResult[],
  todoListId: string,
): TodoListRecord | undefined {
  return earliestDeferredProjection(results, (projection) => projection.todo?.list_id === todoListId)
    ?.todo ?? undefined;
}

export function hasDeferredWorkStreamRecovery(
  results: readonly WorkStreamRecoveryResult[],
  workstreamId: string,
): boolean {
  return results.some((result) => result.status === "deferred" && result.projection?.workstream.id === workstreamId);
}

export function hasDeferredTodoRecovery(
  results: readonly WorkStreamRecoveryResult[],
  todoListId: string,
): boolean {
  return results.some((result) => result.status === "deferred" && result.projection?.todo?.list_id === todoListId);
}

function scanJournals<T>(input: {
  dir: string;
  deadline: number;
  pending: (journal: T) => boolean;
  matches: (journal: T) => boolean;
  recover: (journal: T) => WorkStreamRecoveryResult;
}): { results: WorkStreamRecoveryResult[]; needsRetry: boolean } {
  if (!existsSync(input.dir)) {
    scanCursorByDirectory.delete(input.dir);
    return { results: [], needsRetry: false };
  }
  if (performance.now() >= input.deadline) return { results: [], needsRetry: true };
  const entries = readdirSync(input.dir).filter((entry) => entry.endsWith(".json")).sort();
  if (entries.length === 0) {
    scanCursorByDirectory.delete(input.dir);
    return { results: [], needsRetry: false };
  }
  const results: WorkStreamRecoveryResult[] = [];
  let index = (scanCursorByDirectory.get(input.dir) ?? 0) % entries.length;
  for (let visited = 0; visited < entries.length; visited += 1) {
    if (performance.now() >= input.deadline) {
      scanCursorByDirectory.set(input.dir, index);
      return { results, needsRetry: true };
    }
    const currentIndex = index;
    index = (index + 1) % entries.length;
    const journal = readJsonFile<T>(join(input.dir, entries[currentIndex]!));
    if (!journal || !input.pending(journal)) continue;
    try {
      if (!input.matches(journal)) continue;
    } catch {
      continue;
    }
    try {
      const result = input.recover(journal);
      results.push(result);
      if (result.status === "deferred") {
        scanCursorByDirectory.set(input.dir, currentIndex);
        return { results, needsRetry: true };
      }
    } catch {
      scanCursorByDirectory.set(input.dir, currentIndex);
      return { results, needsRetry: true };
    }
  }
  scanCursorByDirectory.delete(input.dir);
  return { results, needsRetry: false };
}

function scheduleRecovery(butlerData: string): void {
  const root = resolve(butlerData);
  if (scheduledRoots.has(root)) return;
  scheduledRoots.add(root);
  const timer = setTimeout(() => {
    scheduledRoots.delete(root);
    try {
      reconcilePendingWorkStreamTransactions({
        butlerData: root,
        maxDurationMs: ASYNC_RECOVERY_DEADLINE_MS,
        scheduleRetry: true,
      });
    } catch {
      scheduleRecovery(root);
    }
  }, ASYNC_RECOVERY_RETRY_DELAY_MS);
  timer.unref?.();
}

function markPlanConflict(butlerData: string, journal: AmendmentJournal): WorkStreamRecoveryResult {
  writeJsonFileAtomic(planTransactionPath(butlerData, journal.transaction_id), { ...journal, state: "conflict", updated_at: new Date().toISOString() });
  return resultFor(journal.transaction_id, "plan", "conflict");
}

function markReportingConflict(butlerData: string, journal: ReportingCompletionJournal): WorkStreamRecoveryResult {
  writeJsonFileAtomic(reportingTransactionPath(butlerData, journal.transaction_id), { ...journal, state: "conflict", updated_at: new Date().toISOString() });
  return resultFor(journal.transaction_id, "reporting", "conflict");
}

function readWorkStream(data: string, id: string): WorkStreamRecord | null { return readJsonFile<WorkStreamRecord>(join(data, "work-streams", `${safeId(id)}.json`)); }
function readTodo(data: string, id: string): TodoListRecord | null { return readJsonFile<TodoListRecord>(todoPath(data, id)); }
function todoPath(data: string, id: string): string { return join(data, "todos", `${safeId(id)}.json`); }
function planTransactionPath(data: string, id: string): string { return join(data, "workstream-plan-transactions", `${safeId(id)}.json`); }
function planReceiptPath(data: string, id: string): string { return join(data, "workstream-plan-amendment-receipts", `${safeId(id)}.json`); }
function terminal(record: WorkStreamRecord): boolean { return record.state === "complete" || record.state === "failed" || record.state === "cancelled"; }
function resultFor(transactionId: string, kind: WorkStreamRecoveryResult["kind"], status: WorkStreamRecoveryResult["status"]): WorkStreamRecoveryResult { return { transactionId, kind, status }; }

function deferredResult(
  transactionId: string,
  kind: WorkStreamRecoveryResult["kind"],
  workstream: WorkStreamRecord,
  todo: TodoListRecord | null,
): WorkStreamRecoveryResult {
  return { transactionId, kind, status: "deferred", projection: { workstream, todo } };
}

function earliestDeferredProjection(
  results: readonly WorkStreamRecoveryResult[],
  matches: (projection: NonNullable<WorkStreamRecoveryResult["projection"]>) => boolean,
): NonNullable<WorkStreamRecoveryResult["projection"]> | undefined {
  return results
    .filter((result) => result.status === "deferred" && result.projection && matches(result.projection))
    .map((result) => result.projection!)
    .sort((left, right) =>
      (left.workstream.record_generation ?? 1) - (right.workstream.record_generation ?? 1))
    .at(0);
}

function safeId(value: string): string {
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(value)) throw new Error("workstream_recovery_unsafe_id");
  return value;
}
