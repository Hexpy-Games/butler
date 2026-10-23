/**
 * Geometry of a KanbanDragScope drag: which lane is under the pointer, where in it a card would
 * land, and where the keyboard moves it next. Lanes and cards are measured in layout position
 * when the drag starts (drop feedback only adds slots later), so feedback never moves the zones
 * under the pointer.
 */

/** A drop: `beforeItemId` is the card the item lands above, or null for the lane's end. */
export interface KanbanMove {
  itemId: string;
  fromLaneId: string;
  toLaneId: string;
  beforeItemId: string | null;
}

/**
 * Applies a move to lanes of item ids (optimistic product state): out of the old lane, in above
 * `beforeItemId` or at the end of the new one.
 */
export function applyKanbanMove(lanes: Readonly<Record<string, readonly string[]>>, { itemId, fromLaneId, toLaneId, beforeItemId }: KanbanMove): Record<string, string[]> {
  const next: Record<string, string[]> = Object.fromEntries(Object.entries(lanes).map(([id, items]) => [id, [...items]]));
  next[fromLaneId] = (next[fromLaneId] ?? []).filter((id) => id !== itemId);
  const target = (next[toLaneId] ?? []).filter((id) => id !== itemId);
  const at = beforeItemId ? target.indexOf(beforeItemId) : -1;
  target.splice(at < 0 ? target.length : at, 0, itemId);
  next[toLaneId] = target;
  return next;
}

export interface KanbanDropTarget {
  laneId: string;
  beforeItemId: string | null;
}

export interface KanbanBox {
  id: string;
  top: number;
  left: number;
  width: number;
  height: number;
}

export type KanbanLaneLayout = "list" | "grid";

/** A lane and its cards in reading order, without the dragged card. */
export interface KanbanLaneBox extends KanbanBox {
  layout: KanbanLaneLayout;
  items: KanbanBox[];
}

export type KanbanKey = "up" | "down" | "left" | "right";

const right = (box: KanbanBox) => box.left + box.width;
const bottom = (box: KanbanBox) => box.top + box.height;

/** Insertion index (0..items.length) for a point inside `lane`. */
export function insertionIndex(lane: KanbanLaneBox, x: number, y: number): number {
  let index = 0;
  for (const item of lane.items) {
    const before = lane.layout === "grid"
      ? bottom(item) < y || (y >= item.top && x > item.left + item.width / 2)
      : y > item.top + item.height / 2;
    if (!before) break;
    index += 1;
  }
  return index;
}

/**
 * The lane under the point. The current lane keeps `slack` px below its bottom, so a lane that
 * grew a slot for the dragged card stays the target while the pointer is over that slot.
 */
export function laneAtPoint(lanes: readonly KanbanLaneBox[], x: number, y: number, currentId: string | null, slack: number): KanbanLaneBox | null {
  return lanes.find((lane) => x >= lane.left && x <= right(lane) && y >= lane.top
    && y <= bottom(lane) + (lane.id === currentId ? slack : 0)) ?? null;
}

export function targetAt(lane: KanbanLaneBox, index: number): KanbanDropTarget {
  return { laneId: lane.id, beforeItemId: lane.items[index]?.id ?? null };
}

export function indexOfTarget(lane: KanbanLaneBox, target: KanbanDropTarget): number {
  const index = target.beforeItemId === null ? -1 : lane.items.findIndex((item) => item.id === target.beforeItemId);
  return index < 0 ? lane.items.length : index;
}

/** A drop that leaves the item where it is: its own lane, above the card that already follows it. */
export function isNoopDrop(laneOrder: readonly string[], itemId: string, fromLaneId: string, target: KanbanDropTarget): boolean {
  if (target.laneId !== fromLaneId) return false;
  const at = laneOrder.indexOf(itemId);
  return at >= 0 && (laneOrder[at + 1] ?? null) === target.beforeItemId;
}

const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
const centerX = (box: KanbanBox) => box.left + box.width / 2;
const centerY = (box: KanbanBox) => box.top + box.height / 2;

/** The nearest accepting lane beside `from` (same row) or above/below it (another board). */
function neighborLane(lanes: readonly KanbanLaneBox[], from: KanbanLaneBox, key: KanbanKey, accepts: (laneId: string) => boolean) {
  const sideways = key === "left" || key === "right";
  const candidates = lanes.filter((lane) => {
    if (lane.id === from.id || !accepts(lane.id)) return false;
    if (sideways) {
      const ahead = key === "right" ? lane.left >= right(from) - 1 : right(lane) <= from.left + 1;
      return ahead && overlap(lane.top, bottom(lane), from.top, bottom(from)) > 0;
    }
    return key === "down" ? lane.top >= bottom(from) - 1 : bottom(lane) <= from.top + 1;
  });
  const distance = (lane: KanbanLaneBox) => sideways
    ? Math.abs(centerX(lane) - centerX(from))
    : Math.abs(centerY(lane) - centerY(from)) * 4 + Math.abs(centerX(lane) - centerX(from));
  return candidates.sort((a, b) => distance(a) - distance(b))[0] ?? null;
}

/**
 * Keyboard step. Up/Down move one place in a list lane and leave it past its ends for the lane
 * above or below (another board); in a grid lane Left/Right step through the cards first. Left/
 * Right otherwise pick the neighbor lane in the same row and keep the place, clamped.
 */
export function nextKeyboardTarget(
  lanes: readonly KanbanLaneBox[], current: KanbanDropTarget, key: KanbanKey, accepts: (laneId: string) => boolean,
): KanbanDropTarget | null {
  const lane = lanes.find((candidate) => candidate.id === current.laneId);
  if (!lane) return null;
  const index = indexOfTarget(lane, current);
  const last = lane.items.length;
  const stepKeys: [KanbanKey, KanbanKey] = lane.layout === "grid" ? ["left", "right"] : ["up", "down"];
  if (key === stepKeys[0] && index > 0) return targetAt(lane, index - 1);
  if (key === stepKeys[1] && index < last) return targetAt(lane, index + 1);
  const next = neighborLane(lanes, lane, key, accepts);
  if (!next) return null;
  if (key === "up") return targetAt(next, next.items.length);
  if (key === "down") return targetAt(next, 0);
  return targetAt(next, Math.min(index, next.items.length));
}
