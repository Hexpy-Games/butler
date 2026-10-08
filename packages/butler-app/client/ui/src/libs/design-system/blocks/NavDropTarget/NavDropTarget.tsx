import type { DsBaseProps } from "../../lib/dsProps";
import { useState, type CSSProperties, type HTMLAttributes, type ReactNode } from "react";
import { Stack, type LayoutElement } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { cn } from "../../lib/utils";
import styles from "./NavDropTarget.module.css";
import { dsClass } from "../../lib/internal";
import type { NavDropAutoScrollEdge } from "./navDropAutoScroll";
import { NavDropEdge, NavDropLabel } from "./NavDropOverlay";

/**
 * Row drags: `before`/`after` open an insert slot, `inside`/`group` ring the header.
 * `outside`: a payload from outside the tree (picked elements, a browser tab) is over this row;
 * a ring and a label, and no row ever moves.
 */
export type NavDropPosition = "before" | "after" | "inside" | "group" | "outside";

export interface NavDropTargetProps extends Omit<DsBaseProps<HTMLAttributes<HTMLDivElement>>, "style"> {
  /** Where a dragged row would land relative to this row, while it hovers. */
  drop?: NavDropPosition;
  /** This row is the one being dragged. */
  dragging?: boolean;
  /** The row header box inside this item (a folder's children sit below it), in px from the item top. */
  indicator?: { top: number; height: number };
  /** Short label over the row for `group` drops ("Group together"), or beside it for `outside` drops ("Add to ‘Trip’"). */
  hint?: ReactNode;
  /** An `outside` payload cannot drop here: a dashed danger ring and label ("Can't drop here"). */
  invalid?: boolean;
  children: ReactNode;
}

/**
 * A draggable sidebar tree item: the drop feedback (a one-row slot with a
 * line for before/after, an inset ring for inside/group) and the dragged-row
 * state. The product owns the drag data and decides `drop` (hit-test with
 * `lib/dropZones`); the block owns how it looks and moves. Items must be
 * `CollapsibleList` rows inside a `NavDropScope`.
 */
export function NavDropTarget({ drop, dragging = false, indicator, hint, invalid = false, className, children, ...props }: NavDropTargetProps) {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const style = indicator
    ? ({ "--drop-row-top": `${indicator.top}px`, "--drop-row-height": `${indicator.height}px` } as CSSProperties)
    : undefined;
  return (
    <div
      {...props}
      ref={setNode}
      className={cn(styles.item, className)}
      style={style}
      data-slot="nav-drop-target"
      data-drop={drop}
      data-dragging={dragging || undefined}
      data-invalid={drop === "outside" && invalid ? "true" : undefined}
    >
      {children}
      {drop === "group" && hint ? (
        <span className={styles.hint} data-slot="nav-drop-hint">
          <Typo.Caption>{hint}</Typo.Caption>
        </span>
      ) : null}
      {drop === "outside" && hint ? <NavDropLabel anchor={node} indicator={indicator} invalid={invalid}>{hint}</NavDropLabel> : null}
    </div>
  );
}

export interface NavRootDropZoneProps extends Omit<DsBaseProps<HTMLAttributes<HTMLDivElement>>, "style"> {
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

export interface NavDropScopeProps extends Omit<DsBaseProps<HTMLAttributes<HTMLElement>>, "style"> {
  /** A drag is in progress over this tree: rows may move to open a slot. */
  active?: boolean;
  /** `outside`: the drag carries something from outside the tree; rows never move or open a slot. */
  payload?: "rows" | "outside";
  /** The list is auto-scrolling (useNavDropAutoScroll `edge`): a band with a chevron at that edge. */
  autoScroll?: NavDropAutoScrollEdge | null;
  as?: LayoutElement;
  children: ReactNode;
}

/**
 * Wraps a droppable tree (a column with the sidebar row spacing). It sizes
 * the insert slot (one row; none under reduced motion) and, while `active`,
 * lets folded rows paint the moved rows below their clip. Put the product's
 * drag-over and drop handlers here and hit-test rows with `lib/dropZones`.
 */
export function NavDropScope({ active = false, payload = "rows", autoScroll, as = "div", className, children, ...props }: NavDropScopeProps) {
  return (
    <Stack
      {...props}
      as={as}
      gap="xs"
      className={dsClass(styles.scope, className)}
      data-slot="nav-drop-scope"
      data-active={active ? "true" : undefined}
      data-payload={payload === "outside" ? "outside" : undefined}
    >
      {children}
      {active && autoScroll ? <NavDropEdge edge={autoScroll} /> : null}
    </Stack>
  );
}
