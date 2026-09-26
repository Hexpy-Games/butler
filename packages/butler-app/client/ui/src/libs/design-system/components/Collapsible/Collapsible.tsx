import type { DsBaseProps } from "../../lib/dsProps";
import { useRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../../lib/utils";
import { usePresence } from "../Presence";
import styles from "./Collapsible.module.css";

export interface CollapsibleProps extends DsBaseProps<HTMLAttributes<HTMLDivElement>> {
  open: boolean;
  children: ReactNode;
  /**
   * Keep closed content mounted instead of unmounting it, for content that
   * must keep its state. `true` hides it (inert, visibility hidden);
   * `"focusable"` only collapses it (height 0, no pointer events) so its
   * owner can reopen it on focus (the composer editor).
   */
  keepMounted?: boolean | "focusable";
  /** Reveal on the first mount too (a list row inserted after the list rendered). */
  appear?: boolean;
  /** Called once closed content has finished its exit (and unmounted). */
  onExitComplete?: () => void;
}

/**
 * Height + opacity reveal for disclosure content. Content mounts when opened,
 * reveals from 0 with `interpolate-size`, and unmounts after the collapse
 * transition. Content that starts open does not replay the reveal unless
 * `appear` is set.
 */
export function Collapsible({ open, children, className, keepMounted = false, appear = false, onExitComplete, ...props }: CollapsibleProps) {
  const { mounted, state, ref } = usePresence(open, { onExitComplete });
  const openedByToggle = useRef(appear);
  if (!open && keepMounted) openedByToggle.current = true;
  if (!mounted && !keepMounted) {
    openedByToggle.current = true;
    return null;
  }
  return (
    <div
      {...props}
      ref={ref}
      className={cn(styles.collapsible, className)}
      data-slot={(props as { "data-slot"?: string })["data-slot"] ?? "collapsible"}
      data-state={state}
      data-enter={openedByToggle.current ? "true" : undefined}
      data-keep-mounted={keepMounted === "focusable" ? "focusable" : keepMounted ? "hidden" : undefined}
      inert={keepMounted === true && !open ? true : undefined}
    >
      {children}
    </div>
  );
}
