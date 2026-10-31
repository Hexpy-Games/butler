import { applyStepSortableEdit, type StepSortableChain, type StepSortableEdit, type StepSortableItem } from "@/butler-ds";
import type { CanonQueueEdit, CanonQueueItem, CanonQueueView } from "@/app/canonQueue.ts";

export type OrderAction = { action: "startNow" | "unstack" | "remove"; epicId: string };
export interface OrderItem extends StepSortableItem { epic: CanonQueueItem }
const donePrefix = (chain: CanonQueueView["chains"][number]) => {
  const first = chain.steps.findIndex(step => step.items.some(item => item.state !== "done"));
  return first < 0 ? chain.steps.length : first;
};
export function orderChains(view: CanonQueueView): StepSortableChain<OrderItem>[] {
  return view.chains.map(chain => ({ id: chain.chain_id, label: chain.origin, steps: chain.steps.slice(donePrefix(chain)).map(step => step.items.map(epic => ({
    id: epic.epic_id, label: epic.title, epic, running: epic.state === "running" && !epic.hold_reason,
    done: epic.state === "done", pinned: epic.state === "running" || epic.state === "done",
  }))) }));
}

/** DS places precede removal; the API inserts after removing the selection. */
export function orderEditToApi(view: CanonQueueView, edit: StepSortableEdit | OrderAction): CanonQueueEdit {
  if ("action" in edit) return { expected_graph_revision: view.graph_revision, epic_id: edit.epicId,
    op: ({ startNow: "start_now", unstack: "split_stack", remove: "delete" } as const)[edit.action] };
  const selection = edit.itemIds.length === 1 ? { epic_id: edit.itemIds[0]! } : { epic_ids: [...edit.itemIds] };
  const base = { expected_graph_revision: view.graph_revision, ...selection };
  const chain = view.chains.find(chain => chain.chain_id === edit.to.chainId)!;
  const offset = donePrefix(chain);
  const target = chain.steps[edit.to.stepIndex + offset]?.items[0]?.epic_id;
  switch (edit.type) {
    case "move_to_new_step": return { ...base, op: "move_to_new_step", index: offset + (edit.to.stepIndex > edit.from.stepIndex ? edit.to.stepIndex - 1 : edit.to.stepIndex) };
    case "split_stack": return { ...base, op: "move_to_new_step", index: offset + edit.to.stepIndex };
    case "join_stack": return { ...base, op: "join_stack", target_epic_id: target };
    case "move_between": return { ...base, op: "move_between", target_chain_id: edit.to.chainId,
      ...(edit.placement === "join" ? { target_epic_id: target } : { index: offset + edit.to.stepIndex }) };
  }
}
export function optimisticOrder(view: CanonQueueView, edit: StepSortableEdit): CanonQueueView {
  const offset = (id: string) => donePrefix(view.chains.find(chain => chain.chain_id === id)!);
  const chains = applyStepSortableEdit(view.chains.map(chain => ({ id: chain.chain_id, label: chain.origin,
    steps: chain.steps.map(step => step.items.map(epic => ({ id: epic.epic_id, label: epic.title, epic }))),
  })), { ...edit, from: { ...edit.from, stepIndex: offset(edit.from.chainId) + edit.from.stepIndex },
    to: { ...edit.to, stepIndex: offset(edit.to.chainId) + edit.to.stepIndex } });
  return { ...view, chains: view.chains.map(chain => ({ ...chain,
    steps: chains.find(next => next.id === chain.chain_id)!.steps.map((step, index) => ({ index, items: step.map(item => item.epic) })),
  })) };
}

/** Started steps, including blocked heads, retain their index and exact predecessor membership. */
export function acceptsOrderEdit(view: CanonQueueView, edit: StepSortableEdit): boolean {
  const next = optimisticOrder(view, edit);
  return view.chains.every(chain => chain.steps.every((step, index) => {
    if (!step.items.some(item => item.state === "running")) return true;
    const target = next.chains.find(candidate => candidate.chain_id === chain.chain_id)!;
    const ids = (at: typeof step | undefined) => JSON.stringify(at?.items.map(item => item.epic_id).sort() ?? []);
    return step.items.filter(item => item.state === "running").every(item => target.steps[index]?.items.some(next => next.epic_id === item.epic_id))
      && ids(chain.steps[index - 1]) === ids(target.steps[index - 1]);
  }));
}
