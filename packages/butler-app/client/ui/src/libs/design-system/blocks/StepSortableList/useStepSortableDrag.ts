import type { DragMoveEvent, DragStartEvent } from "@dnd-kit/core";
import { useCallback, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { createDropZoneTracker, measureDropBox, type DropZoneCandidate, type DropZoneHit } from "../../lib/dropZones";
import { STEP_SORTABLE_LABELS, type StepSortableLabels } from "./stepSortableLabels";
import {
  editFor, isDraggable, isPinnedStep, keyboardTargets, locateItem, resultPlace, sameTarget,
  type StepSortableChain, type StepSortableEdit, type StepSortableTarget,
} from "./stepSortableModel";

/** Ms the pointer rests on a step before a drop joins its 묶음. */
export const STEP_SORTABLE_JOIN_DWELL = 250;

export interface StepSortableDragView {
  /** Drag id: `item:<id>` (one item) or `step:<first id>` (a collapsed 묶음 as one step). */
  activeId: string | null;
  itemIds: readonly string[];
  mode: "pointer" | "keyboard" | "preview" | null;
  /** Where a drop would go; null when it would leave the items where they are (or is refused). */
  target: StepSortableTarget | null;
}

export interface StepSortableDragOptions {
  chains: readonly StepSortableChain[];
  /** Fanned 묶음 (by first item id): they take gaps only, no joins. */
  fanned: ReadonlySet<string>;
  onEdit: (edit: StepSortableEdit) => void;
  canDrop?: (edit: StepSortableEdit) => boolean;
  labels?: Partial<StepSortableLabels>;
  disabled?: boolean;
}

export const IDLE_VIEW: StepSortableDragView = { activeId: null, itemIds: [], mode: null, target: null };
const ARROWS: Record<string, -1 | 1> = { ArrowUp: -1, ArrowDown: 1 };
type StepKey = { chainId: string; stepIndex: number };
const keyOf = (chainId: string, stepIndex: number) => `${chainId}\u0000${stepIndex}`;

/** The items a drag id carries, its announced name, and whether it may move at all. */
export function payloadOf(chains: readonly StepSortableChain[], dragId: string, labels: StepSortableLabels) {
  const [kind, ...rest] = dragId.split(":");
  const at = locateItem(chains, rest.join(":"));
  const step = at ? chains[at.chainIndex]!.steps[at.stepIndex]! : null;
  if (!at || !step) return null;
  if (kind === "step") {
    return { at, itemIds: step.map((item) => item.id), label: labels.stack(step[0]!.label, step.length), movable: !isPinnedStep(step) };
  }
  const item = step[at.itemIndex]!;
  return { at, itemIds: [item.id], label: item.label, movable: isDraggable(item) };
}

/** Where a pointer hit drops: before/after a step is a gap, its middle (after the dwell) joins it. */
function targetOfHit(hit: DropZoneHit<string> | null, steps: Map<string, StepKey>): StepSortableTarget | null {
  const step = hit ? steps.get(hit.key) : undefined;
  if (!hit || !step) return null;
  if (hit.zone === "combine") return { ...step, kind: "join" };
  return { chainId: step.chainId, stepIndex: step.stepIndex + (hit.zone === "after" ? 1 : 0), kind: "gap" };
}

/**
 * Step boxes in layout position, frozen when the drag starts (the gap line added later never
 * moves the zones). The dragged step itself is left out unless an item leaves its 묶음 (then it
 * takes gaps only); fanned 묶음 take gaps only.
 */
function measureSteps(root: HTMLElement, itemIds: readonly string[], fanned: ReadonlySet<string>) {
  const steps = new Map<string, StepKey>();
  const heights = new Map<string, number>();
  const rows: DropZoneCandidate<string>[] = [];
  root.querySelectorAll<HTMLElement>("[data-step-chain][data-step-index]").forEach((element) => {
    const step = { chainId: element.dataset.stepChain!, stepIndex: Number(element.dataset.stepIndex) };
    const ids = (element.dataset.stepItems ?? "").split(" ");
    const own = ids.includes(itemIds[0]!);
    const box = measureDropBox(element, root);
    heights.set(keyOf(step.chainId, step.stepIndex), box.height);
    if (own && itemIds.length === ids.length) return;
    const key = keyOf(step.chainId, step.stepIndex);
    steps.set(key, step);
    rows.push({ key, ...box, combine: !own && !fanned.has(ids[0]!) });
  });
  return { steps, heights, rows };
}

/** Pointer coordinates of the event that started a drag (mouse or touch). */
function pointOf(event: Event | null): number {
  if (event && "touches" in event) {
    const touch = (event as TouchEvent).touches[0] ?? (event as TouchEvent).changedTouches[0];
    return touch?.clientY ?? 0;
  }
  return (event as MouseEvent | null)?.clientY ?? 0;
}

/** The drag session: view, frozen step boxes, announcements, and starting, retargeting and finishing a drag. */
function useDragSession(options: StepSortableDragOptions, root: RefObject<HTMLElement | null>) {
  const labels = useMemo(() => ({ ...STEP_SORTABLE_LABELS, ...options.labels }), [options.labels]);
  const [view, setViewState] = useState<StepSortableDragView>(IDLE_VIEW);
  const [announcement, setAnnouncement] = useState("");
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(new Map());
  const viewRef = useRef(view);
  const frozen = useRef<{ steps: Map<string, StepKey>; rows: DropZoneCandidate<string>[] }>({ steps: new Map(), rows: [] });
  const focusRequest = useRef<string | null>(null);
  const latest = useRef({ ...options, labels });
  latest.current = { ...options, labels };
  const setView = useCallback((next: StepSortableDragView) => { viewRef.current = next; setViewState(next); }, []);

  /** The edit for `target`, or null when the drop changes nothing or is refused. */
  const edit = useCallback((itemIds: readonly string[], target: StepSortableTarget | null) => {
    const next = target ? editFor(latest.current.chains, itemIds, target) : null;
    return next && (latest.current.canDrop?.(next) ?? true) ? next : null;
  }, []);
  const retarget = useCallback((target: StepSortableTarget | null) => {
    const current = viewRef.current;
    const next = current.activeId && edit(current.itemIds, target) ? target : null;
    if (sameTarget(current.target, next)) return false;
    setView({ ...current, target: next });
    return true;
  }, [edit, setView]);

  const begin = useCallback((dragId: string, mode: "pointer" | "keyboard") => {
    const { chains, fanned, disabled } = latest.current;
    const payload = payloadOf(chains, dragId, latest.current.labels);
    if (!payload || !payload.movable || disabled || viewRef.current.activeId || !root.current) return false;
    const measured = measureSteps(root.current, payload.itemIds, fanned);
    frozen.current = measured;
    setHeights(measured.heights);
    setView({ activeId: dragId, itemIds: payload.itemIds, mode, target: null });
    setAnnouncement(latest.current.labels.lifted(payload.label, chains[payload.at.chainIndex]!.label, payload.at.stepIndex + 1));
    return true;
  }, [root, setView]);

  const finish = useCallback((drop: boolean) => {
    const { activeId, itemIds, target, mode } = viewRef.current;
    setView(IDLE_VIEW);
    const payload = activeId ? payloadOf(latest.current.chains, activeId, latest.current.labels) : null;
    if (!activeId || !payload) return;
    const text = latest.current.labels;
    if (!drop) { setAnnouncement(text.cancelled(payload.label)); return; }
    const change = edit(itemIds, target);
    if (!change) { setAnnouncement(text.unchanged(payload.label)); return; }
    const place = resultPlace(latest.current.chains, change);
    if (mode === "keyboard") focusRequest.current = itemIds[0]!;
    latest.current.onEdit(change);
    if (place) setAnnouncement(text.dropped(payload.label, place.chain, place.step));
  }, [edit, setView]);

  return { labels, view, viewRef, heights, frozen, announcement, setAnnouncement, focusRequest, latest, edit, retarget, begin, finish };
}

type Session = ReturnType<typeof useDragSession>;

/** Pointer drags (dnd-kit): the pointer's y (scroll-adjusted) against the frozen step boxes, with the join dwell. */
function usePointerDrag(session: Session) {
  const { retarget, begin, finish, frozen } = session;
  const startY = useRef(0);
  const onHit = useRef(retarget);
  onHit.current = retarget;
  // The tracker reports every change of hit, including a join its dwell timer commits.
  const tracker = useMemo(() => createDropZoneTracker<string>({
    dwell: STEP_SORTABLE_JOIN_DWELL,
    onChange: (hit) => { onHit.current(targetOfHit(hit, frozen.current.steps)); },
  }), [frozen]);
  return useMemo(() => ({
    onDragStart: (event: DragStartEvent) => {
      startY.current = pointOf(event.activatorEvent);
      if (begin(String(event.active.id), "pointer")) tracker.update(startY.current, frozen.current.rows, performance.now());
    },
    onDragMove: (event: DragMoveEvent) => { tracker.update(startY.current + event.delta.y, frozen.current.rows, performance.now()); },
    onDragEnd: () => { tracker.reset(); finish(true); },
    onDragCancel: () => { tracker.reset(); finish(false); },
  }), [begin, finish, frozen, tracker]);
}

/** Keyboard drags from a grip: Space or Enter lifts, Up/Down visit gaps and steps, Space or Enter drops, Escape cancels. */
function useKeyboardDrag(session: Session) {
  const { viewRef, latest, edit, retarget, begin, finish, setAnnouncement } = session;
  const move = useCallback((direction: -1 | 1) => {
    const { activeId, itemIds, target } = viewRef.current;
    const { chains, fanned, labels } = latest.current;
    const payload = activeId ? payloadOf(chains, activeId, labels) : null;
    if (!payload) return;
    const all = keyboardTargets(chains);
    // Fanned 묶음 take gaps only, as with the pointer.
    const visits = (candidate: StepSortableTarget) => candidate.kind === "gap"
      || !fanned.has(chains.find((chain) => chain.id === candidate.chainId)!.steps[candidate.stepIndex]![0]!.id);
    const own: StepSortableTarget = { chainId: chains[payload.at.chainIndex]!.id, stepIndex: payload.at.stepIndex, kind: "join" };
    let index = all.findIndex((candidate) => sameTarget(candidate, target ?? own));
    for (index += direction; index >= 0 && index < all.length; index += direction) {
      const candidate = all[index]!;
      const change = visits(candidate) ? edit(itemIds, candidate) : null;
      if (!change || !retarget(candidate)) continue;
      const place = resultPlace(chains, change);
      if (place) setAnnouncement((candidate.kind === "join" ? labels.join : labels.newStep)(payload.label, place.chain, place.step));
      return;
    }
  }, [edit, latest, retarget, setAnnouncement, viewRef]);

  /** A key on a grip; true when the drag handled it. */
  const onGripKey = useCallback((dragId: string, event: KeyboardEvent<HTMLElement>) => {
    const current = viewRef.current;
    if (!(current.mode === "keyboard" && current.activeId === dragId)) {
      if (event.key !== " " && event.key !== "Enter") return false;
      return begin(dragId, "keyboard");
    }
    if (ARROWS[event.key]) move(ARROWS[event.key]!);
    else if (event.key === " " || event.key === "Enter") finish(true);
    else if (event.key === "Escape" || event.key === "Tab") finish(false);
    else return false;
    return event.key !== "Tab";
  }, [begin, finish, move, viewRef]);

  const onGripBlur = useCallback((dragId: string) => {
    const current = viewRef.current;
    if (current.mode === "keyboard" && current.activeId === dragId) finish(false);
  }, [finish, viewRef]);
  return { onGripKey, onGripBlur };
}

/**
 * State and handlers of one StepSortableList: pointer drags (dnd-kit sensors, hit testing on
 * lib/dropZones with a 250 ms join dwell) and keyboard drags from the grips, both announced.
 */
export function useStepSortableDrag(options: StepSortableDragOptions, root: RefObject<HTMLElement | null>) {
  const session = useDragSession(options, root);
  const pointerHandlers = usePointerDrag(session);
  const keyboard = useKeyboardDrag(session);
  return {
    view: session.view, heights: session.heights, labels: session.labels, announcement: session.announcement,
    focusRequest: session.focusRequest, pointerHandlers, ...keyboard,
  };
}

export const stepHeightKey = keyOf;
