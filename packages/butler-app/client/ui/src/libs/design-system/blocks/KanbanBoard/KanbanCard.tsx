import { useDraggable } from "@dnd-kit/core";
import { useContext, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { Card } from "../../components/Card";
import { useComposedRefs } from "../../lib/composeRefs";
import { dsClass } from "../../lib/internal";
import { anchorSide, KanbanLaneContext, useKanbanScope } from "./kanbanContext";
import { useKanbanSlot } from "./useKanbanSlot";
import styles from "./KanbanBoard.module.css";

export interface KanbanCardProps {
  /** Stable id; `onMove` reports it. */
  itemId: string;
  /** Card name for drag announcements (usually its title). */
  label: string;
  children: ReactNode;
  /** Click or Enter opens the item (Space picks it up). */
  onOpen?: () => void;
  selected?: boolean;
  /** Not draggable (still opens). */
  disabled?: boolean;
}

/**
 * A card in a KanbanLane. Inside a KanbanDragScope it drags with the pointer (after 6px), with a
 * long press on touch, or with the keyboard (Space, arrows, Space); outside a scope it is a plain
 * card that opens.
 */
export function KanbanCard({ itemId, label, children, onOpen, selected = false, disabled = false }: KanbanCardProps) {
  const scope = useKanbanScope();
  const lane = useContext(KanbanLaneContext);
  const draggable = Boolean(scope && lane) && !disabled && !scope?.disabled;
  const drag = useDraggable({ id: itemId, disabled: !draggable, attributes: { roleDescription: scope?.labels.roleDescription } });
  const element = useRef<HTMLDivElement | null>(null);
  const ref = useComposedRefs(element, drag.setNodeRef);
  const view = scope?.view;
  const side = view && lane ? anchorSide(view, lane.laneId, itemId) : null;
  useKanbanSlot(element, side, lane?.layout === "list" ? (view?.slot ?? 0) : 0, Boolean(view?.activeId));
  useLayoutEffect(() => {
    const node = element.current;
    if (!scope || !lane || !node) return;
    scope.registry.cards.set(itemId, { element: node, laneId: lane.laneId, label });
    scope.content.set(itemId, children);
    return () => {
      if (scope.registry.cards.get(itemId)?.element !== node) return;
      scope.registry.cards.delete(itemId);
      scope.content.delete(itemId);
    };
  });
  useLayoutEffect(() => {
    if (scope?.takeFocus(itemId)) (element.current?.firstElementChild as HTMLElement | null)?.focus();
  }, [scope, itemId]);

  const lifted = view?.activeId === itemId;
  // Space picks the card up (never clicks it); Enter opens it through Card's button behavior.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || !draggable) return;
    if (scope?.onCardKey(itemId, event) || event.key === " ") event.preventDefault();
  };
  const focusable = draggable || Boolean(onOpen);
  return (
    <div ref={ref} className={styles.item} data-kanban-item={itemId} data-drop={side ?? undefined}
      data-lifted={lifted ? view?.mode ?? undefined : undefined} data-draggable={draggable ? "true" : undefined}>
      <Card className={dsClass(styles.card)} interactive={focusable} selected={selected} padding="md"
        {...(draggable ? drag.attributes : {})} {...(draggable ? drag.listeners : {})}
        role={focusable ? "button" : undefined} tabIndex={focusable ? 0 : undefined} aria-pressed={undefined}
        onClick={onOpen} onKeyDown={onKeyDown} onBlur={() => scope?.onCardBlur(itemId)}>
        {children}
      </Card>
    </div>
  );
}
