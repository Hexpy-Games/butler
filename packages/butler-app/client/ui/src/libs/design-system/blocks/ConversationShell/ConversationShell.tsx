import type { CSSProperties, ReactNode, Ref } from "react";
import { cn } from "../../lib/utils";
import { useComposedRefs } from "../../lib/composeRefs";
import { useScrollEdges } from "../../lib/useScrollEdges";
import { ChevronDownIcon } from "../../components/Icons";
import { PillButton } from "../../components/PillButton";
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
          "--conversation-shell-content-gutter": contentGutter,
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
  const edgesRef = useScrollEdges("y", masked);
  const ref = useComposedRefs(scrollRef, edgesRef);
  return (
    <div
      className={cn(
        styles.scroll,
        !scrollable && styles.lockedScroll,
        virtualized && styles.virtualScroll,
      )}
      data-test-class={`conversation-scroll${virtualized ? " message-virtual-scroll" : ""}`}
      ref={ref}
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

export function ConversationScrollToBottomButton({
  ariaLabel,
  children,
  hasUnreadMessages,
  onScrollToBottom,
}: {
  ariaLabel: string;
  children?: ReactNode;
  hasUnreadMessages: boolean;
  onScrollToBottom: () => void;
}) {
  return (
    <PillButton
      aria-label={ariaLabel}
      className={styles.scrollToBottomButton}
      surface="glass"
      data-test-class="scroll-to-bottom-button"
      data-unread-messages={hasUnreadMessages ? "true" : "false"}
      icon={<ChevronDownIcon size={16} />}
      onClick={onScrollToBottom}
    >
      {children}
    </PillButton>
  );
}
