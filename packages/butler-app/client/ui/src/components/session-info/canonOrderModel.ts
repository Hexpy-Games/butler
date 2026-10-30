import { applyStepSortableEdit, type StepSortableChain, type StepSortableEdit, type StepSortableItem } from "@/butler-ds";
import type { CanonQueueEdit, CanonQueueItem, CanonQueueView } from "@/app/canonQueue.ts";

export type OrderAction = { action: "startNow" | "unstack" | "remove"; epicId: string };
export interface OrderItem extends StepSortableItem { epic: CanonQueueItem }
export function orderChains(view: CanonQueueView): StepSortableChain<OrderItem>[] {
  return view.chains.map(chain => ({ id: chain.chain_id, label: chain.origin, steps: chain.steps.map(step => step.items.map(epic => ({
    id: epic.epic_id, label: epic.title, epic, running: epic.state === "running", done: epic.state === "done", pinned: epic.state === "done",
  }))) }));
}

/** DS places precede removal; the API inserts after removing the selection. */
export function orderEditToApi(view: CanonQueueView, edit: StepSortableEdit | OrderAction): CanonQueueEdit {
  if ("action" in edit) return { expected_graph_revision: view.graph_revision, epic_id: edit.epicId,
    op: ({ startNow: "start_now", unstack: "split_stack", remove: "delete" } as const)[edit.action] };
  const selection = edit.itemIds.length === 1 ? { epic_id: edit.itemIds[0]! } : { epic_ids: [...edit.itemIds] };
  const base = { expected_graph_revision: view.graph_revision, ...selection };
  const target = view.chains.find(chain => chain.chain_id === edit.to.chainId)?.steps[edit.to.stepIndex]?.items[0]?.epic_id;
  switch (edit.type) {
    case "move_to_new_step": return { ...base, op: "move_to_new_step", index: edit.to.stepIndex > edit.from.stepIndex ? edit.to.stepIndex - 1 : edit.to.stepIndex };
    case "split_stack": return { ...base, op: "move_to_new_step", index: edit.to.stepIndex };
    case "join_stack": return { ...base, op: "join_stack", target_epic_id: target };
    case "move_between": return { ...base, op: "move_between", target_chain_id: edit.to.chainId,
      ...(edit.placement === "join" ? { target_epic_id: target } : { index: edit.to.stepIndex }) };
  }
}
export function optimisticOrder(view: CanonQueueView, edit: StepSortableEdit): CanonQueueView {
  const chains = applyStepSortableEdit(orderChains(view), edit);
  return { ...view, chains: view.chains.map(chain => ({ ...chain,
    steps: chains.find(next => next.id === chain.chain_id)!.steps.map((step, index) => ({ index, items: step.map(item => item.epic) })),
  })) };
}
