import type { DsBaseProps } from "../../lib/dsProps";
import type {
  HTMLAttributes,
  KeyboardEvent,
  PointerEvent,
} from "react";
import { cn } from "../../lib/utils";
import { windowDragClassName, type WindowDragProps } from "../../lib/windowDrag";
import styles from "./AdaptiveShell.module.css";

export function AdaptivePanelResizeHandle({
  side,
  ...props
}: Omit<DsBaseProps<HTMLAttributes<HTMLDivElement>>, "onKeyDown" | "onPointerDown"> & {
  side: "left" | "right";
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      className={styles.resizeHandle}
      data-side={side}
      role="separator"
      tabIndex={0}
      {...props}
    />
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
