import { createContext, useContext, type KeyboardEvent, type ReactNode } from "react";
import type { KanbanDragLabels } from "./kanbanDragLabels";
import type { KanbanDropTarget, KanbanLaneLayout } from "./kanbanDragModel";
import type { KanbanRegistry } from "./kanbanMeasure";

/** Where the drop line (and the slot opened for the card) sits. `itemId` null: the lane's start. */
export interface KanbanAnchor {
  laneId: string;
  itemId: string | null;
  side: "before" | "after";
}

export interface KanbanDragView {
  activeId: string | null;
  mode: "pointer" | "keyboard" | null;
  /** The lane and place a drop would go to; null when the pointer is outside every accepting lane. */
  target: KanbanDropTarget | null;
  /** Null when there is no target or the drop would leave the card where it is. */
  anchor: KanbanAnchor | null;
  /** Px of the slot opened at the anchor: the dragged card plus the lane gap (0 under reduced motion). */
  slot: number;
}

export interface KanbanScopeValue {
  view: KanbanDragView;
  registry: KanbanRegistry;
  labels: KanbanDragLabels;
  disabled: boolean;
  /** Card content by item id, for the drag overlay. */
  content: Map<string, ReactNode>;
  /** Space/arrows/Escape on a focused card; true when the key was handled. */
  onCardKey: (itemId: string, event: KeyboardEvent<HTMLElement>) => boolean;
  /** A keyboard-lifted card lost focus: the drag is cancelled. */
  onCardBlur: (itemId: string) => void;
  /** A card asks for focus after it remounted in its new lane (keyboard drop). */
  takeFocus: (itemId: string) => boolean;
}

export const KanbanScopeContext = createContext<KanbanScopeValue | null>(null);

/** The lane a card is in. */
export const KanbanLaneContext = createContext<{ laneId: string; layout: KanbanLaneLayout } | null>(null);

export const IDLE_VIEW: KanbanDragView = { activeId: null, mode: null, target: null, anchor: null, slot: 0 };

export function useKanbanScope(): KanbanScopeValue | null {
  return useContext(KanbanScopeContext);
}

/** Slot/line state of an anchor point: a card's before/after edge or a lane's start. */
export function anchorSide(view: KanbanDragView, laneId: string | null, itemId: string | null): "before" | "after" | null {
  const anchor = view.anchor;
  if (!anchor || anchor.laneId !== laneId || anchor.itemId !== itemId) return null;
  return anchor.side;
}

export function sameTarget(a: KanbanDropTarget | null, b: KanbanDropTarget | null): boolean {
  return a === b || (a !== null && b !== null && a.laneId === b.laneId && a.beforeItemId === b.beforeItemId);
}
