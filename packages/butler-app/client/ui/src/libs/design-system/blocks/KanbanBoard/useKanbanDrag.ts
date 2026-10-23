import type { DragEndEvent, DragMoveEvent, DragStartEvent } from "@dnd-kit/core";
import { getEventCoordinates } from "@dnd-kit/utilities";
import { useCallback, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { prefersReducedMotion } from "../../lib/motion";
import { IDLE_VIEW, sameTarget, type KanbanAnchor, type KanbanDragView, type KanbanScopeValue } from "./kanbanContext";
import { KANBAN_DRAG_LABELS, type KanbanDragLabels } from "./kanbanDragLabels";
import {
  indexOfTarget, insertionIndex, isNoopDrop, laneAtPoint, nextKeyboardTarget, targetAt,
  type KanbanDropTarget, type KanbanKey, type KanbanLaneBox, type KanbanMove,
} from "./kanbanDragModel";
import { laneCardIds, measureLanes, type KanbanRegistry } from "./kanbanMeasure";

export interface KanbanDragOptions {
  onMove: (move: KanbanMove) => void;
  canDrop?: (itemId: string, toLaneId: string) => boolean;
  labels?: Partial<KanbanDragLabels>;
  disabled?: boolean;
}

const ARROWS: Record<string, KanbanKey> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };

/** The anchor of the drop line: above the target card, after the lane's last card, or the lane's start. */
function anchorFor(registry: KanbanRegistry, view: KanbanDragView, target: KanbanDropTarget | null): KanbanAnchor | null {
  const { activeId } = view;
  const from = activeId ? registry.cards.get(activeId)?.laneId : undefined;
  if (!target || !activeId || !from) return null;
  if (isNoopDrop(laneCardIds(registry, from, null), activeId, from, target)) return null;
  if (target.beforeItemId) return { laneId: target.laneId, itemId: target.beforeItemId, side: "before" };
  const last = laneCardIds(registry, target.laneId, activeId).at(-1) ?? null;
  return { laneId: target.laneId, itemId: last, side: last ? "after" : "before" };
}

/** The slot a list lane opens for the card: its height plus the lane gap; none under reduced motion. */
function slotFor(element: HTMLElement): number {
  if (prefersReducedMotion()) return 0;
  const gap = Number.parseFloat(getComputedStyle(element.parentElement ?? element).rowGap) || 0;
  return element.getBoundingClientRect().height + gap;
}

/** The drag session: view state, measured lanes, and starting, retargeting and finishing a drag. */
function useDragSession({ onMove, canDrop, labels: overrides }: KanbanDragOptions) {
  const labels = useMemo(() => ({ ...KANBAN_DRAG_LABELS, ...overrides }), [overrides]);
  const registry = useRef<KanbanRegistry>({ lanes: new Map(), cards: new Map() }).current;
  const content = useRef(new Map()).current;
  const [view, setViewState] = useState<KanbanDragView>(IDLE_VIEW);
  const [announcement, setAnnouncement] = useState("");
  const viewRef = useRef(view);
  const lanesNow = useRef<() => KanbanLaneBox[]>(() => []);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const focusRequest = useRef<string | null>(null);
  const latest = useRef({ onMove, canDrop, labels });
  latest.current = { onMove, canDrop, labels };

  const setView = useCallback((next: KanbanDragView) => { viewRef.current = next; setViewState(next); }, []);
  const accepts = useCallback((laneId: string) => {
    const { activeId } = viewRef.current;
    return Boolean(activeId) && (latest.current.canDrop?.(activeId!, laneId) ?? true);
  }, []);
  const place = useCallback((target: KanbanDropTarget) => {
    const lane = lanesNow.current().find((candidate) => candidate.id === target.laneId);
    const label = registry.lanes.get(target.laneId)?.label ?? target.laneId;
    return { lane: label, position: lane ? indexOfTarget(lane, target) + 1 : 1 };
  }, [registry]);
  const retarget = useCallback((target: KanbanDropTarget | null) => {
    const current = viewRef.current;
    const next = target && accepts(target.laneId) ? target : null;
    if (sameTarget(current.target, next)) return false;
    setView({ ...current, target: next, anchor: anchorFor(registry, current, next) });
    return true;
  }, [accepts, registry, setView]);

  const begin = useCallback((itemId: string, mode: "pointer" | "keyboard") => {
    const card = registry.cards.get(itemId);
    if (!card) return false;
    lanesNow.current = measureLanes(registry, itemId);
    const order = laneCardIds(registry, card.laneId, null);
    const own = { laneId: card.laneId, beforeItemId: order[order.indexOf(itemId) + 1] ?? null };
    setView({ activeId: itemId, mode, target: own, anchor: null, slot: slotFor(card.element) });
    const { lane, position } = place(own);
    setAnnouncement(latest.current.labels.lifted(card.label, lane, position));
    return true;
  }, [place, registry, setView]);

  const finish = useCallback((drop: boolean) => {
    const { activeId, target, mode } = viewRef.current;
    const card = activeId ? registry.cards.get(activeId) : undefined;
    setView(IDLE_VIEW);
    pointer.current = null;
    if (!activeId || !card) return;
    const text = latest.current.labels;
    if (!drop) { setAnnouncement(text.cancelled(card.label)); return; }
    if (!target || isNoopDrop(laneCardIds(registry, card.laneId, null), activeId, card.laneId, target)) {
      setAnnouncement(text.unchanged(card.label));
      return;
    }
    const { lane, position } = place(target);
    if (mode === "keyboard") focusRequest.current = activeId;
    latest.current.onMove({ itemId: activeId, fromLaneId: card.laneId, toLaneId: target.laneId, beforeItemId: target.beforeItemId });
    setAnnouncement(text.dropped(card.label, lane, position));
  }, [place, registry, setView]);

  return { labels, registry, content, view, viewRef, announcement, setAnnouncement, lanesNow, pointer, focusRequest, latest,
    accepts, place, retarget, begin, finish };
}

