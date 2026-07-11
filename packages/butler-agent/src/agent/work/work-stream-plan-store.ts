import { createHash } from "crypto";
import { join } from "path";
import { readJsonFile, writeJsonFileAtomic } from "../persistence/atomic-json-store.ts";
import { TodoListStore, type TodoItem, type TodoItemInput, type TodoListRecord } from "./todo-list.ts";
import { WorkStreamStore, type WorkStreamRecord } from "./work-stream.ts";
import {
  commitWorkStreamMutation,
  type WorkStreamMutationContext,
  withWorkStreamMutationAuthority,
  workStreamRecordFingerprint,
} from "./work-stream-mutation-authority.ts";
import { reconcilePendingWorkStreamTransactions } from "./work-stream-transaction-recovery.ts";

export interface WorkStreamPlanAmendmentReceipt {
  schema_version: "butler.workstream-plan-amendment-receipt.v1";
  receipt_id: string;
  transaction_id: string;
  workstream_id: string;
  contract_id: string;
  parent_revision: number;
  revision: number;
  before_generation: number;
  after_generation: number;
  preserved_completed_item_ids: string[];
  superseded_item_ids: string[];
  created_at: string;
}

export interface AmendmentJournal {
  schema_version: "butler.workstream-plan-amendment-transaction.v1";
  transaction_id: string;
  state: "prepared" | "committed" | "conflict";
  before_workstream: WorkStreamRecord;
  after_workstream: WorkStreamRecord;
  before_fingerprint: string;
  after_fingerprint: string;
  before_todo: TodoListRecord;
  after_todo: TodoListRecord;
  receipt: WorkStreamPlanAmendmentReceipt;
  updated_at: string;
}

export type PlanAmendmentResult =
  | { ok: true; record: WorkStreamRecord; receipt: WorkStreamPlanAmendmentReceipt; replayed: boolean }
  | { ok: false; code: string; transactionId?: string };

export class WorkStreamPlanStore {
  private readonly streams: WorkStreamStore;
  private readonly todos: TodoListStore;
  private readonly transactionsDir: string;
  private readonly receiptsDir: string;

  constructor(readonly butlerData: string) {
    reconcilePendingWorkStreamTransactions({ butlerData });
    this.streams = new WorkStreamStore(butlerData, { autoRecover: false });
    this.todos = new TodoListStore(butlerData, { autoRecover: false });
    this.transactionsDir = join(butlerData, "workstream-plan-transactions");
    this.receiptsDir = join(butlerData, "workstream-plan-amendment-receipts");
  }

  amend(input: {
    workstreamId: string;
    contractId: string;
    expectedGeneration: number;
    items: TodoItemInput[];
    title?: string | null;
    now?: Date;
    faultAt?: "after_prepare" | "after_todo_write" | "after_workstream_write";
  }): PlanAmendmentResult {
    const now = input.now ?? new Date();
    const lockResult = withWorkStreamMutationAuthority({
      butlerData: this.butlerData,
      workstreamId: input.workstreamId,
      operation: "plan_amendment",
      ownerId: `amend:${input.contractId}`,
      now,
      action: (context) => this.amendLocked(input, now, context),
    });
    return lockResult ?? { ok: false, code: "workstream_plan_amendment_conflict" };
  }

  recoverPending(): Array<{ transactionId: string; status: "committed" | "conflict" | "deferred" }> {
    return reconcilePendingWorkStreamTransactions({ butlerData: this.butlerData })
      .filter((result) => result.kind === "plan")
      .map(({ transactionId, status }) => ({ transactionId, status }));
  }

  readReceipt(receiptId: string): WorkStreamPlanAmendmentReceipt | null {
    return readJsonFile<WorkStreamPlanAmendmentReceipt>(join(this.receiptsDir, `${safeId(receiptId)}.json`));
  }

