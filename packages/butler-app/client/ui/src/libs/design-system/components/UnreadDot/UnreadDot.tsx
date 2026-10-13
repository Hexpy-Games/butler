import type { HTMLAttributes } from "react";
import type { DsBaseProps } from "../../lib/dsProps";
import { IconSlot, type IconSlotSize } from "../IconSlot";
import styles from "./UnreadDot.module.css";

export interface UnreadDotProps extends DsBaseProps<HTMLAttributes<HTMLSpanElement>> {
  /** Accessible name, such as "Unread". */
  label: string;
  /** The icon column the dot sits in; `sidebar` follows the sidebar density. */
  size?: IconSlotSize;
}

/**
 * A small accent dot for content the user has not seen yet. It sits in an
 * IconSlot one line tall, so it shares the trailing column of a row's status
 * marks and centers on the first line. Static: it never pulses.
 */
export function UnreadDot({ label, size = "sidebar", ...props }: UnreadDotProps) {
  return (
    <IconSlot size={size} minHeight="line" passive role="img" aria-label={label} data-slot="unread-dot" {...props}>
      <span className={styles.dot} aria-hidden="true" />
    </IconSlot>
  );
}
