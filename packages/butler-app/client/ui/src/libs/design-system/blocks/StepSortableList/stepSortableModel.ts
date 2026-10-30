/**
 * The order model of a StepSortableList: chains of steps, each step one item or a flat 묶음
 * (stack) of items (stacks never nest). A drag carries one item, or a whole step (a collapsed
 * 묶음 drags as one); its drop resolves to a target (a gap between steps, or a step to join)
 * and becomes one semantic edit. Every index is the place in the chains BEFORE the edit.
 */
import type { ReactNode } from "react";

export interface StepSortableItem {
  /** Stable id; edits report it. */
  id: string;
  /** Name for announcements and the grip's label (usually the title). */
  label: string;
  /** Running: pinned (no grip, never dragged) and drawn in the running colour. */
  running?: boolean;
  /** Pinned without running: not draggable. */
  pinned?: boolean;
  /** Finished: the row is muted. */
  done?: boolean;
}

export interface StepSortableChain<TItem extends StepSortableItem = StepSortableItem> {
  id: string;
  /** Chain name for announcements. */
  label: string;
  /** Optional heading shown above the chain (a caption line). */
  title?: ReactNode;
  /** Steps in order (the first is the chain's head); a step with two or more items is a 묶음. No empty steps. */
  steps: readonly (readonly TItem[])[];
}

/** A place in a chain: a step index before the edit. */
export interface StepSortablePlace {
  chainId: string;
  stepIndex: number;
}

/**
 * `gap`: a new step lands before step `stepIndex` (`steps.length`: after the last).
 * `join`: the items join step `stepIndex`'s 묶음, at its end (flat).
 */
export interface StepSortableTarget extends StepSortablePlace {
  kind: "gap" | "join";
}

/**
 * The edit a drop makes. `itemIds`: the dragged item, or every item of a dragged step. `from` is
 * their step, `to` the gap (new step) or the joined step.
 * - `move_to_new_step`: a whole step moves to a new place in its chain.
 * - `split_stack`: items leave their 묶음 for a new step of their own in the same chain.
 * - `join_stack`: items join another step of their chain (flat).
 * - `move_between`: items move to another chain, as a new step or into a step.
 */
export type StepSortableEdit =
  | { type: "move_to_new_step" | "split_stack" | "join_stack"; itemIds: string[]; from: StepSortablePlace; to: StepSortablePlace }
  | { type: "move_between"; itemIds: string[]; from: StepSortablePlace; to: StepSortablePlace; placement: "new_step" | "join" };

export interface StepSortableLocation {
  chainIndex: number;
  stepIndex: number;
  itemIndex: number;
}

export function locateItem(chains: readonly StepSortableChain[], itemId: string): StepSortableLocation | null {
  for (let chainIndex = 0; chainIndex < chains.length; chainIndex += 1) {
    const steps = chains[chainIndex]!.steps;
    for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
      const itemIndex = steps[stepIndex]!.findIndex((item) => item.id === itemId);
      if (itemIndex >= 0) return { chainIndex, stepIndex, itemIndex };
    }
  }
  return null;
}

export const isDraggable = (item: StepSortableItem) => !item.running && !item.pinned;
/** A step with a running or pinned item stays put: it never drags as a whole and takes no joins. */
export const isPinnedStep = (step: readonly StepSortableItem[]) => step.some((item) => !isDraggable(item));

/** The edit a drop of `itemIds` (one item, or a whole step) on `target` makes; null when nothing changes or the target is refused. */
export function editFor(chains: readonly StepSortableChain[], itemIds: readonly string[], target: StepSortableTarget): StepSortableEdit | null {
  const at = itemIds[0] ? locateItem(chains, itemIds[0]) : null;
  const chain = chains.find((candidate) => candidate.id === target.chainId);
  if (!at || !chain) return null;
  const source = chains[at.chainIndex]!;
  const step = source.steps[at.stepIndex]!;
  if (!itemIds.every((id) => step.some((item) => item.id === id))) return null;
  const limit = target.kind === "gap" ? chain.steps.length : chain.steps.length - 1;
  if (target.stepIndex < 0 || target.stepIndex > limit) return null;
  if (target.kind === "join" && isPinnedStep(chain.steps[target.stepIndex]!)) return null;
  if (target.kind === "gap" && target.stepIndex === 0 && chain.steps[0] && isPinnedStep(chain.steps[0])) return null;
  const base = { itemIds: [...itemIds], from: { chainId: source.id, stepIndex: at.stepIndex }, to: { chainId: chain.id, stepIndex: target.stepIndex } };
  if (source.id !== chain.id) return { ...base, type: "move_between", placement: target.kind === "gap" ? "new_step" : "join" };
  if (target.kind === "join") return target.stepIndex === at.stepIndex ? null : { ...base, type: "join_stack" };
  if (itemIds.length < step.length) return { ...base, type: "split_stack" };
  const stays = target.stepIndex === at.stepIndex || target.stepIndex === at.stepIndex + 1;
  return stays ? null : { ...base, type: "move_to_new_step" };
}

/** Applies an edit (optimistic product state). A step left empty is removed. */
export function applyStepSortableEdit<TItem extends StepSortableItem>(
  chains: readonly StepSortableChain<TItem>[], edit: StepSortableEdit,
): StepSortableChain<TItem>[] {
  const next = chains.map((chain) => ({ ...chain, steps: chain.steps.map((step) => [...step]) }));
  const source = next.find((chain) => chain.id === edit.from.chainId);
  const target = next.find((chain) => chain.id === edit.to.chainId);
  const step = source?.steps[edit.from.stepIndex];
  const moved = step?.filter((item) => edit.itemIds.includes(item.id)) ?? [];
  if (!source || !target || !step || moved.length === 0) return next;
  const left = step.filter((item) => !edit.itemIds.includes(item.id));
  let index = edit.to.stepIndex;
  if (left.length === 0) {
    source.steps.splice(edit.from.stepIndex, 1);
    if (source === target && edit.from.stepIndex < index) index -= 1;
  } else source.steps[edit.from.stepIndex] = left;
  const join = edit.type === "join_stack" || (edit.type === "move_between" && edit.placement === "join");
  if (join) target.steps[index]?.push(...moved);
  else target.steps.splice(index, 0, moved);
  return next;
}

/**
 * Every place a keyboard drag visits, in reading order: per chain the gap before each step, the
 * step itself (join), and the gap after the last step.
 */
export function keyboardTargets(chains: readonly StepSortableChain[]): StepSortableTarget[] {
  return chains.flatMap((chain) => [
    ...chain.steps.flatMap((_, stepIndex): StepSortableTarget[] => [
      { chainId: chain.id, stepIndex, kind: "gap" },
      { chainId: chain.id, stepIndex, kind: "join" },
    ]),
    { chainId: chain.id, stepIndex: chain.steps.length, kind: "gap" },
  ]);
}

export const sameTarget = (a: StepSortableTarget | null, b: StepSortableTarget | null) =>
  a === b || (a !== null && b !== null && a.chainId === b.chainId && a.stepIndex === b.stepIndex && a.kind === b.kind);

/** Where the moved items end up after `edit`: their chain and 1-based step number. */
export function resultPlace(chains: readonly StepSortableChain[], edit: StepSortableEdit): { chain: string; step: number } | null {
  const next = applyStepSortableEdit(chains, edit);
  const at = locateItem(next, edit.itemIds[0]!);
  return at ? { chain: next[at.chainIndex]!.label, step: at.stepIndex + 1 } : null;
}