  private amendLocked(
    input: Parameters<WorkStreamPlanStore["amend"]>[0],
    now: Date,
    context: WorkStreamMutationContext,
  ): PlanAmendmentResult {
    const stream = this.streams.read(input.workstreamId);
    if (!stream || !stream.todo_list_id) return { ok: false, code: "workstream_plan_missing" };
    if (stream.active_contract_id !== input.contractId) return { ok: false, code: "workstream_claim_missing" };
    const transactionId = amendmentTransactionId(input.contractId, stream.id, input.items, input.title);
    const receiptId = `amendment-${transactionId.slice("plan-tx-".length)}`;
    const existingReceipt = this.readReceipt(receiptId);
    if (existingReceipt) return { ok: true, record: stream, receipt: existingReceipt, replayed: true };
    if (stream.record_generation !== input.expectedGeneration) return { ok: false, code: "workstream_plan_generation_conflict" };
    const priorTodo = this.todos.read(stream.todo_list_id);
    if (!priorTodo) return { ok: false, code: "workstream_plan_missing" };
    let nextTodo: TodoListRecord;
    try {
      nextTodo = this.completedItemsPreserved(priorTodo, this.todos.prepareUpdate({
        listId: priorTodo.list_id,
        title: input.title ?? priorTodo.title,
        items: input.items,
        now,
      }));
    } catch (error) {
      return { ok: false, code: safeAmendmentError(error) };
    }
    const superseded = priorTodo.items.filter((item) => !nextTodo.items.some((next) => next.id === item.id)).map((item) => item.id).sort();
    const nextStream: WorkStreamRecord = {
      ...stream,
      plan_revision: (stream.plan_revision ?? 1) + 1,
      plan_revision_receipt_id: receiptId,
      superseded_todo_ids: [...new Set([...(stream.superseded_todo_ids ?? []), ...superseded])].sort(),
      record_generation: (stream.record_generation ?? 1) + 1,
      updated_at: now.toISOString(),
    };
    const receipt: WorkStreamPlanAmendmentReceipt = {
      schema_version: "butler.workstream-plan-amendment-receipt.v1",
      receipt_id: receiptId,
      transaction_id: transactionId,
      workstream_id: stream.id,
      contract_id: input.contractId,
      parent_revision: stream.plan_revision ?? 1,
      revision: nextStream.plan_revision ?? 2,
      before_generation: stream.record_generation ?? 1,
      after_generation: nextStream.record_generation ?? 2,
      preserved_completed_item_ids: priorTodo.items.filter((item) => item.status === "completed").map((item) => item.id).sort(),
      superseded_item_ids: superseded,
      created_at: now.toISOString(),
    };
    const journal: AmendmentJournal = {
      schema_version: "butler.workstream-plan-amendment-transaction.v1",
      transaction_id: transactionId,
      state: "prepared",
      before_workstream: stream,
      after_workstream: nextStream,
      before_fingerprint: workStreamRecordFingerprint(stream),
      after_fingerprint: workStreamRecordFingerprint(nextStream),
      before_todo: priorTodo,
      after_todo: nextTodo,
      receipt,
      updated_at: now.toISOString(),
    };
    writeJsonFileAtomic(this.transactionPath(transactionId), journal);
    if (input.faultAt === "after_prepare") return { ok: false, code: "workstream_plan_amendment_interrupted", transactionId };
    this.todos.replacePrepared(nextTodo);
    if (input.faultAt === "after_todo_write") return { ok: false, code: "workstream_plan_amendment_interrupted", transactionId };
    commitWorkStreamMutation({ butlerData: this.butlerData, context, record: nextStream, expectedGeneration: stream.record_generation ?? 1 });
    if (input.faultAt === "after_workstream_write") return { ok: false, code: "workstream_plan_amendment_interrupted", transactionId };
    this.commitJournal(journal);
    return { ok: true, record: nextStream, receipt, replayed: false };
  }

  private completedItemsPreserved(prior: TodoListRecord, next: TodoListRecord): TodoListRecord {
    const proposedById = new Map(next.items.map((item) => [item.id, item]));
    const completedById = new Map(prior.items.filter((item) => item.status === "completed").map((item) => [item.id, item]));
    for (const [id, completed] of completedById) {
      const proposed = proposedById.get(id);
      if (!proposed || semanticTodoFingerprint(proposed) !== semanticTodoFingerprint(completed)) {
        throw new Error("workstream_completed_item_changed");
      }
    }
    return {
      ...next,
      items: next.items.map((item) => completedById.get(item.id) ?? item),
    };
  }

  private commitJournal(journal: AmendmentJournal): void {
    writeJsonFileAtomic(join(this.receiptsDir, `${safeId(journal.receipt.receipt_id)}.json`), journal.receipt);
    writeJsonFileAtomic(this.transactionPath(journal.transaction_id), {
      ...journal,
      state: "committed",
      updated_at: new Date().toISOString(),
    });
  }

  private transactionPath(transactionId: string): string {
    return join(this.transactionsDir, `${safeId(transactionId)}.json`);
  }

}

function semanticTodoFingerprint(item: TodoItem): string {
  return JSON.stringify({
    id: item.id,
    ordinal: item.ordinal,
    content: item.content,
    active_form: item.active_form,
    status: item.status,
    phase: item.phase,
    priority: item.priority,
    blocked_by: item.blocked_by,
    note: item.note,
  });
}

function amendmentTransactionId(
  contractId: string,
  workstreamId: string,
  items: TodoItemInput[],
  title?: string | null,
): string {
  const digest = createHash("sha256").update(`${contractId}\n${workstreamId}\n${title ?? ""}\n${JSON.stringify(items)}`).digest("hex").slice(0, 24);
  return `plan-tx-${digest}`;
}

function safeAmendmentError(error: unknown): string {
  return error instanceof Error && error.message === "workstream_completed_item_changed"
    ? error.message
    : "workstream_plan_amendment_invalid";
}

function safeId(value: string): string {
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(value)) throw new Error("workstream_plan_unsafe_id");
  return value;
}
