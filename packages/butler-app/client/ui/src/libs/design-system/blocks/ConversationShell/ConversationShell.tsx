import { useState, type CSSProperties, type ReactNode, type Ref } from "react";
import { cn } from "../../lib/utils";
import { useComposedRefs } from "../../lib/composeRefs";
import { useScrollEdges } from "../../lib/useScrollEdges";
import { publishScrollbarWidth } from "../../lib/scrollbarWidth";
import { AsideSlot, hasAsideContent, type AsideContent } from "../../lib/AsideSlot";
import { useAsideLayout } from "../../lib/asideLayout";
import styles from "./ConversationShell.module.css";
import { ConversationShellElementContext, useConversationColumnRect, type ConversationColumnRect } from "./conversationColumn";
import { ConversationAsideDockedContext, CONVERSATION_ASIDE_DOCK_MIN, shownAside } from "./conversationAside";
import { ConversationRailSlot, useShellRail } from "./conversationRail";
import { ConversationColumnGlide } from "./ConversationColumnGlide";

export type { ConversationColumnRect } from "./conversationColumn";
export type { AsideLayout } from "../../lib/asideLayout";
export type { AsideContent } from "../../lib/AsideSlot";
export { CONVERSATION_ASIDE_DOCK_MIN } from "./conversationAside";
export { ConversationScrollToBottomButton } from "./ConversationScrollToBottomButton";

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
  /**
   * Content in the right margin (session details). From a 960px shell it docks flat and sticky in the
   * margin, and the column and composer move left as far as they must; narrower, it floats on TintedGlass
   * over the conversation while `asideFloatOpen`. A function gets the layout (content drops its cards on glass).
   */
  aside?: AsideContent;
  /** Floating only: whether the aside shows. Docked, it shows whenever `aside` is set. */
  asideFloatOpen?: boolean;
  /** The aside landmark's accessible name. */
  asideLabel?: string;
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
  aside,
  asideFloatOpen = false,
  asideLabel,
}: ConversationShellProps) {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const hasRail = rail !== undefined && rail !== null && rail !== false;
  const asideLayout = useAsideLayout(element, hasAsideContent(aside), CONVERSATION_ASIDE_DOCK_MIN);
  const asideState = shownAside(hasAsideContent(aside), asideLayout, asideFloatOpen);
  const { hold: railHold, asideExited, reserved, report } = useShellRail(hasRail, railView, asideState !== undefined);
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
      <ConversationAsideDockedContext.Provider value={asideState === "docked"}>
        <section
          className={cn(styles.shell, background ? styles.withBackground : undefined, reserved ? styles.railed : undefined)}
          data-test-class="conversation"
          data-rail={reserved ? "reserved" : undefined}
          data-aside={asideState}
          ref={setElement}
          style={style}
        >
          {background ? (
            <div aria-hidden="true" className={styles.background} data-slot="conversation-background">
              {background}
            </div>
          ) : null}
          {children}
          <ConversationColumnGlide shell={element} docked={asideState === "docked"} railed={reserved} />
          {hasRail ? <ConversationRailSlot hold={railHold} report={report}>{rail}</ConversationRailSlot> : null}
          <AsideSlot aside={aside} layout={asideLayout} floatOpen={asideFloatOpen} slot="conversation-aside" label={asideLabel}
            className={styles.aside} glassClassName={styles.asideGlass} onExitComplete={asideExited} />
        </section>
      </ConversationAsideDockedContext.Provider>
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
  const ref = useComposedRefs(scrollRef, useScrollEdges("y", masked), publishScrollbarWidth);
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
      <div className={styles.scrollContent}>{children}</div>
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
  /** The column's edges (a docked aside included) and the conversation's top, on mount and every resize (never on scroll): a background's keep-out. */
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
      data-column-glide=""
      ref={setColumn}
      style={height ? { height: `${height}px` } : undefined}
    >
      {children}
    </div>
  );
}
