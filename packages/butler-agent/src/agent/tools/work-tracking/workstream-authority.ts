import type { TodoItemInput, TodoListStore } from "../../work/todo-list.ts";
import { WorkStreamPlanStore } from "../../work/work-stream-plan-store.ts";
import type { WorkStreamRecord, WorkStreamStore } from "../../work/work-stream.ts";

export interface ActiveWorkStreamBinding {
  contractId: string;
  workStreamId: string;
}

interface AuthorityStores {
  butlerData: string;
  todoListStore: TodoListStore;
  workStreamStore: WorkStreamStore;
  activeWorkStreamBinding?: () => ActiveWorkStreamBinding | null;
}

export interface ResolvedWorkStreamAuthority {
  binding: ActiveWorkStreamBinding;
  record: WorkStreamRecord;
  todoListId: string;
}

export function resolveWorkStreamAuthority(
  input: AuthorityStores,
): ResolvedWorkStreamAuthority | null {
  const binding = input.activeWorkStreamBinding?.() ?? null;
  if (!binding) return null;
  const record = input.workStreamStore.read(binding.workStreamId);
  if (!record) throw new Error("workstream_contract_target_missing");
  if (record.active_contract_id !== binding.contractId) {
    throw new Error("workstream_contract_claim_missing");
  }
  if (!record.todo_list_id) throw new Error("workstream_contract_plan_missing");
  return {
    binding,
    record,
    todoListId: record.todo_list_id,
  };
}

export function boundTodoListId(
  rawListId: unknown,
  input: AuthorityStores,
): string | null {
  const authority = resolveWorkStreamAuthority(input);
  if (!authority) return null;
  const explicit = explicitTodoListId(rawListId);
  if (explicit && explicit !== authority.todoListId) {
    throw new Error("workstream_contract_todo_mismatch");
  }
  return authority.todoListId;
}

export function amendBoundWorkStreamPlan(input: AuthorityStores & {
  items: TodoItemInput[];
  title?: string;
}) {
  const authority = resolveWorkStreamAuthority(input);
  if (!authority) return null;
  const amended = new WorkStreamPlanStore(input.butlerData).amend({
    workstreamId: authority.record.id,
    contractId: authority.binding.contractId,
    expectedGeneration: authority.record.record_generation ?? 1,
    items: input.items,
    title: input.title,
  });
  if (!amended.ok) throw new Error(amended.code);
  const view = input.todoListStore.view(authority.todoListId, { includeCompleted: true });
  return {
    view,
    workStream: amended.record,
    receipt: amended.receipt,
    replayed: amended.replayed,
  };
}

export function assertBoundWorkStreamId(
  requestedId: string | undefined,
  input: AuthorityStores,
): WorkStreamRecord | null {
  const authority = resolveWorkStreamAuthority(input);
  if (!authority) return null;
  if (requestedId && requestedId !== authority.record.id) {
    throw new Error("workstream_contract_target_mismatch");
  }
  return authority.record;
}

function explicitTodoListId(rawListId: unknown): string | null {
  if (typeof rawListId !== "string") return null;
  const trimmed = rawListId.trim();
  if (!trimmed || trimmed === "main") return null;
  return trimmed;
}
