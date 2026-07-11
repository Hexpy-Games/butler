import { TodoListStore } from "../work/todo-list.ts";
import { WorkStreamStore } from "../work/work-stream.ts";
import type { CompiledTurnContract } from "./turn-contract-types.ts";

const EXECUTION_ACTIONS = new Set<CompiledTurnContract["action"]>([
  "start_work",
  "resume_work",
  "modify_work",
  "supply_user_action",
]);

export interface OpenTurnContractPlanItem {
  id: string;
  status: string;
  phase: string | null;
}

export type TurnContractPlanClosure =
  | { status: "not_required" | "satisfied"; open_items: [] }
  | { status: "incomplete"; open_items: OpenTurnContractPlanItem[] }
  | { status: "invalid"; code: string; open_items: [] };

export function evaluateTurnContractPlanClosure(input: {
  butlerData: string;
  contract: CompiledTurnContract;
}): TurnContractPlanClosure {
  if (!EXECUTION_ACTIONS.has(input.contract.action)) {
    return { status: "not_required", open_items: [] };
  }
  const workstreamId = input.contract.target_workstream_id;
  if (!workstreamId) {
    return { status: "invalid", code: "turn_contract_plan_workstream_missing", open_items: [] };
  }
  const stream = new WorkStreamStore(input.butlerData, { autoRecover: false }).read(workstreamId);
  if (!stream) {
    return { status: "invalid", code: "turn_contract_plan_workstream_missing", open_items: [] };
  }
  if (stream.active_contract_id !== input.contract.contract_id) {
    return { status: "invalid", code: "turn_contract_plan_claim_mismatch", open_items: [] };
  }
  if (!stream.todo_list_id) {
    return { status: "invalid", code: "turn_contract_plan_missing", open_items: [] };
  }
  const plan = new TodoListStore(input.butlerData, { autoRecover: false }).read(stream.todo_list_id);
  if (!plan) {
    return { status: "invalid", code: "turn_contract_plan_missing", open_items: [] };
  }
  if (
    input.contract.action === "start_work" &&
    (stream.plan_revision ?? 1) <= 1 &&
    plan.items.length === 1 &&
    plan.items[0]?.id === "opening"
  ) {
    return { status: "not_required", open_items: [] };
  }
  const openItems = plan.items
    .filter((item) => item.phase !== "reporting" && item.status !== "completed")
    .map((item) => ({ id: item.id, status: item.status, phase: item.phase ?? null }));
  return openItems.length > 0
    ? { status: "incomplete", open_items: openItems }
    : { status: "satisfied", open_items: [] };
}

export function turnContractPlanAllowsTerminal(closure: TurnContractPlanClosure): boolean {
  return closure.status === "not_required" || closure.status === "satisfied";
}
