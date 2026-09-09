import { forwardRef } from "react";
import type {
  CSSProperties,
  HTMLAttributes,
  MutableRefObject,
  ReactNode,
  Ref,
} from "react";
import { cn } from "../../lib/utils";
import styles from "./MessageRow.module.css";

export type MessageRowRole =
  | "assistant"
  | "user"
  | "system"
  | "system_event"
  | "tool_summary"
  | "automation";
export type MessageRowTone = "pending" | "failed" | "complete";

export interface MessageRowProps extends Omit<
  HTMLAttributes<HTMLElement>,
  "role"
> {
  role: MessageRowRole;
  children: ReactNode;
  avatar?: ReactNode;
  footer?: ReactNode;
  tone?: MessageRowTone;
  compactionEvent?: boolean;
  activity?: boolean;
  index?: number;
  style?: CSSProperties;
  rowRef?: Ref<HTMLElement>;
  dataTestClass?: string;
}

function assignRef(
  ref: Ref<HTMLElement> | undefined,
  node: HTMLElement | null,
) {
  if (!ref) return;
  if (typeof ref === "function") {
    ref(node);
    return;
  }
  (ref as MutableRefObject<HTMLElement | null>).current = node;
}

export const MessageRow = forwardRef<HTMLElement, MessageRowProps>(
  function MessageRow(
    {
      role,
      children,
      avatar,
      footer,
      tone = "complete",
      compactionEvent = false,
      activity = false,
      index,
      style,
      rowRef,
      dataTestClass,
      className,
      ...props
    },
    forwardedRef,
  ) {
    return (
      <article
        {...props}
        className={cn(
          styles.row,
          role === "assistant" && styles.assistant,
          role === "user" && styles.user,
          compactionEvent && styles.compactionEvent,
          activity && styles.activity,
          tone === "failed" && styles.failed,
          tone === "pending" && styles.pending,
          className,
        )}
        data-test-class={dataTestClass}
        data-index={index}
        ref={(node) => {
          assignRef(rowRef, node);
          assignRef(forwardedRef, node);
        }}
        style={style}
      >
        {avatar}
        <div className={styles.body} data-test-class="message-body">
          {children}
        </div>
        {footer && <div className={styles.rowFooter}>{footer}</div>}
      </article>
    );
  },
);

export function MessageFooter({
  children, dataTestClass = "assistant-footer",
}: { children: ReactNode; dataTestClass?: string }) {
  return (
    <div className={styles.footer} data-test-class={dataTestClass}>
      {children}
    </div>
  );
}

export function MessageStatusRow({
  children,
  dataTestClass,
}: {
  children: ReactNode;
  dataTestClass?: string;
}) {
  return (
    <div className={styles.statusRow} data-test-class={dataTestClass}>
      {children}
    </div>
  );
}

export function MessageStatusLabel({
  children,
  dataTestClass,
  mark,
  title,
}: {
  children: ReactNode;
  dataTestClass?: string;
  mark: ReactNode;
  title?: string;
}) {
  return (
    <div
      className={styles.statusLabel}
      data-test-class={dataTestClass}
      title={title}
    >
      <span aria-hidden="true" className={styles.statusMark}>
        {mark}
      </span>
      <div className={styles.statusContent}>{children}</div>
    </div>
  );
}