/** State and handlers of one KanbanDragScope: pointer drags (via dnd-kit) and keyboard drags. */
export function useKanbanDrag(options: KanbanDragOptions) {
  const session = useDragSession(options);
  const { labels, registry, content, view, viewRef, announcement, setAnnouncement, lanesNow, pointer, focusRequest, latest } = session;
  const { accepts, place, retarget, begin, finish } = session;
  const disabled = options.disabled ?? false;

  /** Re-projects the pointer onto the lanes (after a move or an auto-scroll step). */
  const project = useCallback(() => {
    const point = pointer.current;
    if (!point || viewRef.current.mode !== "pointer") return;
    const lanes = lanesNow.current();
    const lane = laneAtPoint(lanes, point.x, point.y, viewRef.current.target?.laneId ?? null, viewRef.current.slot);
    retarget(lane ? targetAt(lane, insertionIndex(lane, point.x, point.y)) : null);
  }, [retarget]);

  const pointerHandlers = useMemo(() => ({
    onDragStart: (event: DragStartEvent) => { begin(String(event.active.id), "pointer"); },
    onDragMove: (event: DragMoveEvent) => {
      const start = getEventCoordinates(event.activatorEvent);
      if (start) pointer.current = { x: start.x + event.delta.x, y: start.y + event.delta.y };
      project();
    },
    onDragEnd: (_event: DragEndEvent) => finish(true),
    onDragCancel: () => finish(false),
  }), [begin, finish, project]);

  const keyMove = useCallback((key: KanbanKey) => {
    const current = viewRef.current;
    const card = current.activeId ? registry.cards.get(current.activeId) : undefined;
    if (!current.target || !card) return;
    lanesNow.current = measureLanes(registry, current.activeId);
    const next = nextKeyboardTarget(lanesNow.current(), current.target, key, accepts);
    if (!next || !retarget(next)) return;
    const anchor = viewRef.current.anchor;
    const element = (anchor?.itemId ? registry.cards.get(anchor.itemId)?.element : null) ?? registry.lanes.get(next.laneId)?.element;
    element?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    const { lane, position } = place(next);
    setAnnouncement(latest.current.labels.over(card.label, lane, position));
  }, [accepts, place, registry, retarget]);

  const onCardKey = useCallback((itemId: string, event: KeyboardEvent<HTMLElement>) => {
    const current = viewRef.current;
    const active = current.mode === "keyboard" && current.activeId === itemId;
    if (!active) {
      if (event.key !== " " || disabled || current.activeId) return false;
      return begin(itemId, "keyboard");
    }
    if (ARROWS[event.key]) keyMove(ARROWS[event.key]!);
    else if (event.key === " " || event.key === "Enter") finish(true);
    else if (event.key === "Escape" || event.key === "Tab") finish(false);
    else return false;
    return event.key !== "Tab";
  }, [begin, disabled, finish, keyMove]);

  const onCardBlur = useCallback((itemId: string) => {
    const current = viewRef.current;
    if (current.mode === "keyboard" && current.activeId === itemId) finish(false);
  }, [finish]);

  const takeFocus = useCallback((itemId: string) => {
    if (focusRequest.current !== itemId) return false;
    focusRequest.current = null;
    return true;
  }, []);

  const scope: KanbanScopeValue = useMemo(() => ({ view, registry, labels, disabled, content, onCardKey, onCardBlur, takeFocus }),
    [view, registry, labels, disabled, content, onCardKey, onCardBlur, takeFocus]);
  return { scope, announcement, pointerHandlers, project, pointer, focusRequest };
}
