import { useState, type CSSProperties, type ReactNode, type Ref } from "react";
import { cn } from "../../lib/utils";
import { useComposedRefs } from "../../lib/composeRefs";
import { useScrollEdges } from "../../lib/useScrollEdges";
import { ChevronDownIcon } from "../../components/Icons";
import { PillButton } from "../../components/PillButton";
import styles from "./ConversationShell.module.css";
import { dsClass } from "../../lib/internal";
import { ConversationShellElementContext, useConversationColumnRect, type ConversationColumnRect } from "./conversationColumn";
import { ConversationRailContext, useRailReserve } from "./conversationRail";

export type { ConversationColumnRect } from "./conversationColumn";

export interface ConversationShellProps {
  children: ReactNode;
  composerReserve: number;
  contentGutter?: string;
  titleIconGap?: string;
  titleIconSize?: string;
  /**
   * A layer behind everything in the shell (e.g. one `Wallpaper` shared by
   * the new chat and its messages): over the shell's background, clipped to
   * it, never takes pointer input. It stays mounted while the content swaps.
   */
  background?: ReactNode;
  /** A `TabRail`: the column and composer move left only as far as needed; a shelf pushes the messages down. */
  rail?: ReactNode;
  /** The rail's view (conversation id): room made for the first tab stays for the whole view. */
  railView?: string;
}

export function ConversationShell({
  children,
  composerReserve,
  contentGutter,
  titleIconGap,
  titleIconSize,
  background,
  rail,
  railView,
}: ConversationShellProps) {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const hasRail = rail !== undefined && rail !== null && rail !== false;
  const { reserved, report } = useRailReserve(hasRail, railView);
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
    <ConversationShellElementContext.Provider value={element}>
      <section
        className={cn(styles.shell, background ? styles.withBackground : undefined, reserved ? styles.railed : undefined)}
        data-test-class="conversation"
        data-rail={reserved ? "reserved" : undefined}
        ref={setElement}
        style={style}
      >
        {background ? (
          <div aria-hidden="true" className={styles.background} data-slot="conversation-background">
            {background}
          </div>
        ) : null}
        {children}
        {hasRail ? <ConversationRailContext.Provider value={report}>{rail}</ConversationRailContext.Provider> : null}
      </section>
    </ConversationShellElementContext.Provider>
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
  onColumnRect,
}: {
  children: ReactNode;
  height?: number;
  /** The column's edges and the conversation's top, on mount and on every resize (never on scroll): a background's keep-out. */
  onColumnRect?: (rect: ConversationColumnRect) => void;
}) {
  const [column, setColumn] = useState<HTMLDivElement | null>(null);
  useConversationColumnRect(column, onColumnRect);
  return (
    <div
      className={cn(
        styles.messageList,
        height && styles.virtualizedMessageList,
      )}
      data-test-class={`message-list${height ? " virtualized" : ""}`}
      ref={setColumn}
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
      className={dsClass(styles.scrollToBottomButton)}
      surface="glass"
      data-test-class="scroll-to-bottom-button"
      data-unread-messages={hasUnreadMessages ? "true" : "false"}
      icon={<ChevronDownIcon size="md" />}
      onClick={onScrollToBottom}
    >
      {children}
    </PillButton>
  );
}
