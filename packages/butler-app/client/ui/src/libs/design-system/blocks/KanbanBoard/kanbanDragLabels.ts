/** Screen-reader copy of a KanbanDragScope drag. Positions are 1-based places in the lane. */
export interface KanbanDragLabels {
  /** How to drag with the keyboard; read with every card. */
  instructions: string;
  /** Role description of a draggable card. */
  roleDescription: string;
  lifted: (item: string, lane: string, position: number) => string;
  /** The keyboard moved the card to a new place (not yet dropped). */
  over: (item: string, lane: string, position: number) => string;
  dropped: (item: string, lane: string, position: number) => string;
  cancelled: (item: string) => string;
  /** The drop was not accepted (canDrop) or left the item where it was. */
  unchanged: (item: string) => string;
}

/** English defaults; the product container passes localized labels. */
export const KANBAN_DRAG_LABELS: KanbanDragLabels = {
  instructions: "Press Space to pick the card up. Use the arrow keys to move it within or between lanes, Space to drop it, Escape to cancel.",
  roleDescription: "draggable card",
  lifted: (item, lane, position) => `Picked up ${item}. ${lane}, position ${position}.`,
  over: (item, lane, position) => `${item}: ${lane}, position ${position}.`,
  dropped: (item, lane, position) => `Dropped ${item} in ${lane}, position ${position}.`,
  cancelled: (item) => `Move of ${item} cancelled.`,
  unchanged: (item) => `${item} stays where it was.`,
};
