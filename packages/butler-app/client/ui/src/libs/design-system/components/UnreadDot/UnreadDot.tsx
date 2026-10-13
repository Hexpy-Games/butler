import { useSyncExternalStore, type HTMLAttributes } from "react";
import type { DsBaseProps } from "../../lib/dsProps";
import { IconSlot, type IconSlotSize } from "../IconSlot";
import { usePresence } from "../Presence";
import { prefersReducedMotion, subscribeReducedMotion } from "../../lib/motion";
import styles from "./UnreadDot.module.css";

export interface UnreadDotProps extends DsBaseProps<HTMLAttributes<HTMLSpanElement>> {
  /** Accessible name, such as "Unread". */
  label: string;
  /** The icon column the dot sits in; `sidebar` follows the sidebar density. */
  size?: IconSlotSize;
  /** False fades the dot out, then unmounts it; true scales it in. Default true. */
  present?: boolean;
  /** Called once the dot has left after `present` turned false. */
  onExitComplete?: () => void;
}

/** The OS setting, the app override or the DS Viewer scope. */
const subscribeMotion = (onChange: () => void) => subscribeReducedMotion(() => onChange());

/**
 * A small accent dot for content the user has not seen yet. It sits in an
 * IconSlot one line tall, so it shares the trailing column of a row's status
 * marks and centers on the first line. It scales and fades in, fades out when
 * read (interruptible transitions), shows and hides instantly under reduced
 * motion, and never pulses.
 */
export function UnreadDot({ label, size = "sidebar", present = true, onExitComplete, ...props }: UnreadDotProps) {
  const { mounted, state, ref } = usePresence(present, { onExitComplete });
  const reduced = useSyncExternalStore(subscribeMotion, prefersReducedMotion, () => false);
  if (!mounted) return null;
  return (
    <IconSlot size={size} minHeight="line" passive role="img" aria-label={label}
      aria-hidden={present ? undefined : true} data-slot="unread-dot" {...props}>
      <span ref={ref} className={styles.dot} data-state={state} data-reduced={reduced || undefined} aria-hidden="true" />
    </IconSlot>
  );
}
