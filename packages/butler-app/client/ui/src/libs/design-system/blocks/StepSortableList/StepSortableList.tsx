import type { DsBaseProps } from "../../lib/dsProps";
import { DndContext, MouseSensor, TouchSensor, useSensor, useSensors } from "@dnd-kit/core";
import { Fragment, useCallback, useLayoutEffect, useMemo, useRef, useState, type HTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { Typo } from "../../components/Typo";
import { cn } from "../../lib/utils";
import type { StackDeckCardListeners, StackDeckLabels } from "../StackDeck";
import { StepSortableScope, type StepSortableRowContext, type StepSortableRowSlots, type StepSortableScopeValue } from "./stepSortableContext";
import type { StepSortableLabels } from "./stepSortableLabels";
import type { StepSortableChain, StepSortableEdit, StepSortableItem, StepSortableTarget } from "./stepSortableModel";
import { StepSortableLifted } from "./StepSortableLifted";
import { StepSortableGap, StepSortableStep } from "./StepSortableStep";
import { focusAfterDrop, listAutoScroll } from "./stepSortableFocus";
import { useStepSortableDrag, type StepSortableDragView } from "./useStepSortableDrag";
import styles from "./StepSortableList.module.css";

export interface StepSortableListProps<TItem extends StepSortableItem>
  extends Omit<DsBaseProps<HTMLAttributes<HTMLElement>>, "children" | "onChange"> {
  /** Ordered chains; each step is one item or a flat 묶음 (two or more, shown as a StackDeck). */
  chains: readonly StepSortableChain<TItem>[];
  /** Row content slots for an item; the block draws the card, the grip and the deck. */
  renderItem: (item: TItem, context: StepSortableRowContext) => StepSortableRowSlots;
  /** A drop or keyboard move made an edit. Apply it (optimistically, `applyStepSortableEdit`) and persist. */
  onEdit: (edit: StepSortableEdit) => void;
  /** Edits the product accepts; refused targets show no feedback and take no drop. Default: all. */
  canDrop?: (edit: StepSortableEdit) => boolean;
  /** Localized announcements and grip names; English by default. */
  labels?: Partial<StepSortableLabels>;
  /** Localized names of the 묶음 decks. */
  deckLabels?: Partial<StackDeckLabels>;
  /** Lock every row in place (read-only list). */
  disabled?: boolean;
  /** A static drag state (the items lifted over a target) for previews and docs; no live drag runs. */
  dragPreview?: { itemIds: string[]; target: StepSortableTarget };
}

/** dnd-kit's own live region would speak internal ids; the list announces moves itself. */
const QUIET = () => undefined;
const ANNOUNCEMENTS = { onDragStart: QUIET, onDragMove: QUIET, onDragOver: QUIET, onDragEnd: QUIET, onDragCancel: QUIET };

/** Fanned 묶음 by first item id. */
function useFanned() {
  const [fanned, setState] = useState<ReadonlySet<string>>(() => new Set());
  const setFanned = useCallback((id: string, open: boolean) => setState((current) => {
    if (current.has(id) === open) return current;
    const next = new Set(current);
    if (open) next.add(id); else next.delete(id);
    return next;
  }), []);
  return { fanned, setFanned };
}

/**
 * Ordered chains of steps (a head, then its follow-ups): drop between steps for a new step, rest
 * on a step (250 ms) to join its 묶음, move between chains, drag out of a fanned 묶음 to split
 * it. Pointer drags start on a card or its grip; the keyboard drags from the grip. The block
 * reports semantic edits; the product owns the order.
 */
export function StepSortableList<TItem extends StepSortableItem>({
  chains, renderItem, onEdit, canDrop, labels, deckLabels, disabled = false, dragPreview, className, ...props
}: StepSortableListProps<TItem>) {
  const root = useRef<HTMLElement | null>(null);
  const { fanned, setFanned } = useFanned();
  const drag = useStepSortableDrag({ chains, fanned, onEdit, canDrop, labels, disabled }, root);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
  );
  const view = useMemo<StepSortableDragView>(() => (dragPreview
    ? { activeId: `preview:${dragPreview.itemIds[0]}`, itemIds: dragPreview.itemIds, mode: "preview", target: dragPreview.target }
    : drag.view), [dragPreview, drag.view]);
  const listeners = useRef(new Map<string, StackDeckCardListeners>()).current;
  const cardListeners = useCallback((dragId: string): StackDeckCardListeners => ({
    onMouseDown: (event) => listeners.get(dragId)?.onMouseDown?.(event),
    onTouchStart: (event) => listeners.get(dragId)?.onTouchStart?.(event),
  }), [listeners]);
  const { onGripKey, onGripBlur, focusRequest, heights } = drag;
  const scope = useMemo<StepSortableScopeValue>(() => ({
    view, heights, labels: drag.labels, deckLabels, disabled, onGripKey, onGripBlur, listeners, cardListeners, fanned, setFanned,
    renderItem: renderItem as StepSortableScopeValue["renderItem"],
  }), [view, heights, drag.labels, deckLabels, disabled, onGripKey, onGripBlur, listeners, cardListeners, fanned, setFanned, renderItem]);
  useLayoutEffect(() => focusAfterDrop(root.current, focusRequest), [chains, focusRequest]);
  const autoScroll = useMemo(() => listAutoScroll(root), []);

  const gapAt = (chain: StepSortableChain, stepIndex: number) =>
    view.target?.kind === "gap" && view.target.chainId === chain.id && view.target.stepIndex === stepIndex
      ? <StepSortableGap follow={stepIndex > 0} /> : null;
  return (
    <section ref={root} className={cn(styles.list, className)} data-slot="step-sortable-list"
      data-dragging={view.mode ?? undefined} {...props}>
      <StepSortableScope.Provider value={scope}>
        <DndContext sensors={sensors} collisionDetection={() => []} autoScroll={autoScroll}
          accessibility={{ announcements: ANNOUNCEMENTS, screenReaderInstructions: { draggable: drag.labels.instructions } }}
          {...drag.pointerHandlers}>
          {chains.map((chain) => (
            <div key={chain.id} className={styles.chain} role="group" aria-label={chain.label}>
              {chain.title ? <Typo.Caption tone="secondary" truncate>{chain.title}</Typo.Caption> : null}
              <ol className={styles.steps}>
                {chain.steps.map((step, stepIndex) => (
                  <Fragment key={step[0]?.id ?? stepIndex}>
                    {gapAt(chain, stepIndex)}
                    <StepSortableStep chain={chain} step={step} stepIndex={stepIndex} />
                  </Fragment>
                ))}
                {gapAt(chain, chain.steps.length)}
              </ol>
            </div>
          ))}
          {typeof document === "undefined" ? null : createPortal(<StepSortableLifted chains={chains} root={root.current} />, document.body)}
        </DndContext>
      </StepSortableScope.Provider>
      <span className={styles.srOnly} aria-live="polite">{drag.announcement}</span>
    </section>
  );
}
