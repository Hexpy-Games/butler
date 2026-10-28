import { createContext, useContext, type KeyboardEvent, type ReactNode } from "react";
import type { StackDeckCardListeners, StackDeckLabels } from "../StackDeck";
import type { StepSortableLabels } from "./stepSortableLabels";
import type { StepSortableItem } from "./stepSortableModel";
import type { StepSortableDragView } from "./useStepSortableDrag";

/** Where a row sits, for the product's row content. */
export interface StepSortableRowContext {
  chainId: string;
  /** 0-based step index in the chain (0: the chain's head). */
  stepIndex: number;
  /** 1-based step number. */
  stepNumber: number;
  /** Items in the row's step (two or more: a 묶음; the collapsed front says “외 N건”). */
  count: number;
  /** A card of a fanned 묶음 (the compact card anatomy: title, then grip · caption · ⋯). */
  expanded: boolean;
  /** The lifted copy under the pointer. */
  lifted: boolean;
  /** On the lifted copy: what a drop does now, for its caption (함께 진행 / 새 단계로). */
  outcome: "join" | "new_step" | null;
}

/** A row's content slots; the block adds the grip in front and the card around it. */
export interface StepSortableRowSlots {
  /** Step number or status glyph, in the leading icon slot. */
  marker?: ReactNode;
  title: ReactNode;
  /** Short status after the title, at the end of the title line (진행 중 · 12분, 대기, 멈춤). */
  meta?: ReactNode;
  /** One read-only line under the title (progress, or “<previous> 끝나면”). */
  caption?: ReactNode;
  /** Trailing control (an OverflowActionMenu); a row without one keeps its room so statuses line up. */
  trailing?: ReactNode;
}

export interface StepSortableScopeValue {
  view: StepSortableDragView;
  /** Step heights frozen at drag start (the join ring's height), by chain and step index. */
  heights: ReadonlyMap<string, number>;
  labels: StepSortableLabels;
  deckLabels?: Partial<StackDeckLabels>;
  disabled: boolean;
  renderItem: (item: StepSortableItem, context: StepSortableRowContext) => StepSortableRowSlots;
  onGripKey: (dragId: string, event: KeyboardEvent<HTMLElement>) => boolean;
  onGripBlur: (dragId: string) => void;
  /** Rows register their drag listeners; cards forward pointer events to them. */
  listeners: Map<string, StackDeckCardListeners>;
  cardListeners: (dragId: string) => StackDeckCardListeners;
  fanned: ReadonlySet<string>;
  setFanned: (firstItemId: string, open: boolean) => void;
}

export const StepSortableScope = createContext<StepSortableScopeValue | null>(null);

export function useStepSortableScope(): StepSortableScopeValue {
  const scope = useContext(StepSortableScope);
  if (!scope) throw new Error("StepSortableList rows render inside a StepSortableList");
  return scope;
}

/** Drag id of one item, or of a whole step (a collapsed 묶음) by its first item. */
export const itemDragId = (itemId: string) => `item:${itemId}`;
export const stepDragId = (firstItemId: string) => `step:${firstItemId}`;
