import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import { Typo } from "../../components/Typo";
import { cn } from "../../lib/utils";
import styles from "./NavDropTarget.module.css";

export type NavDropPosition = "before" | "after" | "inside" | "group";

export interface NavDropTargetProps extends Omit<HTMLAttributes<HTMLDivElement>, "style"> {
  /** Where a dragged row would land relative to this row, while it hovers. */
  drop?: NavDropPosition;
  /** This row is the one being dragged. */
  dragging?: boolean;
  /** The row header box inside this item (a folder's children sit below it), in px from the item top. */
  indicator?: { top: number; height: number };
  /** Short label over the row for `group` drops ("Group together"). */
  hint?: ReactNode;
  children: ReactNode;
}

/**
 * A draggable sidebar tree item: the drop indicator (a line before or after
 * the row header, a ring for inside/group) and the dragged-row state. The
 * product owns the drag data and decides `drop`; the block owns how it looks
 * and moves.
 */
export function NavDropTarget({ drop, dragging = false, indicator, hint, className, children, ...props }: NavDropTargetProps) {
  const style = indicator
    ? ({ "--drop-row-top": `${indicator.top}px`, "--drop-row-height": `${indicator.height}px` } as CSSProperties)
    : undefined;
  return (
    <div
      {...props}
      className={cn(styles.item, className)}
      style={style}
      data-slot="nav-drop-target"
      data-drop={drop}
      data-dragging={dragging || undefined}
    >
      {children}
      {drop === "group" && hint ? (
        <span className={styles.hint} data-slot="nav-drop-hint">
          <Typo.Caption>{hint}</Typo.Caption>
        </span>
      ) : null}
    </div>
  );
}

export interface NavRootDropZoneProps extends Omit<HTMLAttributes<HTMLDivElement>, "style"> {
  /** A dragged row is over the zone. */
  active?: boolean;
  children: ReactNode;
}

/** The dashed "move to the top level" zone shown while a row is dragged. */
export function NavRootDropZone({ active = false, className, children, ...props }: NavRootDropZoneProps) {
  return (
    <div {...props} className={cn(styles.root, className)} data-slot="nav-root-drop" data-active={active}>
      <Typo.Body tone="secondary">{children}</Typo.Body>
    </div>
  );
}
