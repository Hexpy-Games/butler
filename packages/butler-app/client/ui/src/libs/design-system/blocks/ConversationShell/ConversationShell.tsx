import type { CSSProperties, ReactNode, Ref } from "react";
import { cn } from "../../lib/utils";
import styles from "./ConversationShell.module.css";

export interface ConversationShellProps {
  children: ReactNode;
  composerReserve: number;
  contentGutter?: string;
  titleIconGap?: string;
  titleIconSize?: string;
}

export function ConversationShell({
  children,
  composerReserve,
  contentGutter,
  titleIconGap,
  titleIconSize,
}: ConversationShellProps) {
  const style = {
    "--composer-reserve": `${composerReserve}px`,
    ...(titleIconSize ? { "--new-chat-title-icon-size": titleIconSize } : {}),
    ...(titleIconGap ? { "--new-chat-title-icon-gap": titleIconGap } : {}),
    ...(contentGutter
      ? {
          "--new-chat-title-edge-gutter": contentGutter,
          "--conversation-content-width": `min(760px, calc(100% - ${contentGutter} - ${contentGutter}))`,
        }
      : {}),
  } as CSSProperties;

  return (
    <section
      className={styles.shell}
      data-test-class="conversation"
      style={style}
    >
      {children}
    </section>
  );
}

export function ConversationScroll({
  children,
  masked = true,
  scrollable = true,
  virtualized = false,
  scrollRef,
}: {
  children: ReactNode;
  masked?: boolean;
  scrollable?: boolean;
  virtualized?: boolean;
  scrollRef?: Ref<HTMLDivElement>;
}) {
  return (
    <div
      className={cn(
        styles.scroll,
        !masked && styles.unmaskedScroll,
        !scrollable && styles.lockedScroll,
        virtualized && styles.virtualScroll,
      )}
      data-test-class={`conversation-scroll${virtualized ? " message-virtual-scroll" : ""}`}
      ref={scrollRef}
    >
      {children}
    </div>
  );
}

export function MessageListSurface({
  children,
  height,
}: {
  children: ReactNode;
  height?: number;
}) {
  return (
    <div
      className={cn(
        styles.messageList,
        height && styles.virtualizedMessageList,
      )}
      data-test-class={`message-list${height ? " virtualized" : ""}`}
      style={height ? { height: `${height}px` } : undefined}
    >
      {children}
    </div>
  );
}
