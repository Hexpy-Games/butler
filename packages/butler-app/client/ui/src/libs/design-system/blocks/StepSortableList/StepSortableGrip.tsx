import { useDraggable } from "@dnd-kit/core";
import { useCallback, useLayoutEffect, type KeyboardEvent, type SyntheticEvent } from "react";
import { GripVertical } from "../../components/Icons";
import { IconButton } from "../../components/IconButton";
import { IconSlot } from "../../components/IconSlot";
import { useStepSortableScope } from "./stepSortableContext";
import styles from "./StepSortableList.module.css";

/** The card's drag node: the deck card or step it sits in, so the lifted copy takes the card's size. */
const DRAG_NODE = "[data-stack-deck-card], [data-stack-deck-front], [data-step-card]";
export const stopEvent = (event: SyntheticEvent) => event.stopPropagation();

/**
 * The reorder grip (SortableCardList's handle): the dnd-kit source of one item or a whole 묶음.
 * The pointer drags from the grip or the card (the card forwards its pointer events here); the
 * keyboard drags from the grip only. While its row is lifted the grip is a static glyph.
 */
export function StepSortableGrip({ dragId, label, movable }: { dragId: string; label: string; movable: boolean }) {
  const scope = useStepSortableScope();
  const enabled = movable && !scope.disabled;
  const drag = useDraggable({ id: dragId, disabled: !enabled, attributes: { roleDescription: scope.labels.roleDescription } });
  const { listeners: registry } = scope;
  useLayoutEffect(() => {
    if (!enabled || !drag.listeners) return undefined;
    registry.set(dragId, drag.listeners);
    return () => { registry.delete(dragId); };
  });
  const { setNodeRef } = drag;
  const nodeRef = useCallback((element: HTMLDivElement | null) => setNodeRef(element?.closest<HTMLElement>(DRAG_NODE) ?? element), [setNodeRef]);
  if (!enabled) return null;
  const lifted = scope.view.activeId === dragId && scope.view.mode === "pointer";
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (scope.onGripKey(dragId, event)) event.preventDefault();
  };
  return (
    <div ref={nodeRef} className={styles.grip} onClick={stopEvent} onMouseDown={stopEvent} onTouchStart={stopEvent}>
      {lifted ? <IconSlot size="md" tone="tertiary"><GripVertical size="md" /></IconSlot> : (
        <IconButton label={scope.labels.grip(label)} data-step-grip={dragId} {...drag.attributes} {...drag.listeners}
          aria-pressed={undefined} onKeyDown={onKeyDown} onBlur={() => scope.onGripBlur(dragId)}>
          <GripVertical size="md" />
        </IconButton>
      )}
    </div>
  );
}

/** A static grip for the lifted copy (same box, no button). */
export function StaticGrip() {
  return <div className={styles.grip} aria-hidden="true"><IconSlot size="md" tone="tertiary"><GripVertical size="md" /></IconSlot></div>;
}
