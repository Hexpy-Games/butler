import type { ReactNode } from "react";
import styles from "./MessageRow.module.css";

/** The answer text of a bubble row: the user bubble's shape, fill and width, aligned left. */
export function MessageBubble({ children, dataTestClass = "assistant-bubble" }: { children: ReactNode; dataTestClass?: string }) {
  return <div className={styles.bubble} data-test-class={dataTestClass}>{children}</div>;
}

/** Files, cards and panels under a bubble: aligned to its left edge and no wider than it. */
export function MessageBubbleAttachments({ children, dataTestClass }: { children: ReactNode; dataTestClass?: string }) {
  return <div className={styles.bubbleAttachments} data-test-class={dataTestClass}>{children}</div>;
}
