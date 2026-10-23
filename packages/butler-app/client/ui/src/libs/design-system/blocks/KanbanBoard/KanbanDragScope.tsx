import {
  defaultDropAnimationSideEffects, DndContext, DragOverlay, MouseSensor, TouchSensor, useSensor, useSensors,
  type DropAnimation,
} from "@dnd-kit/core";
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Card } from "../../components/Card";
import { dsClass, dsStyle } from "../../lib/internal";
import { motionDuration, motionEasing, prefersReducedMotion } from "../../lib/motion";
import { KanbanScopeContext } from "./kanbanContext";
import type { KanbanDragLabels } from "./kanbanDragLabels";
import type { KanbanMove } from "./kanbanDragModel";
import { KanbanFlip } from "./KanbanFlip";
import { useKanbanAutoScroll } from "./useKanbanAutoScroll";
import { useKanbanDrag } from "./useKanbanDrag";
import styles from "./KanbanBoard.module.css";

export interface KanbanDragScopeProps {
  /** Every KanbanBoard whose lanes trade cards: one board, or one per section of a page. */
  children: ReactNode;
  /**
   * A card was dropped somewhere new: same lane (reorder), another lane or another board.
   * Apply it (optimistically) and persist; to reject, leave or restore the order and the card
   * glides back.
   */
  onMove: (move: KanbanMove) => void;
  /** Lanes that may take `itemId`; others neither highlight nor take the drop. Default: all. */
  canDrop?: (itemId: string, toLaneId: string) => boolean;
  /** Localized announcements; English by default. */
  labels?: Partial<KanbanDragLabels>;
  /** Lock every card in place (read-only board). */
  disabled?: boolean;
}

/** dnd-kit's own live region would speak internal ids; the scope announces moves itself. */
const QUIET = () => undefined;
const ANNOUNCEMENTS = { onDragStart: QUIET, onDragMove: QUIET, onDragOver: QUIET, onDragEnd: QUIET, onDragCancel: QUIET };

/** The overlay settles into the card's new place (or back home) and lands from its lift (.dropping). */
function dropAnimation(): DropAnimation | null {
  if (prefersReducedMotion()) return null;
  return {
    duration: motionDuration("base"),
    easing: motionEasing("emphasized"),
    sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: "0" } }, className: { dragOverlay: styles.dropping } }),
  };
}

/**
 * Lets cards move between the lanes of every KanbanBoard inside it, and between those boards:
 * pointer (6px), touch (long press, so the page still scrolls), keyboard (Space, arrows, Space).
 * Drop feedback, motion, auto-scroll and announcements live here; the product owns the order.
 */
export function KanbanDragScope({ children, onMove, canDrop, labels, disabled = false }: KanbanDragScopeProps) {
  const drag = useKanbanDrag({ onMove, canDrop, labels, disabled });
  const { view, content } = drag.scope;
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
  );
  useKanbanAutoScroll(view.mode === "pointer", drag.pointer, drag.project);
  const { focusRequest } = drag;
  useEffect(() => { if (!view.activeId) focusRequest.current = null; }, [view.activeId, focusRequest]);
  const active = view.mode === "pointer" && view.activeId ? content.get(view.activeId) : null;
  const root = useRef<HTMLDivElement | null>(null);
  // Fixed overlays break under contained or transformed ancestors (the workspace), so the overlay is
  // portaled to <body> and keeps the scope's theme class (a light panel in dark chrome).
  const theme = root.current?.closest(".theme-dark, .theme-light");
  const overlay = (
    <div className={theme?.classList.contains("theme-dark") ? "theme-dark" : theme ? "theme-light" : undefined}>
      <DragOverlay className={styles.overlayLayer} dropAnimation={dropAnimation()}>
        {active ? <Card className={dsClass(styles.card, styles.overlay)} interactive padding="md">{active}</Card> : null}
      </DragOverlay>
    </div>
  );
  return (
    <KanbanScopeContext.Provider value={drag.scope}>
      <DndContext sensors={sensors} collisionDetection={() => []} autoScroll={false}
        accessibility={{ announcements: ANNOUNCEMENTS, screenReaderInstructions: { draggable: drag.scope.labels.instructions } }}
        {...drag.pointerHandlers}>
        <div ref={root} className={styles.scope} data-slot="kanban-drag-scope" data-dragging={view.mode ?? undefined}
          style={dsStyle({ "--kanban-slot": `${view.slot}px` })}>
          <KanbanFlip registry={drag.scope.registry} activeId={view.activeId} mode={view.mode} anchorLaneId={view.anchor?.laneId ?? null}>{children}</KanbanFlip>
        </div>
        {typeof document === "undefined" ? null : createPortal(overlay, document.body)}
      </DndContext>
      <span className={styles.srOnly} aria-live="polite">{drag.announcement}</span>
    </KanbanScopeContext.Provider>
  );
}
