import { useRef, type CSSProperties, type HTMLAttributes, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import type { DsBaseProps } from "../../lib/dsProps";
import { cn } from "../../lib/utils";
import { BROWSER_CHAT_WIDTH, clampBrowserChatWidth } from "./conversationFrame";
import styles from "./AdaptiveShellFrame.module.css";

export interface AdaptiveShellSplitProps extends Omit<DsBaseProps<HTMLAttributes<HTMLDivElement>>, "children"> {
  /** The conversation column (left). It is its own `workspace` container, so it lays out at its width. */
  chat: ReactNode;
  /** The browser pane (right); shown only while `paneOpen`. */
  pane?: ReactNode;
  paneOpen: boolean;
  /** Chat column width in px while the pane is open (340–560, default 400). */
  chatWidth?: number;
  /** Drag or keyboard resize of the chat column; already clamped. Omit to lock the width. */
  onChatWidthChange?: (width: number) => void;
  /** Accessible name of the resize handle ("Resize conversation"). */
  resizeLabel?: string;
}

const KEY_STEP = 16;

/**
 * The conversation frame's split slot inside AdaptiveShellWorkspace (below the titlebar): chat | browser
 * pane, the chat column resizable between 340 and 560px. Pass `splitOpen` to AdaptiveShell while the
 * pane is open: the inspector then stays closed (the two never show together).
 */
export function AdaptiveShellSplit({
  chat, pane, paneOpen, chatWidth = BROWSER_CHAT_WIDTH.default, onChatWidthChange, resizeLabel = "Resize conversation",
  className, style, ...props
}: AdaptiveShellSplitProps) {
  const width = clampBrowserChatWidth(chatWidth);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const resize = (next: number) => onChatWidthChange?.(clampBrowserChatWidth(next));
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? KEY_STEP * 3 : KEY_STEP;
    const next = { ArrowLeft: width - step, ArrowRight: width + step, Home: BROWSER_CHAT_WIDTH.min, End: BROWSER_CHAT_WIDTH.max }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    resize(next);
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, width };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current) resize(drag.current.width + event.clientX - drag.current.x);
  };
  const onPointerEnd = () => { drag.current = null; };
  return (
    <div {...props} className={cn(styles.split, className)} data-slot="adaptive-shell-split" data-pane-open={paneOpen || undefined}
      style={{ ...style, "--browser-chat-width": `${width}px` } as CSSProperties}>
      <div className={styles.chat} data-slot="adaptive-shell-split-chat">{chat}</div>
      {paneOpen ? (
        <>
          <div className={styles.splitHandle} role="separator" aria-orientation="vertical" aria-label={resizeLabel}
            aria-valuemin={BROWSER_CHAT_WIDTH.min} aria-valuemax={BROWSER_CHAT_WIDTH.max} aria-valuenow={width}
            tabIndex={onChatWidthChange ? 0 : -1} data-locked={onChatWidthChange ? undefined : true}
            onKeyDown={onChatWidthChange ? onKeyDown : undefined} onPointerDown={onChatWidthChange ? onPointerDown : undefined}
            onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd} />
          <div className={styles.pane} data-slot="adaptive-shell-split-pane">{pane}</div>
        </>
      ) : null}
    </div>
  );
}

/**
 * The left-edge hover zone of a collapsed sidebar: entering it asks for a peek (AdaptiveShell `leftPeek`).
 * Render it only while the sidebar is closed; the product ends the peek when the pointer leaves the sidebar.
 */
export function AdaptiveShellPeekEdge({ onPeek }: { onPeek: () => void }) {
  return <div className={styles.peekEdge} data-slot="adaptive-shell-peek-edge" aria-hidden="true" onPointerEnter={onPeek} />;
}
