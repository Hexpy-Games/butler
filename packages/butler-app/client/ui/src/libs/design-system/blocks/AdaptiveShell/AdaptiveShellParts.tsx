import type { DsBaseProps } from "../../lib/dsProps";
import {
  useId,
  type HTMLAttributes,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { cn } from "../../lib/utils";
import { windowDragClassName, type WindowDragProps } from "../../lib/windowDrag";
import styles from "./AdaptiveShell.module.css";
import { ResizeGrip, resizeHandleClassName } from "./ResizeGrip";

/**
 * A panel's resize handle over its divider: a pill grabber on hover, focus and drag, and with `hint`
 * ("Drag to resize") a two-line hint beside it (the `aria-label` over the hint), on the workspace side.
 */
export function AdaptivePanelResizeHandle({
  side,
  hint,
  ...props
}: Omit<DsBaseProps<HTMLAttributes<HTMLDivElement>>, "onKeyDown" | "onPointerDown" | "children"> & {
  side: "left" | "right";
  /** Second line of the hover hint ("Drag to resize"); the first line is the `aria-label`. */
  hint?: string;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
}) {
  const hintId = useId();
  return (
    <div
      className={cn(styles.resizeHandle, resizeHandleClassName)}
      data-side={side}
      role="separator"
      tabIndex={0}
      aria-describedby={hint ? hintId : undefined}
      {...props}
    >
      <ResizeGrip id={hintId} title={props["aria-label"]} hint={hint} side={side === "left" ? "end" : "start"} />
    </div>
  );
}

export function AdaptiveShellScrim({
  open,
  onDismiss,
  label,
}: {
  open: boolean;
  onDismiss: () => void;
  label: string;
}) {
  return (
    <button
      aria-hidden={!open}
      aria-label={label}
      className={styles.scrim}
      data-open={open}
      data-slot="adaptive-shell-scrim"
      onClick={onDismiss}
      tabIndex={open ? 0 : -1}
      type="button"
    />
  );
}

export function AdaptivePanelTitlebar({
  children,
  open,
  windowDrag,
  className,
  ...props
}: DsBaseProps<HTMLAttributes<HTMLDivElement>> & WindowDragProps & { open: boolean }) {
  return (
    <div
      className={cn(styles.panelTitlebar, windowDragClassName(windowDrag), className)}
      data-open={open}
      {...props}
    >
      {children}
    </div>
  );
}
