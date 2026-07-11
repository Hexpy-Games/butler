import type { CompiledTurnContract, TurnContractDecision } from "../../turn-contract.ts";
import { TodoListStore } from "../../../work/todo-list.ts";
import { WorkStreamStore } from "../../../work/work-stream.ts";

export function prepareStartWorkStreamBinding(input: {
  butlerData: string;
  contract: CompiledTurnContract;
  decision: TurnContractDecision;
  sessionId: string;
  chatId: string;
  projectId?: string | null;
  turnId: string;
}): CompiledTurnContract {
  if (input.contract.action !== "start_work" || input.contract.target_workstream_id) {
    return input.contract;
  }
  const todoListId = `${input.contract.contract_id}:plan`;
  const workStreamId = `work-${input.contract.contract_id}`;
  const streams = new WorkStreamStore(input.butlerData);
  const existing = streams.read(workStreamId);
  if (!existing) {
    const summary = requiredText(input.decision.public_summary, "turn_contract_start_summary_missing");
    const nextStep = input.decision.immediate_next_step?.trim() || summary;
    const todo = new TodoListStore(input.butlerData).update({
      listId: todoListId,
      title: input.decision.public_title?.trim() || summary,
      items: [{
        id: "opening",
        content: summary,
        active_form: nextStep,
        status: "in_progress",
        phase: "planning",
      }],
    });
    streams.updateFromTodoList({
      id: workStreamId,
      ownerSessionId: input.sessionId,
      originChatId: input.chatId,
      projectId: input.projectId ?? input.contract.target_project_id ?? null,
      listId: todo.list.list_id,
      title: todo.list.title,
      intentSummary: summary,
      lastUserTurnId: input.turnId,
      items: todo.list.items,
    });
  } else if (!existing.todo_list_id) {
    throw new Error("turn_contract_start_plan_missing");
  }
  return {
    ...input.contract,
    target_workstream_id: workStreamId,
    ...(input.contract.target_project_id ?? input.projectId
      ? { target_project_id: input.contract.target_project_id ?? input.projectId ?? undefined }
      : {}),
  };
}

function requiredText(value: string | undefined, code: string): string {
  const text = value?.trim();
  if (!text) throw new Error(code);
  return text;
}
