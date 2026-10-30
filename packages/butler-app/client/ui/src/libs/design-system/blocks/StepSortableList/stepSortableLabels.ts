/**
 * Screen-reader copy of a StepSortableList. `chain` is the chain's label; `step` the 1-based step
 * number the item has (or would have) after the move. The product container passes localized
 * labels (Korean: 단계, 묶음).
 */
export interface StepSortableLabels {
  /** How to drag with the keyboard; read with every grip. */
  instructions: string;
  /** Role description of a grip. */
  roleDescription: string;
  /** Accessible name of a grip; `item` is an item's label or a whole 묶음's name (`stack`). */
  grip: (item: string) => string;
  /** Name of a whole 묶음 dragged as one step: its front item and how many it holds. */
  stack: (front: string, count: number) => string;
  lifted: (item: string, chain: string, step: number) => string;
  /** The keyboard moved the item over a gap: it would become its own step. */
  newStep: (item: string, chain: string, step: number) => string;
  /** The keyboard moved the item onto a step: it would join that step's 묶음. */
  join: (item: string, chain: string, step: number) => string;
  dropped: (item: string, chain: string, step: number) => string;
  cancelled: (item: string) => string;
  /** The drop left the item where it was. */
  unchanged: (item: string) => string;
}

/** English defaults. */
export const STEP_SORTABLE_LABELS: StepSortableLabels = {
  instructions: "Press Space or Enter to pick it up. Use the up and down arrow keys to move it between steps or onto a step to run it together, Space to drop it, Escape to cancel.",
  roleDescription: "draggable item",
  grip: (item) => `Move ${item}`,
  stack: (front, count) => `${front} and ${count - 1} more`,
  lifted: (item, chain, step) => `Picked up ${item}. ${chain}, step ${step}.`,
  newStep: (item, chain, step) => `${item}: new step ${step} in ${chain}.`,
  join: (item, chain, step) => `${item}: together with step ${step} in ${chain}.`,
  dropped: (item, chain, step) => `Dropped ${item} in ${chain}, step ${step}.`,
  cancelled: (item) => `Move of ${item} cancelled.`,
  unchanged: (item) => `${item} stays where it was.`,
};
