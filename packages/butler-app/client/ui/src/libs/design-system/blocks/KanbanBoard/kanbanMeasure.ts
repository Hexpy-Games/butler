import type { KanbanBox, KanbanLaneBox, KanbanLaneLayout } from "./kanbanDragModel";

/** What a KanbanDragScope knows about its mounted lanes and cards (DOM order is reading order). */
export interface KanbanLaneEntry {
  element: HTMLElement;
  layout: KanbanLaneLayout;
  label: string;
}

export interface KanbanCardEntry {
  element: HTMLElement;
  laneId: string;
  label: string;
}

export interface KanbanRegistry {
  lanes: Map<string, KanbanLaneEntry>;
  cards: Map<string, KanbanCardEntry>;
}

const SCROLLING = /(auto|scroll|overlay)/u;

/** Scroll containers from `element` up to (not including) `stop`, plus the page. */
function scrollers(element: HTMLElement, stop: HTMLElement | null): HTMLElement[] {
  const found: HTMLElement[] = [];
  for (let node = element.parentElement; node && node !== stop; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (SCROLLING.test(style.overflowX) || SCROLLING.test(style.overflowY)) found.push(node);
  }
  const page = document.scrollingElement as HTMLElement | null;
  if (stop === null && page && !found.includes(page)) found.push(page);
  return found;
}

interface Tracked<T> {
  box: T;
  scrollers: HTMLElement[];
  origin: Array<[number, number]>;
}

const track = <T>(box: T, list: HTMLElement[]): Tracked<T> => ({ box, scrollers: list, origin: list.map((node) => [node.scrollLeft, node.scrollTop]) });

function shift(tracked: Tracked<unknown>): [number, number] {
  let dx = 0;
  let dy = 0;
  tracked.scrollers.forEach((node, index) => {
    dx += tracked.origin[index]![0] - node.scrollLeft;
    dy += tracked.origin[index]![1] - node.scrollTop;
  });
  return [dx, dy];
}

const boxOf = (id: string, element: HTMLElement): KanbanBox => {
  const rect = element.getBoundingClientRect();
  return { id, top: rect.top, left: rect.left, width: rect.width, height: rect.height };
};

/** Lane cards in DOM order, without `skipId`. */
export function laneCardIds(registry: KanbanRegistry, laneId: string, skipId: string | null): string[] {
  return [...registry.cards.entries()]
    .filter(([id, card]) => card.laneId === laneId && id !== skipId && card.element.isConnected)
    .sort(([, a], [, b]) => (a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
    .map(([id]) => id);
}

/** Lanes in DOM order. */
export function laneIds(registry: KanbanRegistry): string[] {
  return [...registry.lanes.entries()]
    .filter(([, lane]) => lane.element.isConnected)
    .sort(([, a], [, b]) => (a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
    .map(([id]) => id);
}

/**
 * Lane and card boxes measured once (at drag start) and kept current through scrolling: each box
 * moves with the scroll offsets of the containers around it, never with drop feedback.
 */
export function measureLanes(registry: KanbanRegistry, skipId: string | null): () => KanbanLaneBox[] {
  const lanes = laneIds(registry).map((laneId) => {
    const entry = registry.lanes.get(laneId)!;
    const outer = scrollers(entry.element, null);
    const items = laneCardIds(registry, laneId, skipId).map((id) => {
      const element = registry.cards.get(id)!.element;
      return track(boxOf(id, element), [...scrollers(element, entry.element), ...outer]);
    });
    return { lane: track({ ...boxOf(laneId, entry.element), layout: entry.layout }, outer), items };
  });
  const moved = <T extends KanbanBox>(tracked: Tracked<T>): T => {
    const [dx, dy] = shift(tracked);
    return { ...tracked.box, left: tracked.box.left + dx, top: tracked.box.top + dy };
  };
  return () => lanes.map(({ lane, items }) => ({ ...moved(lane), items: items.map(moved) }));
}
