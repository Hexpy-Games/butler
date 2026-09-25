import { useRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../../lib/utils";
import { usePresence } from "../Presence";
import styles from "./Collapsible.module.css";

export interface CollapsibleProps extends HTMLAttributes<HTMLDivElement> {
  open: boolean;
  children: ReactNode;
}

/**
 * Height + opacity reveal for disclosure content. Content mounts when opened,
 * reveals from 0 with `interpolate-size`, and unmounts after the collapse
 * transition. Content that starts open does not replay the reveal.
 */
export function Collapsible({ open, children, className, ...props }: CollapsibleProps) {
  const { mounted, state, ref } = usePresence(open);
  const openedByToggle = useRef(false);
  if (!mounted) {
    openedByToggle.current = true;
    return null;
  }
  return (
    <div
      {...props}
      ref={ref}
      className={cn(styles.collapsible, className)}
      data-slot="collapsible"
      data-state={state}
      data-enter={openedByToggle.current ? "true" : undefined}
    >
      {children}
    </div>
  );
}
